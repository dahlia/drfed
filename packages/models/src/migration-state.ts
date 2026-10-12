// DrFed: A web-based platform for developing and debugging ActivityPub apps
// Copyright (C) 2026 DrFed team
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.
import { Buffer } from "node:buffer";

import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

import {
  type MigrationIdentity,
  type MigrationManifest,
  migrationTimestamp,
  parseMigrationManifest,
  verifyMigrationManifest,
} from "./migration-manifest.ts";
import * as schema from "./schema.ts";

/** A query-only client; the caller owns its connection and lifetime. */
export interface MigrationQueryClient {
  query<Row extends Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ rows: Row[] }>;
}

export type MigrationHistoryFormat = "current" | "legacy";
export type MigrationStatus =
  | "ready"
  | "pending"
  | "uninitialized"
  | "upgrade-required"
  | "modified"
  | "newer"
  | "diverged"
  | "untracked-schema"
  | "unsupported-format";

/** Only ready permits startup without applying or upgrading migrations. */
export interface MigrationState {
  readonly status: MigrationStatus;
  readonly format: MigrationHistoryFormat | null;
  readonly applied: number;
  readonly pending: readonly MigrationIdentity[];
}

export interface InspectMigrationStateOptions {
  readonly migrationsSchema?: string;
  readonly migrationsTable?: string;
  /** A trusted explicit identity set; otherwise verify the installed SQL. */
  readonly manifest?: MigrationManifest;
}

