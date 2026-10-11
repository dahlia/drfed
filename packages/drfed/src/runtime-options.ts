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

import { MigrationPreparationError } from "@drfed/models";
import { LogTapeTransport } from "@upyo/logtape";
import { SmtpTransport } from "@upyo/smtp";

import {
  type DatabaseRuntime,
  openDatabaseRuntime,
} from "./database-runtime.ts";
import type { ServerOptions } from "./parser.ts";
import type { ResourceOwner } from "./resources.ts";

interface ServerRuntime extends Omit<ServerOptions, "drizzle"> {
  readonly drizzle: DatabaseRuntime & { readonly migrate: boolean };
  readonly mailer: LogTapeTransport | SmtpTransport;
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
  const database = await openDatabaseRuntime(
    options.drizzle,
    owner,
    options.drizzle.migrate ? "apply" : "inspect",
    signal,
  );
  if (database.state.status !== "ready") {
    throw new MigrationPreparationError("incompatible-history", database.state);
  }
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
