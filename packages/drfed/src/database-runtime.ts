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

import { checkServerIdentity } from "node:tls";

import {
  type Database,
  MigrationPreparationError,
  inspectMigrationState,
  openPersistentPglite,
  preparePgliteDatabase,
  preparePostgresDatabase,
  relations,
  schema,
} from "@drfed/models";
import type { PGlite } from "@electric-sql/pglite";
import { getLogger } from "@logtape/logtape";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { ServerOptions } from "./parser.ts";
import { resolvePostgresConnection } from "./postgres-settings.ts";
import { privateKeySafeLogger } from "./query-logger.ts";
import type { ResourceOwner } from "./resources.ts";

export interface DatabaseRuntime {
  readonly state: Awaited<ReturnType<typeof inspectMigrationState>>;
  readonly credentials:
    | { readonly driver: "pglite"; readonly client: PGlite }
    | { readonly client: ReturnType<typeof postgres> };
  readonly db: Database;
}

/**
 * Open owned database resources and apply migrations or only inspect history.
 * Register the complete acquisition with an OperationRegistry before closing
 * the owner; inspection returns non-ready states for its caller to interpret.
 * @returns The database, borrowed connection and inspected/prepared history.
 */
export async function openDatabaseRuntime(
  configuration: ServerOptions["drizzle"],
  owner: ResourceOwner,
  policy: "apply" | "inspect",
  signal?: AbortSignal,
): Promise<DatabaseRuntime> {
  if (configuration.driver === "pglite") {
    const store = owner.register(
      await openPersistentPglite(configuration.dataPath),
      (resource) => resource.close(),
      { owned: true },
    );
    await store.ready;
    getLogger(["drfed", "database"]).info(
      "Using PGlite data directory {dataPath}.",
      { dataPath: store.dataPath },
    );
    const client = store.client;
    const state =
      policy === "apply"
        ? await preparePgliteDatabase({
            store,
            ...(signal === undefined ? {} : { signal }),
          })
        : await inspectHistory(client, signal);
    return {
      state,
      credentials: { driver: "pglite" as const, client },
      db: drizzlePglite({
        client,
        relations,
        schema,
        logger: privateKeySafeLogger(),
      }),
    };
  }
  const connection = resolvePostgresConnection(configuration.databaseUrl);
  const ssl = connection.tls
    ? {
        rejectUnauthorized: true,
        checkServerIdentity: (
          _hostname: string,
          certificate: Parameters<typeof checkServerIdentity>[1],
        ) => checkServerIdentity(connection.host, certificate),
      }
    : false;
  const prepared =
    policy === "apply"
      ? await preparePostgresDatabase({
          credentials: {
            connection: {
              host: connection.host,
              port: connection.port,
              database: connection.database,
              user: connection.user,
              password: () => connection.password,
              options: connection.options,
              application_name: connection.applicationName,
              ssl,
            },
          },
          lockTimeoutMs: configuration.lockTimeoutMs,
          ...(signal === undefined ? {} : { signal }),
        })
      : undefined;
  const client = owner.register(
    // postgres.js supports host/port arrays at runtime, but Options narrows them.
    postgres(connection.runtimeUrl, {
      host: [connection.host],
      database: connection.database,
      user: connection.user,
      password: () => connection.password,
      port: [connection.port],
      ssl,
      sslnegotiation: null,
    } as unknown as postgres.Options<Record<string, never>>),
    (resource) => resource.end(),
    { owned: true },
  );
  const state =
    prepared ??
    (await inspectHistory(
      {
        query: async (statement, values) => ({
          rows: await client.unsafe(
            statement,
            values?.map((value) =>
              Array.isArray(value) ? client.array(value, 25) : value,
            ) as Parameters<typeof client.unsafe>[1],
          ),
        }),
      },
      signal,
    ));
  return {
    state,
    credentials: { client },
    db: drizzlePostgres({
      client,
      relations,
      schema,
      logger: privateKeySafeLogger(),
    }),
  };
}

async function inspectHistory(
  client: Parameters<typeof inspectMigrationState>[0],
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<typeof inspectMigrationState>>> {
  if (signal?.aborted) throw new MigrationPreparationError("aborted");
  let state;
  try {
    state = await inspectMigrationState(client);
  } catch {
    throw new MigrationPreparationError("inspection-failed");
  }
  if (signal?.aborted) throw new MigrationPreparationError("aborted");
  return state;
}
