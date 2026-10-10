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
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  MigrationManifest,
  MigrationManifestPaths,
} from "./migration-manifest.ts";
import { MigrationPreparationError } from "./migration-preparation-error.ts";

// Drizzle rereads paths internally. Give it a private snapshot of exact verified
// bytes, so an installation changing while the session waits cannot supply SQL.
export async function withVerifiedMigrationSnapshot<T>(
  manifest: MigrationManifest,
  options: MigrationManifestPaths,
  run: (folder: string) => Promise<T>,
): Promise<T> {
  const original =
    options.migrationsFolder ??
    fileURLToPath(new URL("../drizzle/", import.meta.url));
  let files: { name: string; sql: Buffer }[];
  try {
    files = await Promise.all(
      manifest.migrations.map(async (entry) => {
        const sql = await readFile(join(original, entry.name, "migration.sql"));
        if (createHash("sha256").update(sql).digest("hex") !== entry.sha256) {
          throw new MigrationPreparationError("invalid-migration-files");
        }
        return { name: entry.name, sql };
      }),
    );
  } catch {
    throw new MigrationPreparationError("invalid-migration-files");
  }
  const folder = await mkdtemp(join(tmpdir(), "drfed-migration-"));
  try {
    await Promise.all(
      files.map(async ({ name, sql }) => {
        const directory = join(folder, name);
        await mkdir(directory);
        await writeFile(join(directory, "migration.sql"), sql, {
          flag: "wx",
          mode: 0o600,
        });
      }),
    );
    return await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
