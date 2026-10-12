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
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import {
  migrationTimestamp,
  verifyMigrationManifest,
} from "@drfed/models/migration-manifest";
import { MigrationPreparationError } from "@drfed/models/migration-session";
import { inspectMigrationState } from "@drfed/models/migration-state";
import { preparePgliteDatabase } from "@drfed/models/pglite-preparation";
import {
  type PersistentPgliteStore,
  openPersistentPglite,
} from "@drfed/models/pglite-store";

function failure(code: string, status?: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof MigrationPreparationError &&
    error.code === code &&
    (status === undefined || error.state?.status === status);
}

async function withStore(
  run: (store: PersistentPgliteStore, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "drfed-pglite-preparation-"));
  const store = await openPersistentPglite(join(directory, "data"));
  try {
    await store.ready;
    await run(store, directory);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function fixture(directory: string, sql: string) {
  const name = "20260101000000_preparation_probe";
  const migrationsFolder = join(directory, "drizzle");
  await mkdir(join(migrationsFolder, name), { recursive: true });
  const sqlPath = join(migrationsFolder, name, "migration.sql");
  await writeFile(sqlPath, sql);
  const manifestPath = join(directory, "manifest.json");
  const sha256 = createHash("sha256").update(sql).digest("hex");
  await writeFile(
    manifestPath,
    JSON.stringify({ formatVersion: 1, migrations: [{ name, sha256 }] }),
  );
  return { migrationsFolder, manifestPath, name, sha256, sqlPath };
}

it("prepares all installed PGlite SQL, serializes shared preparers and preserves ownership", async () => {
  await withStore(async (store) => {
    const [first, second] = await Promise.all([
      preparePgliteDatabase({ store }),
      preparePgliteDatabase({ store }),
    ]);
    const count = (await verifyMigrationManifest()).migrations.length;
    assert.equal(first.status, "ready");
    assert.equal(second.applied, count);
    assert.deepEqual(
      (
        await store.client.query(
          "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
        )
      ).rows,
      [{ count }],
    );
    await assert.rejects(
      openPersistentPglite(store.dataPath),
      (error) =>
        error instanceof Error && "code" in error && error.code === "locked",
    );
    assert.equal((await preparePgliteDatabase({ store })).status, "ready");
  });
});

it("upgrades exact legacy milliseconds without reapplying SQL or replacing history timestamps", async () => {
  await withStore(async (store, directory) => {
    const sql = "CREATE TABLE legacy_probe (value text);";
    const paths = await fixture(directory, sql);
    const date = migrationTimestamp(paths.name) + 321;
    await store.client.exec(
      `${sql}CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);`,
    );
    await store.client.query(
      "INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES($1,$2)",
      [paths.sha256, date],
    );
    assert.equal(
      (await preparePgliteDatabase({ store, ...paths })).status,
      "ready",
    );
    const result = await store.client.query(
      "SELECT created_at::text AS date, name, applied_at FROM drizzle.__drizzle_migrations",
    );
    assert.deepEqual(result.rows, [
      { date: String(date), name: paths.name, applied_at: null },
    ]);
  });
});

it("rejects modified legacy history before any metadata upgrade", async () => {
  await withStore(async (store, directory) => {
    const paths = await fixture(
      directory,
      "CREATE TABLE approved_probe (value text);",
    );
    await store.client.exec(
      "CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);",
    );
    await store.client.query(
      "INSERT INTO drizzle.__drizzle_migrations(hash, created_at) VALUES($1,$2)",
      ["0".repeat(64), migrationTimestamp(paths.name)],
    );
    await assert.rejects(
      preparePgliteDatabase({ store, ...paths }),
      failure("incompatible-history", "modified"),
    );
    assert.deepEqual(
      (
        await store.client.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema='drizzle' AND table_name='__drizzle_migrations' ORDER BY ordinal_position",
        )
      ).rows,
      [
        { column_name: "id" },
        { column_name: "hash" },
        { column_name: "created_at" },
      ],
    );
    assert.deepEqual(
      (
        await store.client.query(
          "SELECT to_regclass('approved_probe') AS business",
        )
      ).rows,
      [{ business: null }],
    );
  });
});

