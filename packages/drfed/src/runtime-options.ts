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

import { type Database, relations, schema } from "@drfed/models";
import { PGlite } from "@electric-sql/pglite";
import { LogTapeTransport } from "@upyo/logtape";
import { SmtpTransport } from "@upyo/smtp";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import type { ServerOptions } from "./parser.ts";
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

function createDatabase(
  configuration: ServerOptions["drizzle"],
  owner: ResourceOwner,
): DatabaseRuntime {
  if (configuration.driver === "pglite") {
    const client = owner.register(
      new PGlite(configuration.dataPath),
      (resource) => resource.close(),
      { owned: true },
    );
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
  const client = owner.register(
    postgres(configuration.databaseUrl.href),
    (resource) => resource.end(),
    { owned: true },
  );
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

/**
 * Create resources only after the server command has been parsed successfully.
 * @returns Runtime resources owned by the selected server command.
 */
export function createServerRuntime(
  options: ServerOptions,
  owner: ResourceOwner,
): ServerRuntime {
  const database = createDatabase(options.drizzle, owner);
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
