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
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import {
  assertMigrationManifestPrefix,
  migrationTimestamp,
  parseMigrationManifest,
  verifyMigrationManifest,
} from "@drfed/models/migration-manifest";

const first = { name: "20260101000000_first", sha256: "a".repeat(64) };
const second = { name: "20260102000000_next-step", sha256: "b".repeat(64) };
const manifest = (migrations: readonly unknown[]) => ({
  formatVersion: 1,
  migrations,
});

it("validates exact format, UTC dates and chronological identities", () => {
  assert.equal(migrationTimestamp(first.name), Date.UTC(2026, 0, 1));
  assert.deepEqual(
    parseMigrationManifest(manifest([first, second])),
    manifest([first, second]),
  );
  for (const name of [
    "../migration",
    "20260230000000_bad",
    "20260101240000_bad",
    "20260101000000_",
    "20260101000000_bad.sql",
  ]) {
    assert.throws(() => migrationTimestamp(name));
  }
  for (const value of [
    null,
    { ...manifest([]), formatVersion: 2 },
    { ...manifest([]), extra: true },
    manifest([second, first]),
    manifest([first, first]),
    manifest([first, { ...second, name: "20260101000000_other" }]),
    manifest([{ ...first, sha256: "A".repeat(64) }]),
    manifest([{ ...first, extra: true }]),
  ]) {
    assert.throws(() => parseMigrationManifest(value));
  }
});

it("permits append-only upgrades and rejects rewritten or removed history", () => {
  const baseline = parseMigrationManifest(manifest([first]));
  assertMigrationManifestPrefix(
    baseline,
    parseMigrationManifest(manifest([first, second])),
  );
  for (const entries of [[], [second], [{ ...first, sha256: second.sha256 }]]) {
    assert.throws(() =>
      assertMigrationManifestPrefix(
        baseline,
        parseMigrationManifest(manifest(entries)),
      ),
    );
  }
});

it("verifies the installed manifest independently of the working directory", async () => {
  const installed = await verifyMigrationManifest();
  assert.ok(installed.migrations.length >= 20);
});

it("detects changed, absent and unlisted raw SQL without executing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "drfed-manifest-"));
  try {
    const migrationsFolder = join(root, "drizzle");
    const directory = join(migrationsFolder, first.name);
    const sql = join(directory, "migration.sql");
    const manifestPath = join(root, "manifest.json");
    await mkdir(directory, { recursive: true });
    const bytes = "SELECT 'secret SQL';\r\n";
    const entry = {
      ...first,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    await writeFile(sql, bytes);
    await writeFile(manifestPath, JSON.stringify(manifest([entry])));
    const paths = { manifestPath, migrationsFolder };
    assert.deepEqual(await verifyMigrationManifest(paths), manifest([entry]));
    await writeFile(sql, bytes.replace("\r\n", "\n"));
    await assert.rejects(
      verifyMigrationManifest(paths),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("checksum mismatch") &&
        !error.message.includes("secret SQL"),
    );
    await rm(sql);
    await assert.rejects(verifyMigrationManifest(paths));
    await writeFile(sql, bytes);
    await mkdir(join(migrationsFolder, second.name));
    await assert.rejects(
      verifyMigrationManifest(paths),
      /directories do not match/u,
    );
    await rm(join(migrationsFolder, second.name), { recursive: true });
    await writeFile(join(migrationsFolder, "unexpected.sql"), bytes);
    await assert.rejects(verifyMigrationManifest(paths), /Unexpected entry/u);
    await rm(join(migrationsFolder, "unexpected.sql"));
    await rm(sql);
    // Windows symlinks may require privileges; regular-file checks apply everywhere.
    if (process.platform !== "win32") {
      const target = join(root, "outside.sql");
      await writeFile(target, bytes);
      await symlink(target, sql);
      await assert.rejects(verifyMigrationManifest(paths), /regular file/u);
      await rm(sql);
      await rm(directory, { recursive: true });
      await symlink(root, directory);
      await assert.rejects(verifyMigrationManifest(paths), /Unexpected entry/u);
    }
    assert.ok((await readFile(manifestPath, "utf8")).includes(entry.sha256));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