it("refuses newer and divergent histories without applying package SQL", async () => {
  await withStore(async (store, directory) => {
    const paths = await fixture(
      directory,
      "CREATE TABLE approved_probe (value text);",
    );
    await preparePgliteDatabase({ store, ...paths });
    const newer = "20260102000000_newer_probe";
    await store.client.query(
      "INSERT INTO drizzle.__drizzle_migrations(hash, created_at, name) VALUES($1,$2,$3)",
      ["1".repeat(64), migrationTimestamp(newer), newer],
    );
    await assert.rejects(
      preparePgliteDatabase({ store, ...paths }),
      failure("incompatible-history", "newer"),
    );
    await store.client.query(
      "UPDATE drizzle.__drizzle_migrations SET name='20260101000000_changed_probe' WHERE id=1",
    );
    await assert.rejects(
      preparePgliteDatabase({ store, ...paths }),
      failure("incompatible-history", "diverged"),
    );
    assert.deepEqual(
      (
        await store.client.query(
          "SELECT count(*)::integer AS count FROM drizzle.__drizzle_migrations",
        )
      ).rows,
      [{ count: 2 }],
    );
  });
});

it("rejects untracked DrFed tables before creating migration metadata", async () => {
  await withStore(async (store) => {
    await store.client.exec("CREATE TABLE accounts(marker text)");
    await assert.rejects(
      preparePgliteDatabase({ store }),
      failure("incompatible-history", "untracked-schema"),
    );
    assert.deepEqual(
      (await store.client.query("SELECT to_regnamespace('drizzle') AS history"))
        .rows,
      [{ history: null }],
    );
  });
});

it("leaves the owner usable after file failure, pre-abort and a later queued preparation", async () => {
  await withStore(async (store, directory) => {
    await assert.rejects(
      preparePgliteDatabase({
        store,
        signal: AbortSignal.abort("PRIVATE_REASON"),
      }),
      failure("aborted"),
    );
    assert.equal(
      (await inspectMigrationState(store.client)).status,
      "uninitialized",
    );
    const first = preparePgliteDatabase({
      store,
      manifestPath: join(directory, "missing.json"),
    });
    const second = preparePgliteDatabase({ store });
    await assert.rejects(first, failure("invalid-migration-files"));
    assert.equal((await second).status, "ready");
    await assert.rejects(
      preparePgliteDatabase({
        store,
        signal: AbortSignal.abort("PRIVATE_REASON"),
      }),
      failure("aborted"),
    );
    assert.equal((await inspectMigrationState(store.client)).status, "ready");
  });
});

it("rolls back invalid SQL and omits raw statements from migration failures", async () => {
  await withStore(async (store, directory) => {
    const paths = await fixture(
      directory,
      "CREATE TABLE rollback_probe (value text);\n--> statement-breakpoint\nSELECT PRIVATE_SQL_FAILURE;",
    );
    await assert.rejects(
      preparePgliteDatabase({ store, ...paths }),
      (error) => {
        assert.ok(error instanceof MigrationPreparationError);
        assert.equal(error.code, "migration-failed");
        assert.doesNotMatch(error.stack ?? "", /PRIVATE_SQL_FAILURE/u);
        assert.equal("cause" in error, false);
        return true;
      },
    );
    assert.deepEqual(
      (
        await store.client.query(
          "SELECT to_regclass('rollback_probe') AS business",
        )
      ).rows,
      [{ business: null }],
    );
    assert.equal(
      (await readFile(paths.sqlPath, "utf8")).includes("PRIVATE_SQL_FAILURE"),
      true,
    );
  });
});

it("applies only an exact pending suffix on a persistent prepared store", async () => {
  await withStore(async (store, directory) => {
    const paths = await fixture(
      directory,
      "CREATE TABLE first_probe (value text);",
    );
    await preparePgliteDatabase({ store, ...paths });
    const name = "20260102000000_pending_probe";
    const sql = "CREATE TABLE pending_probe (value text);";
    const sha256 = createHash("sha256").update(sql).digest("hex");
    await mkdir(join(paths.migrationsFolder, name));
    await writeFile(join(paths.migrationsFolder, name, "migration.sql"), sql);
    await writeFile(
      paths.manifestPath,
      JSON.stringify({
        formatVersion: 1,
        migrations: [
          { name: paths.name, sha256: paths.sha256 },
          { name, sha256 },
        ],
      }),
    );
    const manifest = await verifyMigrationManifest(paths);
    const pending = await inspectMigrationState(store.client, { manifest });
    assert.equal(pending.status, "pending");
    assert.equal(pending.applied, 1);
    assert.deepEqual(pending.pending, [{ name, sha256 }]);
    assert.equal((await preparePgliteDatabase({ store, ...paths })).applied, 2);
    assert.deepEqual(
      (
        await store.client.query(
          "SELECT to_regclass('pending_probe')::text AS business",
        )
      ).rows,
      [{ business: "pending_probe" }],
    );
  });
});
