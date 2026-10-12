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
// Repository tooling reads source so new SQL can be registered before building.
// oxlint-disable no-console node/no-top-level-await
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  assertMigrationManifestPrefix,
  migrationTimestamp,
  parseMigrationManifest,
  verifyMigrationManifest,
} from "../packages/models/src/migration-manifest.ts";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = fileURLToPath(
  new URL("../packages/models/migrations-manifest.json", import.meta.url),
);
const migrationsFolder = fileURLToPath(
  new URL("../packages/models/drizzle/", import.meta.url),
);
const current = parseMigrationManifest(
  JSON.parse(await readFile(manifestPath, "utf8")),
);
// mise parses these flags and exposes them to the task through usage_* variables.
// oxlint-disable-next-line node/no-process-env
const base = process.env.usage_base;
if (base != null && base !== "") {
  // Resolve the commit before checking the path: invalid Git refs never mean bootstrap.
  const { stdout } = await execute(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`],
    { cwd: root },
  );
  const commit = stdout.trim();
  const path = "packages/models/migrations-manifest.json";
  const tree = await execute("git", ["ls-tree", commit, "--", path], {
    cwd: root,
  });
  if (tree.stdout.trim() !== "") {
    const baseline = await execute("git", ["show", `${commit}:${path}`], {
      cwd: root,
    });
    assertMigrationManifestPrefix(
      parseMigrationManifest(JSON.parse(baseline.stdout)),
      current,
    );
  } else {
    console.log(
      "Baseline predates the manifest; validating the initial adoption.",
    );
  }
}
// oxlint-disable-next-line node/no-process-env
if (process.env.usage_append === "true") {
  const directories = await readdir(migrationsFolder, { withFileTypes: true });
  const migrations = await Promise.all(
    directories.map(async (entry) => {
      if (!entry.isDirectory()) {
        throw new Error("Unexpected entry in the migrations directory.");
      }
      migrationTimestamp(entry.name);
      const sql = join(migrationsFolder, entry.name, "migration.sql");
      if (!(await lstat(sql)).isFile()) {
        throw new Error("Migration SQL must be a regular file.");
      }
      return {
        name: entry.name,
        sha256: createHash("sha256")
          .update(await readFile(sql))
          .digest("hex"),
      };
    }),
  );
  migrations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const next = parseMigrationManifest({ formatVersion: 1, migrations });
  assertMigrationManifestPrefix(current, next);
  await writeFile(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
}
await verifyMigrationManifest({ manifestPath, migrationsFolder });
console.log("Migration manifest and raw SQL verified.");
