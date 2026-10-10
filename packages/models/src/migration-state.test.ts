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
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

import { migrate } from "@drfed/models/migrate";
import { verifyMigrationManifest } from "@drfed/models/migration-manifest";
import {
  type MigrationQueryClient,
  classifyMigrationHistory,
  inspectMigrationState,
} from "@drfed/models/migration-state";
import { PGlite } from "@electric-sql/pglite";

const identities = [
  { name: "20260101000000_first", sha256: "a".repeat(64) },
  { name: "20260102000000_second", sha256: "b".repeat(64) },
  { name: "20260103000000_third", sha256: "c".repeat(64) },
];
const manifest = { formatVersion: 1 as const, migrations: identities };
const rows = identities.map((entry, index) => ({
  id: index + 1,
  name: entry.name,
  hash: entry.sha256,
  created_at: Date.UTC(2026, 0, index + 1),
}));

it("only an exact named history is ready, while an exact prefix is pending", () => {
  assert.equal(
    classifyMigrationHistory(manifest, rows, "current").status,
    "ready",
  );
  assert.deepEqual(
    classifyMigrationHistory(manifest, rows.slice(0, 1), "current"),
    {
      status: "pending",
      format: "current",
      applied: 1,
      pending: identities.slice(1),
    },
  );
  assert.equal(
    classifyMigrationHistory(manifest, [], "current").status,
    "uninitialized",
  );
  const textual = rows.map((row) => ({
    ...row,
    id: String(row.id),
    created_at: BigInt(row.created_at),
  }));
  assert.equal(
    classifyMigrationHistory(manifest, textual, "current").status,
    "ready",
  );
});

it("rejects modified, missing, duplicate, misordered and malformed history", () => {
  const classify = (entries: readonly Record<string, unknown>[]) =>
    classifyMigrationHistory(manifest, entries, "current");
  assert.equal(
    classify([{ ...rows[0], hash: "d".repeat(64) }]).status,
    "modified",
  );
  for (const entries of [
    [rows[0]!, rows[2]!],
    [rows[0]!, rows[0]!],
    [rows[1]!],
    [rows[0]!, { ...rows[1], id: 1 }],
    [rows[0]!, { ...rows[1], id: 0 }],
    [{ ...rows[0], created_at: Date.UTC(2026, 0, 1) + 1 }],
    [{ ...rows[0], name: "invalid" }],
    [{ ...rows[0], name: null }],
    [{ ...rows[0], id: "9007199254740993" }],
    [{ ...rows[0], id: 1.5 }],
    [{ ...rows[0], hash: null }],
    [{ ...rows[0], created_at: "NaN" }],
  ]) {
    const state = classify(entries);
    assert.equal(state.status, "diverged");
    assert.deepEqual(state.pending, []);
  }
});

it("recognizes a newer suffix only after the complete known prefix", () => {
  const unknown = {
    id: 4,
    name: "20260104000000_newer",
    hash: "d".repeat(64),
    created_at: Date.UTC(2026, 0, 4),
  };
  assert.equal(
    classifyMigrationHistory(manifest, [...rows, unknown], "current").status,
    "newer",
  );
  assert.equal(
    classifyMigrationHistory(manifest, [rows[0]!, unknown], "current").status,
    "diverged",
  );
  assert.equal(
    classifyMigrationHistory(manifest, [...rows, unknown, unknown], "current")
      .status,
    "diverged",
  );
});

it("validates legacy seconds, hashes and ID order before reporting an upgrade", () => {
  const legacy = rows.map(({ id, hash, created_at }) => ({
    id,
    hash,
    created_at: created_at + 123,
  }));
  assert.equal(
    classifyMigrationHistory(manifest, legacy, "legacy").status,
    "upgrade-required",
  );
  assert.equal(
    classifyMigrationHistory(manifest, legacy.slice(0, 1), "legacy").pending
      .length,
    2,
  );
  assert.equal(
    classifyMigrationHistory(
      manifest,
      [{ ...legacy[0], hash: "d".repeat(64) }],
      "legacy",
    ).status,
    "modified",
  );
  assert.equal(
    classifyMigrationHistory(
      manifest,
      [{ ...legacy[0], created_at: Date.UTC(2026, 0, 2) }],
      "legacy",
    ).status,
    "diverged",
  );
  assert.equal(
    classifyMigrationHistory(manifest, [legacy[0]!, legacy[2]!], "legacy")
      .status,
    "diverged",
  );
});

