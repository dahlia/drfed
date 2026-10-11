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
import { LogTapeTransport } from "@upyo/logtape";
import { SmtpTransport } from "@upyo/smtp";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { ServerOptions } from "./parser.ts";
import { resolvePostgresConnection } from "./postgres-settings.ts";
import { privateKeySafeLogger } from "./query-logger.ts";
import type { ResourceOwner } from "./resources.ts";

interface DatabaseRuntime {
  readonly credentials:
    | { readonly driver: "pglite"; readonly client: PGlite }
    | { readonly client: ReturnType<typeof postgres> };
  readonly db: Database;
}

interface ServerRuntime extends Omit<ServerOptions, "drizzle"> {
  readonly drizzle: DatabaseRuntime & { readonly migrate: boolean };
  readonly mailer: LogTapeTransport | SmtpTransport;
}

async function createDatabase(
  configuration: ServerOptions["drizzle"],
  owner: ResourceOwner,
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
    if (configuration.migrate) {
      await preparePgliteDatabase({
        store,
        ...(signal === undefined ? {} : { signal }),
      });
    } else {
      await requireReadyHistory(client, signal);
    }
    return {
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
  if (configuration.migrate) {
    await preparePostgresDatabase({
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
    });
  }
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
  if (!configuration.migrate) {
    await requireReadyHistory(
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
    );
  }
  return {
    credentials: { client },
    db: drizzlePostgres({
      client,
      relations,
      schema,
      logger: privateKeySafeLogger(),
    }),
  };
}

async function requireReadyHistory(
  client: Parameters<typeof inspectMigrationState>[0],
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new MigrationPreparationError("aborted");
  let state;
  try {
    state = await inspectMigrationState(client);
  } catch {
    throw new MigrationPreparationError("inspection-failed");
  }
  if (signal?.aborted) throw new MigrationPreparationError("aborted");
  if (state.status !== "ready") {
    throw new MigrationPreparationError("incompatible-history", state);
  }
}

/**
 * Create resources only after the server command has been parsed successfully.
 * @returns Runtime resources owned by the selected server command.
 */
export async function createServerRuntime(
  options: ServerOptions,
  owner: ResourceOwner,
  signal?: AbortSignal,
): Promise<ServerRuntime> {
  const database = await createDatabase(options.drizzle, owner, signal);
  if (signal?.aborted) throw new MigrationPreparationError("aborted");
  const mailer =
    options.smtpUrl == null
      ? new LogTapeTransport({ recordMessage: "inline" })
      : new SmtpTransport({
          host: options.smtpUrl.hostname,
          port: options.smtpUrl.port === "" ? 25 : Number(options.smtpUrl.port),
          secure: false,
        });
  owner.register(mailer, (transport) => transport[Symbol.asyncDispose](), {
    owned: true,
  });
  return {
    ...options,
    drizzle: { ...database, migrate: options.drizzle.migrate },
    mailer,
  };
}
