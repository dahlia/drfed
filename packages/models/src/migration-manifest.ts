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
import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Immutable identity of one raw SQL migration. */
export interface MigrationIdentity {
  readonly name: string;
  readonly sha256: string;
}

/** Versioned, chronological migration identities bundled with the package. */
export interface MigrationManifest {
  readonly formatVersion: 1;
  readonly migrations: readonly MigrationIdentity[];
}

/** Paths override the installed package defaults, for tooling and fixtures. */
export interface MigrationManifestPaths {
  readonly manifestPath?: string;
  readonly migrationsFolder?: string;
}

/**
 * Parse a migration directory's UTC timestamp, rejecting invalid dates.
 * @returns The timestamp in milliseconds since the Unix epoch.
 */
export function migrationTimestamp(name: string): number {
  if (!/^\d{14}_[a-zA-Z0-9_-]+$/u.test(name)) {
    throw new Error("Invalid migration directory name.");
  }
  const stamp = name.slice(0, 14);
  const iso = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}.000Z`;
  const timestamp = Date.parse(iso);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== iso
  ) {
    throw new Error("Invalid migration UTC timestamp.");
  }
  return timestamp;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Validate the manifest format and strictly increasing migration timestamps.
 * @returns A validated manifest, independent of the caller's object.
 */
export function parseMigrationManifest(value: unknown): MigrationManifest {
  if (
    !record(value) ||
    value.formatVersion !== 1 ||
    Object.keys(value).sort().join(",") !== "formatVersion,migrations" ||
    !Array.isArray(value.migrations)
  ) {
    throw new Error("Unsupported migration manifest format.");
  }
  let previous = -Infinity;
  const migrations: MigrationIdentity[] = [];
  for (const entry of value.migrations) {
    if (
      !record(entry) ||
      Object.keys(entry).sort().join(",") !== "name,sha256" ||
      typeof entry.name !== "string" ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256)
    ) {
      throw new Error("Invalid migration manifest entry.");
    }
    const timestamp = migrationTimestamp(entry.name);
    if (timestamp <= previous) {
      throw new Error("Migration timestamps must be unique and increasing.");
    }
    previous = timestamp;
    migrations.push({ name: entry.name, sha256: entry.sha256 });
  }
  return { formatVersion: 1, migrations };
}

/**
 * Ensure a newer manifest preserves every baseline entry as an exact prefix.
 * @returns Nothing; throws if historical migrations were rewritten or removed.
 */
export function assertMigrationManifestPrefix(
  baseline: MigrationManifest,
  current: MigrationManifest,
): void {
  const old = parseMigrationManifest(baseline);
  const next = parseMigrationManifest(current);
  if (
    old.migrations.some(
      (entry, index) =>
        next.migrations[index]?.name !== entry.name ||
        next.migrations[index]?.sha256 !== entry.sha256,
    )
  ) {
    throw new Error("Historical migration identities must remain unchanged.");
  }
}

/**
 * Load and verify raw SQL identities without opening a database or executing SQL.
 * @returns The validated manifest after all bundled SQL files match it.
 */
export async function verifyMigrationManifest(
  paths: MigrationManifestPaths = {},
): Promise<MigrationManifest> {
  const manifestPath =
    paths.manifestPath ??
    fileURLToPath(new URL("./migrations-manifest.json", import.meta.url));
  const migrationsFolder =
    paths.migrationsFolder ??
    fileURLToPath(new URL("../drizzle/", import.meta.url));
  const manifest = parseMigrationManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  const directories = await readdir(migrationsFolder, { withFileTypes: true });
  const names = directories
    .map((entry) => {
      if (!entry.isDirectory()) {
        throw new Error("Unexpected entry in the migrations directory.");
      }
      migrationTimestamp(entry.name);
      return entry.name;
    })
    .sort();
  if (
    names.length !== manifest.migrations.length ||
    names.some((name, index) => name !== manifest.migrations[index]?.name)
  ) {
    throw new Error("Bundled migration directories do not match the manifest.");
  }
  await Promise.all(
    manifest.migrations.map(async (entry) => {
      const sql = join(migrationsFolder, entry.name, "migration.sql");
      if (!(await lstat(sql)).isFile()) {
        throw new Error("Migration SQL must be a regular file.");
      }
      const hash = createHash("sha256")
        .update(await readFile(sql))
        .digest("hex");
      if (hash !== entry.sha256) {
        throw new Error(`Migration SQL checksum mismatch: ${entry.name}`);
      }
    }),
  );
  return manifest;
}