function readOnlyClient(client: PGlite): MigrationQueryClient {
  return {
    query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ): Promise<{ rows: Row[] }> {
      assert.match(sql, /^SELECT\s/iu);
      return client.query<Row>(sql, parameters);
    },
  };
}

it("inspects real PGlite fresh, migrated and untracked databases using only SELECT", async () => {
  await using client = new PGlite();
  const query = readOnlyClient(client);
  assert.equal((await inspectMigrationState(query)).status, "uninitialized");
  await migrate({ credentials: { driver: "pglite", client } });
  assert.equal((await inspectMigrationState(query)).status, "ready");
  await client.exec("DELETE FROM drizzle.__drizzle_migrations");
  assert.equal((await inspectMigrationState(query)).status, "untracked-schema");
  await client.exec("DROP TABLE drizzle.__drizzle_migrations");
  assert.equal((await inspectMigrationState(query)).status, "untracked-schema");
});

it("reads legacy metadata without upgrading it or accepting its changed hash", async () => {
  await using client = new PGlite();
  const entry = (await verifyMigrationManifest()).migrations[0]!;
  await client.exec(
    "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
  );
  // First installed migration is 2026-06-22T02:17:48Z; retain legacy generation milliseconds.
  await client.query(
    "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1,$2)",
    [entry.sha256, Date.UTC(2026, 5, 22, 2, 17, 48) + 321],
  );
  assert.equal(
    (await inspectMigrationState(readOnlyClient(client))).status,
    "upgrade-required",
  );
  const fields = await client.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema='drizzle' AND table_name='__drizzle_migrations'",
  );
  assert.equal(fields.rows.length, 3);
  await client.query("UPDATE drizzle.__drizzle_migrations SET hash=$1", [
    "d".repeat(64),
  ]);
  assert.equal(
    (await inspectMigrationState(readOnlyClient(client))).status,
    "modified",
  );
  assert.equal(
    (await client.query("SELECT * FROM drizzle.__drizzle_migrations")).rows
      .length,
    1,
  );
});

it("rejects unsupported relation and metadata formats without querying their contents", async () => {
  await using client = new PGlite();
  await client.exec(
    "CREATE SCHEMA drizzle; CREATE VIEW drizzle.__drizzle_migrations AS SELECT 1 AS id",
  );
  assert.equal(
    (await inspectMigrationState(readOnlyClient(client))).status,
    "unsupported-format",
  );
  await client.exec(
    "DROP VIEW drizzle.__drizzle_migrations; CREATE TABLE drizzle.__drizzle_migrations (id text, hash text, created_at bigint)",
  );
  assert.equal(
    (await inspectMigrationState(readOnlyClient(client))).status,
    "unsupported-format",
  );
});

it("quotes custom history identifiers and propagates metadata permission errors", async () => {
  await using client = new PGlite();
  await client.exec(
    'CREATE SCHEMA "odd""schema"; CREATE TABLE "odd""schema"."table""name" (id serial PRIMARY KEY, hash text, created_at bigint, name text, applied_at timestamptz)',
  );
  assert.equal(
    (
      await inspectMigrationState(readOnlyClient(client), {
        migrationsSchema: 'odd"schema',
        migrationsTable: 'table"name',
        manifest,
      })
    ).status,
    "uninitialized",
  );
  await Promise.all(
    ["", "\0", "x".repeat(64)].map((name) =>
      assert.rejects(
        inspectMigrationState(readOnlyClient(client), {
          migrationsSchema: name,
          manifest,
        }),
        /Invalid migration history identifier/u,
      ),
    ),
  );
  const failure = new Error("permission denied");
  const denied: MigrationQueryClient = { query: () => Promise.reject(failure) };
  await assert.rejects(
    inspectMigrationState(denied, { manifest }),
    (error: unknown) => error === failure,
  );
  const deniedHistory: MigrationQueryClient = {
    query<Row extends Record<string, unknown>>(
      sql: string,
      parameters?: unknown[],
    ): Promise<{ rows: Row[] }> {
      if (sql.includes('FROM "odd""schema"."table""name"')) {
        return Promise.reject(failure);
      }
      return client.query<Row>(sql, parameters);
    },
  };
  await assert.rejects(
    inspectMigrationState(deniedHistory, {
      migrationsSchema: 'odd"schema',
      migrationsTable: 'table"name',
      manifest,
    }),
    (error: unknown) => error === failure,
  );
});

