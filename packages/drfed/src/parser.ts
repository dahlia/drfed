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
import { relations, schema } from "@drfed/models";
import { merge, object, or } from "@optique/core/constructs";
import { message, optionNames } from "@optique/core/message";
import { map, withDefault } from "@optique/core/modifiers";
import type { InferValue } from "@optique/core/parser";
import { option } from "@optique/core/primitives";
import { socketAddress, url } from "@optique/core/valueparser";
import { path } from "@optique/run/valueparser";
import { drizzle as drizzlePostgres } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";

const pgliteParser = map(
  option(
    "--pglite-data-path",
    "--data-path",
    "-d",
    path({ type: "directory" }),
    {
      description: message`The path to the directory where the PGlite database files will be stored.  Mutually exclusive with ${optionNames(["--postgres-url", "--database-url", "-D"])}.`,
    },
  ),
  (dbPath) => ({
    credentials: {
      driver: "pglite" as const,
      url: dbPath,
    },
    db: drizzlePglite({
      connection: { dataDir: dbPath },
      relations,
      schema,
    }),
  }),
);

const postgresParser = map(
  option(
    "--postgres-url",
    "--database-url",
    "-D",
    url({ allowedProtocols: ["postgres:", "postgresql:"] }),
    {
      description: message`The URL of the PostgreSQL database to connect to.  Mutually exclusive with ${optionNames(["--pglite-data-path", "--data-path", "-d"])}.`,
    },
  ),
  (dbUrl) => ({
    credentials: {
      url: dbUrl.href,
    },
    db: drizzlePostgres({
      connection: {
        connectionString: dbUrl.href,
      },
      relations,
      schema,
    }),
  }),
);

export const parser = object({
  address: withDefault(
    option("--listen", "-l", socketAddress({ requirePort: true }), {
      description: message`The address to listen on.`,
    }),
    {
      host: "localhost",
      port: 8888,
    },
  ),
  drizzle: merge(
    or(pgliteParser, postgresParser),
    object({
      migrate: map(
        option("--no-migrate", "-M", {
          description: message`Disable automatic database migrations.`,
        }),
        (noMigrate) => !noMigrate,
      ),
    }),
  ),
});

export type Options = InferValue<typeof parser>;

export default parser;