function integer(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "bigint" ||
          (typeof value === "string" && /^\d+$/u.test(value))
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function historyIdentity(
  row: Record<string, unknown>,
  format: MigrationHistoryFormat,
): { id: number; date: number; hash: string; name: unknown } | undefined {
  const id = integer(row.id);
  const rawDate = integer(row.created_at);
  if (
    id === undefined ||
    rawDate === undefined ||
    typeof row.hash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(row.hash)
  ) {
    return undefined;
  }
  // Drizzle marks metadata-upgraded legacy rows with applied_at SQL NULL.
  const legacyDate = format === "legacy" || row.applied_at === null;
  const date = legacyDate ? Math.floor(rawDate / 1000) * 1000 : rawDate;
  if (format === "current") {
    if (typeof row.name !== "string") {
      return undefined;
    }
    try {
      if (migrationTimestamp(row.name) !== date) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  return { id, date, hash: row.hash, name: row.name };
}

/**
 * Compare ordered raw history rows with the immutable manifest, without SQL.
 * Legacy and metadata-upgraded legacy dates may retain generation milliseconds.
 * Both second and hash
 * must match the corresponding prefix entry before metadata can be upgraded.
 * @returns The compatibility state; invalid histories never list pending SQL.
 */
export function classifyMigrationHistory(
  manifest: MigrationManifest,
  rows: readonly Record<string, unknown>[],
  format: MigrationHistoryFormat,
): MigrationState {
  const identities = parseMigrationManifest(manifest).migrations;
  const incompatible = (status: MigrationStatus): MigrationState => ({
    status,
    format,
    applied: 0,
    pending: [],
  });
  let previousId = 0;
  let previousDate = -1;
  let newer = false;
  for (const [index, row] of rows.entries()) {
    const identity = historyIdentity(row, format);
    if (
      !identity ||
      identity.id <= previousId ||
      identity.date <= previousDate
    ) {
      return incompatible("diverged");
    }
    const { id, date, hash, name } = identity;
    previousId = id;
    previousDate = date;
    const expected = identities[index];
    if (expected === undefined) {
      const last = identities.at(-1);
      if (last === undefined || date <= migrationTimestamp(last.name)) {
        return incompatible("diverged");
      }
      newer = true;
      continue;
    }
    if (
      date !== migrationTimestamp(expected.name) ||
      (format === "current" && name !== expected.name)
    ) {
      return incompatible("diverged");
    }
    if (hash !== expected.sha256) {
      return incompatible("modified");
    }
  }
  if (newer) {
    return incompatible("newer");
  }
  return {
    status:
      format === "legacy"
        ? "upgrade-required"
        : rows.length === 0
          ? "uninitialized"
          : rows.length === identities.length
            ? "ready"
            : "pending",
    format,
    applied: rows.length,
    pending: identities.slice(rows.length),
  };
}

function identifier(value: string): string {
  if (
    value === "" ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > 63
  ) {
    throw new Error("Invalid migration history identifier.");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

// Retired names still identify a partially removed historical DrFed schema.
const businessTables = [
  ...Object.values(schema)
    .filter((value) => is(value, PgTable))
    .map((table) => {
      const config = getTableConfig(table);
      return { name: config.name, schema: config.schema ?? "public" };
    }),
  { name: "login_tokens", schema: "public" },
  { name: "remote_instances", schema: "public" },
];

async function hasBusinessTables(
  client: MigrationQueryClient,
): Promise<boolean> {
  const namespaces = [...new Set(businessTables.map((table) => table.schema))];
  const results = await Promise.all(
    namespaces.map((namespace) => {
      const names = businessTables
        .filter((table) => table.schema === namespace)
        .map((table) => table.name);
      return client.query(
        `SELECT c.relname FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relname = ANY($2::text[])`,
        [namespace, names],
      );
    }),
  );
  return results.some((result) => result.rows.length > 0);
}

/**
 * Inspect migration catalogs and history using SELECT statements only.
 * Missing/empty history with DrFed tables fails closed; metadata and permission
 * errors propagate instead of being mistaken for an empty database.
 * @returns A compatibility state without modifying the database or the client.
 */
export async function inspectMigrationState(
  client: MigrationQueryClient,
  options: InspectMigrationStateOptions = {},
): Promise<MigrationState> {
  const manifest =
    options.manifest === undefined
      ? await verifyMigrationManifest()
      : parseMigrationManifest(options.manifest);
  const namespace = options.migrationsSchema ?? "drizzle";
  const table = options.migrationsTable ?? "__drizzle_migrations";
  const qualified = `${identifier(namespace)}.${identifier(table)}`;
  const relation = await client.query(
    `SELECT c.oid::text AS oid, c.relkind,
    CASE WHEN c.relkind IN ('r', 'p') THEN pg_catalog.row_security_active(c.oid)
      ELSE false END AS row_security_active
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2`,
    [namespace, table],
  );
  const missing = async (): Promise<MigrationState> => {
    const untracked = await hasBusinessTables(client);
    return {
      status: untracked ? "untracked-schema" : "uninitialized",
      format: null,
      applied: 0,
      pending: untracked ? [] : manifest.migrations,
    };
  };
  if (relation.rows.length === 0) {
    return missing();
  }
  const record = relation.rows[0];
  const unsupported = (): MigrationState => ({
    status: "unsupported-format",
    format: null,
    applied: 0,
    pending: [],
  });
  if (
    relation.rows.length !== 1 ||
    !record ||
    record.row_security_active !== false ||
    !["r", "p"].includes(String(record.relkind))
  ) {
    return unsupported();
  }
  const columns = await client.query(
    `SELECT a.attname, a.atttypid::text AS type
    FROM pg_catalog.pg_attribute a WHERE a.attrelid = $1::oid
    AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    [record.oid],
  );
  const actual = columns.rows
    .map((column) => `${column.attname}:${column.type}`)
    .sort()
    .join(",");
  const legacy = "created_at:20,hash:25,id:23";
  const current = "applied_at:1184,created_at:20,hash:25,id:23,name:25";
  const format =
    actual === current ? "current" : actual === legacy ? "legacy" : undefined;
  if (format === undefined) {
    return unsupported();
  }
  const result =
    await client.query(`SELECT id, hash, created_at${format === "current" ? ", name, applied_at" : ""}
    FROM ${qualified} ORDER BY created_at, id`);
  if (result.rows.length === 0 && (await hasBusinessTables(client))) {
    return { status: "untracked-schema", format, applied: 0, pending: [] };
  }
  return classifyMigrationHistory(manifest, result.rows, format);
}
