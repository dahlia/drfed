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

import { object, or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { map, optional, withDefault } from "@optique/core/modifiers";
import type { InferValue } from "@optique/core/parser";
import { command, flag, option } from "@optique/core/primitives";
import { integer, string } from "@optique/core/valueparser";

import {
  configurationBoolean,
  configurationProjection,
  configurationProvenance,
  createConfigurationBindings,
  configurationSettings as settings,
} from "../configuration.ts";
import { resolveDatabaseSettings } from "../database-settings.ts";
import { valueOptionNames } from "../parser.ts";
import { accountEmail, resolveAccountInput } from "./account-create.ts";

/**
 * Construct an independent database-only command using shared source bindings.
 * @returns Pure program metadata, contexts and the explicit TOML loader.
 */
export function createAccountProgram(
  options: Parameters<typeof createConfigurationBindings>[0] = {},
) {
  const bindings = createConfigurationBindings(options);
  const { bind } = bindings;
  const lockTimeout = integer({
    min: 1,
    max: 2_147_483_647,
    metavar: "MILLISECONDS",
  });
  const parser = command(
    "create",
    object({
      configPath: optional(
        bindings.bindConfigPath(
          option("--config", string({ metavar: "FILE" }), {
            description: message`Read the shared DrFed TOML configuration file.`,
          }),
        ),
      ),
      databaseDriver: bind(
        option(
          ...valueOptionNames.databaseDriver,
          string({ metavar: "DRIVER" }),
          { description: message`Choose pglite or postgres.` },
        ),
        settings.databaseDriver,
        string(),
        String,
      ),
      dataPath: bind(
        option(...valueOptionNames.dataPath, string({ metavar: "DIRECTORY" }), {
          description: message`Persistent PGlite directory; defaults to the OS data location.`,
        }),
        settings.dataPath,
        string(),
        String,
      ),
      postgresUrl: bind(
        option(...valueOptionNames.postgresUrl, string({ metavar: "URL" }), {
          description: message`PostgreSQL connection URL.`,
        }),
        settings.postgresUrl,
        string(),
        String,
      ),
      migrationLockTimeout: bind(
        option(...valueOptionNames.migrationLockTimeout, lockTimeout, {
          description: message`Maximum connection and migration lock wait in milliseconds.`,
        }),
        settings.migrationLockTimeout,
        lockTimeout,
        String,
        30_000,
      ),
      email: option("--email", accountEmail, {
        description: message`Login email for the new account.`,
      }),
      name: option("--name", string({ metavar: "NAME" }), {
        description: message`Display name, between 1 and 100 characters after trimming.`,
      }),
      migrate: bind(
        or(
          flag("--migrate", {
            description: message`Prepare the database before creating an account.`,
          }),
          map(
            flag("--no-migrate", "-M", {
              description: message`Require ready history without applying migrations.`,
            }),
            () => false,
          ),
        ),
        settings.migrate,
        configurationBoolean(),
        String,
        true,
      ),
      printConfig: withDefault(
        flag("--print-config", {
          description: message`Print effective settings and provenance with credentials redacted, then exit without opening runtime resources.`,
        }),
        false,
      ),
    }),
  );
  return {
    program: {
      metadata: {
        name: "drfed-account",
        description: message`Manage local DrFed accounts.`,
      },
      parser,
    },
    contexts: bindings.contexts,
    load: bindings.load,
  };
}

type RawAccountOptions = InferValue<
  ReturnType<typeof createAccountProgram>["program"]["parser"]
>;

/**
 * Select the winning database and retain source-only diagnostic metadata.
 * @returns Validated command settings without acquiring runtime resources.
 */
export function resolveAccountOptions(
  raw: RawAccountOptions,
  cwd = process.cwd(),
) {
  const selected = resolveDatabaseSettings(
    {
      driver: raw.databaseDriver,
      dataPath: raw.dataPath,
      postgresUrl: raw.postgresUrl,
    },
    cwd,
  );
  const lockTimeoutMs = raw.migrationLockTimeout?.value;
  if (lockTimeoutMs === undefined) {
    throw new Error("Missing migration lock timeout.");
  }
  const input = resolveAccountInput(raw.email, raw.name);
  return {
    database: {
      ...selected.database,
      lockTimeoutMs,
      migrate: raw.migrate?.value ?? true,
    },
    ...input,
    printConfig: raw.printConfig,
    ignored: selected.ignored,
    provenance: configurationProvenance({
      databaseDriver: raw.databaseDriver,
      dataPath: raw.dataPath,
      postgresUrl: raw.postgresUrl,
      migrate: raw.migrate,
      migrationLockTimeout: raw.migrationLockTimeout,
    }),
  };
}

/**
 * Describe database-only settings and their sources without opening resources.
 * @returns Redacted settings and ignored configuration areas for diagnostics.
 */
export function describeAccountConfiguration(
  options: ReturnType<typeof resolveAccountOptions>,
) {
  const values = {
    databaseDriver: options.database.driver,
    dataPath:
      options.database.driver === "pglite"
        ? options.database.dataPath
        : undefined,
    postgresUrl:
      options.database.driver === "postgres" ? "<redacted>" : undefined,
    migrationLockTimeout: options.database.lockTimeoutMs,
    migrate: options.database.migrate,
  };
  const rank = { default: 0, config: 1, env: 2, cli: 3 };
  const selected = ["databaseDriver", "dataPath", "postgresUrl"]
    .map((key) => options.provenance[key])
    .filter((value) => value !== undefined)
    .sort((left, right) => rank[right.source] - rank[left.source])[0];
  return {
    command: "account" as const,
    action: "create",
    settings: Object.fromEntries(
      Object.entries(values)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [
          settings[key as keyof typeof values].toml,
          {
            value,
            ...((key === "databaseDriver"
              ? selected
              : options.provenance[key]) ?? { source: "default" as const }),
          },
        ]),
    ),
    ignored: [
      ...options.ignored,
      ...configurationProjection("account").unusedAreas.map((area) => ({
        area,
        reason: "unused by this command",
      })),
    ],
  };
}
