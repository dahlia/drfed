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
import type { PGlite } from "@electric-sql/pglite";

import {
  type MigrationManifest,
  type MigrationManifestPaths,
  verifyMigrationManifest,
} from "./migration-manifest.ts";
import { MigrationPreparationError } from "./migration-preparation-error.ts";
import { withVerifiedMigrationSnapshot } from "./migration-snapshot.ts";
import {
  type MigrationState,
  inspectMigrationState,
} from "./migration-state.ts";
import type { PersistentPgliteStore } from "./pglite-store.ts";

export interface PreparePgliteOptions extends MigrationManifestPaths {
  /** Borrowed exclusive owner. The caller must drain preparation before close. */
  readonly store: PersistentPgliteStore;
  readonly migrationsSchema?: string;
  readonly migrationsTable?: string;
  /** Abort is checked at safe boundaries; active WASM SQL is allowed to settle. */
  readonly signal?: AbortSignal;
}

const preparations = new WeakMap<PGlite, Promise<void>>();

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MigrationPreparationError("aborted");
}

async function inspect(
  options: PreparePgliteOptions,
  manifest: MigrationManifest,
): Promise<MigrationState> {
  checkAbort(options.signal);
  try {
    const state = await inspectMigrationState(options.store.client, {
      manifest,
      migrationsSchema: options.migrationsSchema ?? "drizzle",
      migrationsTable: options.migrationsTable ?? "__drizzle_migrations",
    });
    checkAbort(options.signal);
    return state;
  } catch (error) {
    if (error instanceof MigrationPreparationError) throw error;
    throw new MigrationPreparationError("inspection-failed");
  }
}

async function prepare(options: PreparePgliteOptions): Promise<MigrationState> {
  checkAbort(options.signal);
  let manifest: MigrationManifest;
  try {
    manifest = await verifyMigrationManifest(options);
  } catch {
    throw new MigrationPreparationError("invalid-migration-files");
  }
  checkAbort(options.signal);
  await options.store.ready;
  const state = await inspect(options, manifest);
  if (
    !["ready", "pending", "uninitialized", "upgrade-required"].includes(
      state.status,
    )
  ) {
    throw new MigrationPreparationError("incompatible-history", state);
  }
  if (state.status === "ready") return state;
  try {
    const [{ drizzle }, { migrate }] = await Promise.all([
      import("drizzle-orm/pglite"),
      import("drizzle-orm/pglite/migrator"),
    ]);
    await withVerifiedMigrationSnapshot(
      manifest,
      options,
      async (migrationsFolder) => {
        checkAbort(options.signal);
        await migrate(drizzle({ client: options.store.client }), {
          migrationsFolder,
          migrationsSchema: options.migrationsSchema ?? "drizzle",
          migrationsTable: options.migrationsTable ?? "__drizzle_migrations",
        });
      },
    );
  } catch (error) {
    checkAbort(options.signal);
    if (error instanceof MigrationPreparationError) throw error;
    throw new MigrationPreparationError("migration-failed");
  }
  const result = await inspect(options, manifest);
  if (result.status !== "ready") {
    throw new MigrationPreparationError("incompatible-history", result);
  }
  return result;
}

/**
 * Prepare schema on a caller-owned exclusive persistent PGlite store.
 * Serialize preparers sharing the same client. Other callers must not issue
 * queries or close that borrowed store until preparation settles. No ownership
 * is released here, including after abort or SQL failure.
 * @returns Verified exact ready history after applying SQL or upgrading metadata.
 */
export async function preparePgliteDatabase(
  options: PreparePgliteOptions,
): Promise<MigrationState> {
  checkAbort(options.signal);
  const previous = preparations.get(options.store.client) ?? Promise.resolve();
  // Keep the queue tail fulfilled while returning each caller's actual outcome.
  // oxlint-disable promise/prefer-await-to-then
  const result = previous.then(() => prepare(options));
  preparations.set(
    options.store.client,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  // oxlint-enable promise/prefer-await-to-then
  return await result;
}
