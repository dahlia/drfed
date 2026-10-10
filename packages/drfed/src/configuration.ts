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

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  type ConfigMeta,
  bindConfig,
  createConfigContext,
} from "@optique/config";
import { message } from "@optique/core/message";
import { map } from "@optique/core/modifiers";
import type { Parser } from "@optique/core/parser";
import { type ValueParser, string, transform } from "@optique/core/valueparser";
import { bindEnv, bool, createEnvContext } from "@optique/env";
import { parse as parseToml } from "smol-toml";
import * as v from "valibot";

/** The source that supplied a setting, before runtime resources are created. */
export type ConfigurationSource = "cli" | "env" | "config" | "default";

/** A parsed value with its source, including the selected TOML file. */
export interface Sourced<T> {
  readonly value: T;
  readonly source: ConfigurationSource;
  readonly configPath?: string;
}

const text = v.string("Expected a string.");
const boolean = v.boolean("Expected a Boolean.");
const texts = v.array(text, "Expected an array of strings.");
const table = <T extends v.ObjectEntries>(entries: T) =>
  v.strictObject(entries, "Unknown setting or invalid table.");

/** Structural validation applies to every section, including unused ones. */
export const configurationSchema = table({
  server: v.optional(
    table({
      root_origin: v.optional(text),
      listen: v.optional(text),
      login_origins: v.optional(texts),
      web: v.optional(boolean),
    }),
  ),
  web: v.optional(
    table({
      public_origin: v.optional(text),
      listen: v.optional(text),
      backend_url: v.optional(text),
    }),
  ),
  database: v.optional(
    table({
      driver: v.optional(text),
      data_path: v.optional(text),
      url: v.optional(text),
      migrate: v.optional(boolean),
    }),
  ),
  mail: v.optional(
    table({
      from: v.optional(text),
      transport: v.optional(text),
      smtp: v.optional(table({ url: v.optional(text) })),
    }),
  ),
});

export type ConfigurationFile = v.InferOutput<typeof configurationSchema>;
export type ConfigurationArea = keyof ConfigurationFile;
export type ConfigurationCommand = "server" | "web" | "migrate" | "account";

/** Shared metadata used by bindings and, later, command documentation. */
export interface ConfigurationSetting<T> {
  readonly toml: string;
  readonly env: string;
  readonly secret: boolean;
  readonly commands: readonly ConfigurationCommand[];
  readonly description: string;
  readonly read: (config: ConfigurationFile) => T | undefined;
}

function setting<T>(
  toml: string,
  env: string,
  commands: readonly ConfigurationCommand[],
  description: string,
  read: (config: ConfigurationFile) => T | undefined,
  secret = false,
): ConfigurationSetting<T> {
  return { toml, env, commands, description, read, secret };
}

/** One registry shared by all DrFed command projections. */
export const configurationSettings = {
  rootOrigin: setting(
    "server.root_origin",
    "ROOT_ORIGIN",
    ["server"],
    "Root origin",
    (config) => config.server?.root_origin,
  ),
  listen: setting(
    "server.listen",
    "LISTEN",
    ["server"],
    "Server listen address",
    (config) => config.server?.listen,
  ),
  loginOrigins: setting(
    "server.login_origins",
    "LOGIN_ORIGINS",
    ["server"],
    "Allowed login origins",
    (config) => config.server?.login_origins,
  ),
  web: setting(
    "server.web",
    "WEB",
    ["server"],
    "Serve the web frontend",
    (config) => config.server?.web,
  ),
  publicOrigin: setting(
    "web.public_origin",
    "PUBLIC_ORIGIN",
    ["server", "web"],
    "Public web origin",
    (config) => config.web?.public_origin,
  ),
  webListen: setting(
    "web.listen",
    "WEB_LISTEN",
    ["web"],
    "Web listen address",
    (config) => config.web?.listen,
  ),
  backendUrl: setting(
    "web.backend_url",
    "BACKEND_URL",
    ["web"],
    "Backend URL",
    (config) => config.web?.backend_url,
  ),
  databaseDriver: setting(
    "database.driver",
    "DATABASE_DRIVER",
    ["server", "migrate", "account"],
    "Database driver",
    (config) => config.database?.driver,
  ),
  dataPath: setting(
    "database.data_path",
    "DATA_PATH",
    ["server", "migrate", "account"],
    "PGlite data directory",
    (config) => config.database?.data_path,
  ),
  postgresUrl: setting(
    "database.url",
    "POSTGRES_URL",
    ["server", "migrate", "account"],
    "PostgreSQL connection URL",
    (config) => config.database?.url,
    true,
  ),
  migrate: setting(
    "database.migrate",
    "MIGRATE",
    ["server"],
    "Apply migrations at startup",
    (config) => config.database?.migrate,
  ),
  emailFrom: setting(
    "mail.from",
    "EMAIL_FROM",
    ["server"],
    "Login mail sender",
    (config) => config.mail?.from,
  ),
  mailTransport: setting(
    "mail.transport",
    "MAIL_TRANSPORT",
    ["server"],
    "Mail transport",
    (config) => config.mail?.transport,
  ),
  smtpUrl: setting(
    "mail.smtp.url",
    "SMTP_URL",
    ["server"],
    "SMTP connection URL",
    (config) => config.mail?.smtp?.url,
    true,
  ),
} as const;

