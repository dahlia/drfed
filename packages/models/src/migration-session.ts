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
import { setTimeout as delay } from "node:timers/promises";

import { getLogger } from "@logtape/logtape";
import type { Client } from "pg";

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

export {
  MigrationPreparationError,
  type MigrationPreparationCode,
} from "./migration-preparation-error.ts";

/** An exclusive, not-yet-connected client, created anew for each preparation. */
export type MigrationClientFactory = () => Client;

export type PostgresPreparationCredentials =
  | { readonly url: string; readonly clientFactory?: never }
  | { readonly clientFactory: MigrationClientFactory; readonly url?: never };

export interface PreparePostgresOptions extends MigrationManifestPaths {
  readonly credentials: PostgresPreparationCredentials;
  readonly migrationsSchema?: string;
  readonly migrationsTable?: string;
  /** Deadline for connecting and acquiring the lock, not for applying SQL. */
  readonly lockTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Derive stable signed PostgreSQL advisory-lock keys for this history table.
 * @returns Two int32 keys independent of process, connection and package version.
 */
export function migrationLockKey(
  namespace = "drizzle",
  table = "__drizzle_migrations",
): readonly [number, number] {
  const hash = createHash("sha256")
    .update(JSON.stringify(["org.drfed.migrations", namespace, table]))
    .digest();
  return [hash.readInt32BE(0), hash.readInt32BE(4)];
}

const logger = getLogger(["drfed", "models", "migration"]);

class MigrationSession {
  readonly client: Client;
  readonly #signal: AbortSignal | undefined;
  readonly #waiting = new AbortController();
  readonly #deadline: ReturnType<typeof setTimeout>;
  readonly #abort: () => void;
  #interrupted: MigrationPreparationError | undefined;
  #connecting = false;
  #key: readonly [number, number] | undefined;

  constructor(client: Client, timeout: number, signal?: AbortSignal) {
    this.client = client;
    this.#signal = signal;
    this.#abort = () =>
      this.interrupt(new MigrationPreparationError("aborted"));
    client.on("error", () =>
      this.interrupt(new MigrationPreparationError("connection-failed")),
    );
    signal?.addEventListener("abort", this.#abort, { once: true });
    this.#deadline = setTimeout(
      () => this.interrupt(new MigrationPreparationError("lock-timeout")),
      timeout,
    );
  }

  get failure(): MigrationPreparationError | undefined {
    return this.#interrupted;
  }

  interrupt(error: MigrationPreparationError): void {
    this.#interrupted ??= error;
    this.#waiting.abort(this.#interrupted);
    // Public pg Connection.stream is also the active TLS stream after upgrade.
    // During handshake, an error is essential to settle connect()'s promise.
    // Before connect(), no stream error listeners exist, so destroy without error.
    this.client.connection.stream.destroy(
      this.#connecting ? this.#interrupted : undefined,
    );
  }

  check(): void {
    if (this.#interrupted) {
      throw new MigrationPreparationError(
        this.#interrupted.code,
        this.#interrupted.state,
      );
    }
  }

