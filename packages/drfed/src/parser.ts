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

import { conditional, merge, object, or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { map, multiple, optional, withDefault } from "@optique/core/modifiers";
import type { InferValue } from "@optique/core/parser";
import { flag, option } from "@optique/core/primitives";
import {
  email,
  integer,
  origin,
  socketAddress,
  string,
  url,
} from "@optique/core/valueparser";
import { type LogOutput, logLevel, textFormatter } from "@optique/logtape";
import { path } from "@optique/run/valueparser";

import {
  type Sourced,
  configurationBoolean,
  configurationPath,
  configurationProvenance,
  type createConfigurationBindings,
  configurationSettings as settings,
  stringArray,
} from "./configuration.ts";
import { resolveDatabaseSettings } from "./database-settings.ts";
import { rootOrigin } from "./valueparser.ts";

/** Shared value-option spellings for strict parsing and metadata arity. */
export const valueOptionNames = {
  configPath: ["--config"],
  address: ["--listen", "-l"],
  rootOrigin: ["--root-origin", "-r"],
  loginOrigins: ["--login-origin"],
  emailFrom: ["--email-from", "-f"],
  databaseDriver: ["--database-driver"],
  dataPath: ["--pglite-data-path", "--data-path", "-d"],
  postgresUrl: ["--postgres-url", "--database-url", "-D"],
  migrationLockTimeout: ["--migration-lock-timeout"],
  mailTransport: ["--mail-transport"],
  smtpUrl: ["--smtp-url", "-s"],
  logLevel: ["--log-level", "-L"],
  logFormat: ["--log-format"],
  logOutput: ["--log-output"],
  outputFile: ["--output-file", "-o"],
} as const;

type Bindings = ReturnType<typeof createConfigurationBindings>;
const identity = (value: string) => value;

/**
 * Construct a fresh parser from shared bindings without creating resources.
 * @returns The server and schema-output parser.
 */
export function createParser(
  bindings: Bindings,
  mode: "server" | "schema" = "server",
) {
  const { bind } = bindings;
  const address = socketAddress({ requirePort: true });
  const root = rootOrigin({ metavar: "ORIGIN" });
  const lockTimeout = integer({
    min: 1,
    max: 2_147_483_647,
    metavar: "MILLISECONDS",
  });
  const sender = email({ lowercase: true });
  const level = logLevel();
  const formatter = textFormatter();
  const logging = object("Logging options", {
    level: bind(
      option(...valueOptionNames.logLevel, level, {
        description: message`The lowest log level to record.`,
      }),
      settings.logLevel,
      level,
      identity,
      "info",
    ),
    format: bind(
      option(...valueOptionNames.logFormat, formatter, {
        description: message`The log formatter.`,
      }),
      settings.logFormat,
      formatter,
      identity,
    ),
    output: bind(
      option(...valueOptionNames.logOutput, string({ metavar: "FILE" }), {
        description: message`Log output file. Use - for the console.`,
      }),
      settings.logOutput,
      string(),
      identity,
      "-",
    ),
  });
  const server = object("DrFed server", {
    address: bind(
      option(...valueOptionNames.address, address, {
        description: message`The address to listen on.`,
      }),
      settings.listen,
      address,
      identity,
      { host: "localhost", port: 8888 },
    ),
    rootOrigin: bind(
      option(...valueOptionNames.rootOrigin, root, {
        description: message`The root origin whose subdomains name instances. Required through CLI, environment or configuration.`,
      }),
      settings.rootOrigin,
      root,
      identity,
    ),
    loginOrigins: bind(
      multiple(
        option(
          ...valueOptionNames.loginOrigins,
          string({ metavar: "ORIGIN" }),
          {
            description: message`An HTTP or HTTPS frontend origin allowed in login links. Repeat to replace the configured list.`,
          },
        ),
        { min: 1 },
      ),
      settings.loginOrigins,
      stringArray(),
      JSON.stringify,
    ),
    emailFrom: bind(
      option(...valueOptionNames.emailFrom, sender, {
        description: message`The login mail sender. Defaults to noreply at the root origin's host name.`,
      }),
      settings.emailFrom,
      sender,
      identity,
    ),
    databaseDriver: bind(
      option(
        ...valueOptionNames.databaseDriver,
        string({ metavar: "DRIVER" }),
        {
          description: message`Select pglite or postgres. Higher-priority selectors replace the other database kind.`,
        },
      ),
      settings.databaseDriver,
      string(),
      identity,
    ),
    dataPath: bind(
      option(...valueOptionNames.dataPath, string({ metavar: "DIRECTORY" }), {
        description: message`PGlite data directory. Cannot accompany a PostgreSQL selector at the same source.`,
      }),
      settings.dataPath,
      string(),
      identity,
    ),
    postgresUrl: bind(
      option(...valueOptionNames.postgresUrl, string({ metavar: "URL" }), {
        description: message`PostgreSQL connection URL. Cannot accompany a PGlite selector at the same source.`,
      }),
      settings.postgresUrl,
      string(),
      identity,
    ),
    migrate: bind(
      or(
        flag("--migrate", {
          description: message`Apply database migrations on startup.`,
        }),
        map(
          flag("--no-migrate", "-M", {
            description: message`Require exact ready migration history without applying SQL or upgrading metadata.`,
          }),
          () => false,
        ),
      ),
      settings.migrate,
      configurationBoolean(),
      String,
      true,
    ),
    migrationLockTimeout: bind(
      option(...valueOptionNames.migrationLockTimeout, lockTimeout, {
        description: message`Maximum PostgreSQL migration connection and lock wait in milliseconds. PGlite ownership conflicts fail immediately.`,
      }),
      settings.migrationLockTimeout,
      lockTimeout,
      String,
      30_000,
    ),
    mailTransport: bind(
      option(
        ...valueOptionNames.mailTransport,
        string({ metavar: "TRANSPORT" }),
        {
          description: message`Select logtape or smtp. An SMTP URL also selects smtp.`,
        },
      ),
      settings.mailTransport,
      string(),
      identity,
    ),
    smtpUrl: bind(
      option(...valueOptionNames.smtpUrl, string({ metavar: "URL" }), {
        description: message`SMTP connection URL. A higher-priority logtape selector disables it.`,
      }),
      settings.smtpUrl,
      string(),
      identity,
    ),
    seed: option("--dev-seed", {
      description: message`Seed initial development data.`,
      hidden: true,
    }),
    logging,
    printConfig: withDefault(
      flag("--print-config", {
        description: message`Print effective settings and their sources, with secrets redacted, then exit without opening runtime resources.`,
      }),
      false,
    ),
  });
  const schema = object("GraphQL schema generation", {
    // Preserve the historical logging spellings for schema invocations,
    // but do not bind or validate operational values in this projection.
    ignoredLogging: object({
      level: optional(
        option(...valueOptionNames.logLevel, string(), { hidden: true }),
      ),
      format: optional(
        option(...valueOptionNames.logFormat, string(), { hidden: true }),
      ),
      output: optional(
        option(...valueOptionNames.logOutput, string(), { hidden: true }),
      ),
    }),
    outputFile: withDefault(
      option(
        ...valueOptionNames.outputFile,
        path({ type: "file", allowCreate: true }),
        {
          description: message`Schema output file. Use - for stdout.`,
        },
      ),
      "-",
    ),
  });
  return merge(
    object({
      configPath: optional(
        bindings.bindConfigPath(
          option(...valueOptionNames.configPath, string({ metavar: "FILE" }), {
            description: message`Read this TOML file. No configuration files are searched automatically.`,
          }),
        ),
      ),
    }),
    object({
      mode:
        mode === "schema"
          ? map(
              merge(
                object({
                  generateGraphqlSchema: flag("--generate-graphql-schema"),
                }),
                schema,
              ),
              (value) => ["schema", value] as const,
            )
          : conditional(
              map(
                flag("--generate-graphql-schema", {
                  description: message`Generate GraphQL schema and exit.`,
                }),
                () => "schema" as const,
              ),
              { schema },
              server,
            ),
    }),
  );
}

type RawOptions = InferValue<ReturnType<typeof createParser>>;
type RawServerOptions = Extract<
  RawOptions["mode"],
  readonly [undefined, unknown]
>[1];
export type SchemaGeneratorOptions = {
  readonly generateGraphqlSchema: true;
  readonly outputFile: string;
};

function required<T>(
  value: Sourced<T | undefined> | undefined,
  error: string,
): T {
  if (value?.value === undefined) throw new Error(error);
  return value.value;
}

function resolveLogging(raw: RawServerOptions["logging"], cwd: string) {
  const outputSetting = raw.output;
  if (outputSetting?.value === undefined) {
    throw new Error("Missing log output.");
  }
  const output = outputSetting.value;
  if (output.trim() === "") throw new Error("Log output path cannot be empty.");
  const formatter = raw.format?.value;
  const logOutput: LogOutput =
    output === "-"
      ? { type: "console", ...(formatter === undefined ? {} : { formatter }) }
      : {
          type: "file",
          path: configurationPath(outputSetting, cwd),
          ...(formatter === undefined ? {} : { formatter }),
        };
  return { logLevel: required(raw.level, "Missing log level."), logOutput };
}

function resolveMail(options: RawServerOptions) {
  const rank = { default: 0, config: 1, env: 2, cli: 3 };
  const explicit = options.mailTransport?.value;
  const smtp = options.smtpUrl?.value;
  const transportRank =
    options.mailTransport?.value === undefined
      ? -1
      : rank[options.mailTransport.source];
  const smtpRank =
    options.smtpUrl?.value === undefined ? -1 : rank[options.smtpUrl.source];
  const transport =
    smtpRank > transportRank
      ? "smtp"
      : (explicit ?? (smtp === undefined ? "logtape" : "smtp"));
  if (transport !== "logtape" && transport !== "smtp") {
    throw new Error("Unsupported mail transport; expected logtape or smtp.");
  }
  if (transport === "logtape") {
    if (smtp !== undefined && smtpRank === transportRank) {
      throw new Error("Mail selectors at the same source disagree.");
    }
    return undefined;
  }
  if (smtp === undefined) {
    throw new Error(
      "SMTP transport requires --smtp-url, DRFED_SMTP_URL or mail.smtp.url.",
    );
  }
  const parsed = url({ allowedProtocols: ["smtp:"] }).parse(smtp);
  if (!parsed.success) throw new Error("Invalid SMTP connection URL.");
  return parsed.value;
}

/**
 * Resolve domain constraints only after the source contexts have completed.
 * @returns Plain startup options; no database, mail or log sink is created.
 */
export function resolveOptions(options: RawOptions, cwd = process.cwd()) {
  if (options.mode[0] === "schema") {
    const schema: SchemaGeneratorOptions = {
      generateGraphqlSchema: true,
      outputFile: options.mode[1].outputFile,
    };
    return schema;
  }
  const server = options.mode[1];
  const logging = resolveLogging(server.logging, cwd);
  const root = required(
    server.rootOrigin,
    "Missing option --root-origin or server.root_origin (DRFED_ROOT_ORIGIN).",
  );
  const origins = required(
    server.loginOrigins,
    "Expected at least 1 values, but got only 0.",
  );
  if (origins.length === 0) {
    throw new Error("Expected at least 1 values, but got only 0.");
  }
  const loginOrigins = new Set<string>();
  for (const value of origins) {
    const parsed = origin({ allowedProtocols: ["http:", "https:"] }).parse(
      value,
    );
    if (!parsed.success) {
      throw new Error(
        "Invalid login origin; expected an HTTP or HTTPS origin.",
      );
    }
    loginOrigins.add(parsed.value.origin);
  }
  const database = resolveDatabaseSettings(
    {
      driver: server.databaseDriver,
      dataPath: server.dataPath,
      postgresUrl: server.postgresUrl,
    },
    cwd,
  );
  return {
    printConfig: server.printConfig,
    address: required(server.address, "Missing listen address."),
    rootOrigin: root,
    loginOrigins,
    emailFrom: server.emailFrom?.value,
    smtpUrl: resolveMail(server),
    seed: server.seed,
    logging,
    drizzle: {
      ...database.database,
      migrate: required(server.migrate, "Missing migration policy."),
      lockTimeoutMs: required(
        server.migrationLockTimeout,
        "Missing migration lock timeout.",
      ),
    },
    provenance: configurationProvenance({
      rootOrigin: server.rootOrigin,
      address: server.address,
      loginOrigins: server.loginOrigins,
      emailFrom: server.emailFrom,
      databaseDriver: server.databaseDriver,
      dataPath: server.dataPath,
      postgresUrl: server.postgresUrl,
      migrate: server.migrate,
      migrationLockTimeout: server.migrationLockTimeout,
      mailTransport: server.mailTransport,
      smtpUrl: server.smtpUrl,
      logLevel: server.logging.level,
      logFormat: server.logging.format,
      logOutput: server.logging.output,
    }),
    ignored: database.ignored,
  };
}

export type Options = ReturnType<typeof resolveOptions>;
export type ServerOptions = Exclude<
  Options,
  { generateGraphqlSchema: unknown }
>;