/**
 * Parse TOML without including its contents or secret values in errors.
 * @returns Structurally valid settings; unused domains remain unparsed.
 */
export function decodeConfiguration(contents: string): ConfigurationFile {
  let raw: unknown;
  try {
    raw = parseToml(contents, { unsafeKeyBehaviour: "throw" });
  } catch {
    throw new Error("Invalid TOML configuration.");
  }
  const parsed = v.safeParse(configurationSchema, raw);
  if (!parsed.success) {
    const paths = parsed.issues.map(
      (issue) =>
        issue.path?.map((item) => String(item.key)).join(".") ??
        "configuration",
    );
    throw new Error(`Invalid configuration structure at ${paths.join(", ")}.`);
  }
  return parsed.output;
}

/**
 * Resolve a path using its own source directory.
 * @returns An absolute path.
 */
export function configurationPath(
  value: Sourced<string | undefined>,
  cwd = process.cwd(),
): string {
  if (value.value === undefined) {
    throw new Error("No path setting was supplied.");
  }
  return resolve(
    value.configPath == null ? cwd : dirname(value.configPath),
    value.value,
  );
}

/**
 * Extract provenance without copying values, including credentials.
 * @returns Source metadata keyed by the provided setting names.
 */
export function configurationProvenance(
  values: Readonly<Record<string, Sourced<unknown> | undefined>>,
) {
  return Object.fromEntries(
    Object.entries(values)
      .filter(
        (entry): entry is [string, Sourced<unknown>] =>
          entry[1] !== undefined && entry[1].value !== undefined,
      )
      .map(([key, value]) => [
        key,
        {
          source: value.source,
          ...(value.configPath === undefined
            ? {}
            : { configPath: value.configPath }),
        },
      ]),
  );
}

/**
 * Create independent contexts for one parse. Environment lookup remains lazy;
 * only the fields bound by the command are consumed. No .env file is loaded.
 * @returns Bindings, independent contexts, and a strict explicit-file loader.
 */