  async acquire(key: readonly [number, number]): Promise<void> {
    if (this.#signal?.aborted) {
      this.#abort();
    }
    this.check();
    this.#connecting = true;
    await this.client.connect();
    this.check();
    while (!this.#key) {
      // Acquisition is session-local and reentrant; attempts must be sequential.
      // oxlint-disable-next-line no-await-in-loop
      const result = await this.client.query<{
        locked: boolean;
        backend_pid: number;
      }>(
        "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked, pg_backend_pid() AS backend_pid",
        [...key],
      );
      this.check();
      if (result.rows[0]?.locked === true) {
        this.#key = key;
        logger.debug(
          "Acquired migration lock on PostgreSQL backend {backendPid}.",
          { backendPid: result.rows[0].backend_pid },
        );
      } else {
        // oxlint-disable-next-line no-await-in-loop
        await delay(50, undefined, { signal: this.#waiting.signal });
      }
    }
    clearTimeout(this.#deadline);
  }

  async #unlock(): Promise<boolean> {
    if (
      !this.#key ||
      this.#interrupted ||
      this.client.connection.stream.destroyed
    ) {
      return true;
    }
    try {
      const result = await this.client.query<{ unlocked: boolean }>(
        "SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked",
        [...this.#key],
      );
      return result.rows[0]?.unlocked === true;
    } catch {
      return false;
    }
  }

  async close(): Promise<boolean> {
    clearTimeout(this.#deadline);
    let cleanupFailed = false;
    const deadline = setTimeout(() => {
      cleanupFailed = true;
      this.interrupt(new MigrationPreparationError("cleanup-failed"));
    }, 5_000);
    try {
      cleanupFailed = !(await this.#unlock());
      if (cleanupFailed) {
        this.interrupt(new MigrationPreparationError("cleanup-failed"));
      }
      await this.client.end();
    } catch {
      cleanupFailed = true;
      this.interrupt(new MigrationPreparationError("cleanup-failed"));
    } finally {
      clearTimeout(deadline);
      this.#signal?.removeEventListener("abort", this.#abort);
    }
    return cleanupFailed;
  }
}

async function inspectSession(
  session: MigrationSession,
  options: PreparePostgresOptions,
  manifest: MigrationManifest,
): Promise<MigrationState> {
  try {
    const state = await inspectMigrationState(session.client, {
      migrationsSchema: options.migrationsSchema ?? "drizzle",
      migrationsTable: options.migrationsTable ?? "__drizzle_migrations",
      manifest,
    });
    session.check();
    return state;
  } catch {
    session.check();
    throw new MigrationPreparationError("inspection-failed");
  }
}

async function applySession(
  session: MigrationSession,
  options: PreparePostgresOptions,
  manifest: MigrationManifest,
): Promise<MigrationState> {
  const state = await inspectSession(session, options, manifest);
  if (
    !["ready", "pending", "uninitialized", "upgrade-required"].includes(
      state.status,
    )
  ) {
    throw new MigrationPreparationError("incompatible-history", state);
  }
  if (state.status !== "ready") {
    try {
      const [{ drizzle }, { migrate }] = await Promise.all([
        import("drizzle-orm/node-postgres"),
        import("drizzle-orm/node-postgres/migrator"),
      ]);
      session.check();
      await withVerifiedMigrationSnapshot(
        manifest,
        options,
        async (migrationsFolder) => {
          session.check();
          await migrate(drizzle({ client: session.client }), {
            migrationsFolder,
            migrationsSchema: options.migrationsSchema ?? "drizzle",
            migrationsTable: options.migrationsTable ?? "__drizzle_migrations",
          });
        },
      );
    } catch (error) {
      session.check();
      if (error instanceof MigrationPreparationError) {
        throw error;
      }
      throw new MigrationPreparationError("migration-failed");
    }
    session.check();
  }
  const result = await inspectSession(session, options, manifest);
  if (result.status !== "ready") {
    throw new MigrationPreparationError("incompatible-history", result);
  }
  return result;
}

function checkTransport(client: Client): void {
  if (
    !client.connection?.stream ||
    typeof client.connection.stream.destroy !== "function"
  ) {
    // The factory contract guarantees no connection needs closing at this point.
    throw new MigrationPreparationError("invalid-options");
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new MigrationPreparationError("aborted");
  }
}

/**
 * Verify, lock, inspect and apply migrations on one owned PostgreSQL session.
 * A supplied factory must return a fresh unconnected exclusive Client. The
 * runner owns connect/end, never reconnects, and closes its transport on abort.
 * PostgreSQL may retain an interrupted statement and its lock until it observes
 * that disconnection; no other preparer can bypass that still-held lock.
 * @returns Exact ready history after applying/metadata-upgrading if needed.
 */
export async function preparePostgresDatabase(
  options: PreparePostgresOptions,
): Promise<MigrationState> {
  const timeout = options.lockTimeoutMs ?? 30_000;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
    throw new MigrationPreparationError("invalid-options");
  }
  checkAbort(options.signal);
  let manifest: MigrationManifest;
  try {
    manifest = await verifyMigrationManifest(options);
  } catch {
    throw new MigrationPreparationError("invalid-migration-files");
  }
  checkAbort(options.signal);
  let client: Client;
  try {
    if ("clientFactory" in options.credentials) {
      client = options.credentials.clientFactory();
    } else {
      const { Client } = await import("pg");
      checkAbort(options.signal);
      client = new Client({
        connectionString: options.credentials.url,
        connectionTimeoutMillis: timeout,
      });
    }
  } catch {
    checkAbort(options.signal);
    throw new MigrationPreparationError("connection-failed");
  }
  checkTransport(client);
  const session = new MigrationSession(client, timeout, options.signal);
  let result: MigrationState | undefined;
  let failure: MigrationPreparationError | undefined;
  try {
    await session.acquire(
      migrationLockKey(options.migrationsSchema, options.migrationsTable),
    );
    result = await applySession(session, options, manifest);
  } catch (error) {
    failure =
      session.failure ??
      (error instanceof MigrationPreparationError
        ? error
        : new MigrationPreparationError("connection-failed"));
  } finally {
    const cleanupFailed = await session.close();
    failure ??= session.failure;
    if (cleanupFailed) {
      failure = new MigrationPreparationError(
        failure?.code ?? "cleanup-failed",
        failure?.state,
        true,
      );
    }
  }
  if (failure) {
    throw new MigrationPreparationError(
      failure.code,
      failure.state,
      failure.cleanupFailed,
    );
  }
  if (!result) {
    throw new MigrationPreparationError("inspection-failed");
  }
  return result;
}