it("fails closed when RLS hides a newer history row from the inspecting role", async () => {
  await using client = new PGlite();
  await client.exec(`CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text, created_at bigint, name text, applied_at timestamptz);
    CREATE ROLE migration_reader;
    GRANT USAGE ON SCHEMA drizzle TO migration_reader;
    GRANT SELECT ON drizzle.__drizzle_migrations TO migration_reader;`);
  const newer = {
    id: 4,
    name: "20260104000000_newer",
    hash: "d".repeat(64),
    created_at: Date.UTC(2026, 0, 4),
  };
  await Promise.all(
    [...rows, newer].map((row) =>
      client.query(
        "INSERT INTO drizzle.__drizzle_migrations (id, hash, created_at, name) VALUES ($1,$2,$3,$4)",
        [row.id, row.hash, row.created_at, row.name],
      ),
    ),
  );
  await client.exec(`ALTER TABLE drizzle.__drizzle_migrations ENABLE ROW LEVEL SECURITY;
    CREATE POLICY visible_prefix ON drizzle.__drizzle_migrations FOR SELECT TO migration_reader USING (id <= 3);`);
  assert.equal(
    (await inspectMigrationState(readOnlyClient(client), { manifest })).status,
    "newer",
  );
  await client.exec("SET ROLE migration_reader; BEGIN READ ONLY");
  try {
    assert.equal(
      (await client.query("SELECT * FROM drizzle.__drizzle_migrations")).rows
        .length,
      3,
    );
    assert.equal(
      (await inspectMigrationState(readOnlyClient(client), { manifest }))
        .status,
      "unsupported-format",
    );
  } finally {
    await client.exec("ROLLBACK; RESET ROLE");
  }
});

it("recognizes retired DrFed tables in otherwise untracked historical schemas", async () => {
  await using client = new PGlite();
  await client.exec("CREATE TABLE public.login_tokens (id integer)");
  assert.equal(
    (await inspectMigrationState(readOnlyClient(client), { manifest })).status,
    "untracked-schema",
  );
  await client.exec(
    "DROP TABLE public.login_tokens; CREATE TABLE public.remote_instances (id integer)",
  );
  assert.equal(
    (await inspectMigrationState(readOnlyClient(client), { manifest })).status,
    "untracked-schema",
  );
});

it("accepts verified generation milliseconds after the existing Drizzle metadata upgrade", async () => {
  await using client = new PGlite();
  const installed = await verifyMigrationManifest();
  const first = installed.migrations[0]!;
  await client.exec(
    "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)",
  );
  // Supply the complete first migration's schema as an existing legacy DB.
  // Applying SQL here is a fixture operation, never an inspector operation.
  const sql = await readFile(
    new URL(`../drizzle/${first.name}/migration.sql`, import.meta.url),
    "utf8",
  );
  await client.exec(sql);
  await client.query(
    "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1,$2)",
    [first.sha256, Date.UTC(2026, 5, 22, 2, 17, 48) + 321],
  );
  assert.equal(
    (await inspectMigrationState(readOnlyClient(client))).status,
    "upgrade-required",
  );
  await migrate({ credentials: { driver: "pglite", client } });
  const upgraded = await client.query<{
    created_at: number;
    applied_at: unknown;
  }>(
    "SELECT created_at, applied_at FROM drizzle.__drizzle_migrations WHERE id=1",
  );
  assert.equal(upgraded.rows[0]?.applied_at, null);
  assert.equal(
    upgraded.rows[0]?.created_at,
    Date.UTC(2026, 5, 22, 2, 17, 48) + 321,
  );
  assert.equal(
    (await inspectMigrationState(readOnlyClient(client))).status,
    "ready",
  );
  await client.query(
    "UPDATE drizzle.__drizzle_migrations SET created_at=created_at+1000 WHERE id=1",
  );
  assert.equal(
    (await inspectMigrationState(readOnlyClient(client))).status,
    "diverged",
  );
  await client.query(
    "UPDATE drizzle.__drizzle_migrations SET created_at=created_at-1000, hash=$1 WHERE id=1",
    ["d".repeat(64)],
  );
  assert.equal(
    (await inspectMigrationState(readOnlyClient(client))).status,
    "modified",
  );
});