export function createConfigurationBindings(
  options: {
    readonly env?: (name: string) => string | undefined;
    readonly cwd?: string;
  } = {},
) {
  const cwd = options.cwd ?? process.cwd();
  const envContext = createEnvContext({
    prefix: "DRFED_",
    ...(options.env === undefined ? {} : { source: options.env }),
  });
  const configContext = createConfigContext({ schema: configurationSchema });

  function bind<T, TState, TRaw>(
    cli: Parser<"sync", T, TState>,
    definition: ConfigurationSetting<TRaw>,
    valueParser: ValueParser<"sync", T>,
    encode: (value: TRaw) => string,
    defaultValue?: T,
  ) {
    // Map the whole CLI parser. Mapping its value parser instead loses the
    // source tag when Optique re-validates an env/config fallback as CLI data.
    const tagged = map(
      cli,
      (value): Sourced<T | undefined> => ({ value, source: "cli" }),
    );
    // This adapter changes only our fresh mapped parser, not the caller's
    // parser or its value parser. Parsing and completion both carry errors.
    if (definition.secret) {
      const parseCli = tagged.parse.bind(tagged);
      tagged.parse = (context) => {
        const result = parseCli(context);
        return result.success
          ? result
          : { ...result, error: message`Invalid setting ${definition.toml}.` };
      };
      const completeCli = tagged.complete.bind(tagged);
      tagged.complete = (state, exec) => {
        const result = completeCli(state, exec);
        return result.success
          ? result
          : { ...result, error: message`Invalid setting ${definition.toml}.` };
      };
    }
    // map() cannot infer how to turn a tagged default back into a CLI value.
    // Supply it explicitly; secret defaults never appear in help output.
    tagged.getDocFragments = (state) =>
      cli.getDocFragments(state, definition.secret ? undefined : defaultValue);
    const envValueParser: ValueParser<"sync", T> = {
      ...valueParser,
      parse(input) {
        const parsed = valueParser.parse(input);
        return !parsed.success && definition.secret
          ? {
              success: false,
              error: message`Invalid setting ${definition.toml}.`,
            }
          : parsed;
      },
    };
    const bound = bindEnv(
      bindConfig(tagged, {
        context: configContext,
        key: (config, meta): Sourced<T | undefined> | undefined => {
          const value = definition.read(config);
          if (value === undefined) return undefined;
          const parsed = valueParser.parse(encode(value));
          if (!parsed.success) {
            throw new Error(`Invalid setting ${definition.toml}.`);
          }
          return {
            value: parsed.value,
            source: "config",
            ...(meta == null ? {} : { configPath: meta.configPath }),
          };
        },
        // An object sentinel keeps absence distinct from a binding failure.
        // optional(bindEnv(...)) would swallow an invalid environment value.
        default: { value: defaultValue, source: "default" as const },
      }),
      {
        context: envContext,
        key: definition.env,
        parser: transform(envValueParser, {
          map: (value): Sourced<T | undefined> => ({ value, source: "env" }),
          unmap: (value) => {
            if (value.value === undefined) {
              throw new TypeError("Cannot format an absent setting.");
            }
            return value.value;
          },
        }),
      },
    );
    return bound;
  }

  const configPathParser = transform(string({ metavar: "FILE" }), {
    map: (value): Sourced<string> => ({
      value: resolve(cwd, value),
      source: "env",
    }),
    unmap: (value) => value.value,
  });

  function bindConfigPath<TState>(cli: Parser<"sync", string, TState>) {
    return bindEnv(
      map(
        cli,
        (value): Sourced<string> => ({
          value: resolve(cwd, value),
          source: "cli",
        }),
      ),
      {
        context: envContext,
        key: "CONFIG",
        parser: configPathParser,
      },
    );
  }

  async function load(parsed: {
    readonly configPath?: Sourced<string>;
  }): Promise<{ config: ConfigurationFile; meta: ConfigMeta } | undefined> {
    if (parsed.configPath === undefined) return undefined;
    const configPath = parsed.configPath.value;
    let contents: string;
    try {
      contents = await readFile(configPath, "utf8");
    } catch {
      throw new Error(`Cannot read configuration file ${configPath}.`);
    }
    return {
      config: decodeConfiguration(contents),
      meta: { configPath, configDir: dirname(configPath) },
    };
  }

  return {
    bind,
    bindConfigPath,
    load,
    contexts: [envContext, configContext] as const,
  };
}

/**
 * Value parser for JSON string arrays, including the empty array.
 * @returns A synchronous value parser.
 */
export function stringArray(): ValueParser<"sync", string[]> {
  return {
    mode: "sync",
    metavar: "JSON_ARRAY",
    placeholder: [],
    parse(input) {
      let value: unknown;
      try {
        value = JSON.parse(input);
      } catch {
        return {
          success: false,
          error: message`Expected a JSON string array.`,
        };
      }
      if (
        !Array.isArray(value) ||
        !value.every((item) => typeof item === "string")
      ) {
        return {
          success: false,
          error: message`Expected a JSON string array.`,
        };
      }
      return { success: true, value };
    },
    format: JSON.stringify,
  };
}

/** Environment and TOML Boolean spelling, shared with Optique. */
export const configurationBoolean = bool;
