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

import { textFormatter } from "@optique/logtape";

import {
  type ConfigurationArea,
  type ConfigurationSource,
  configurationProjection,
  configurationSettings,
} from "./configuration.ts";
import type { ServerOptions } from "./parser.ts";

/** A value and its provenance in safe configuration diagnostics. */
export interface ConfigurationDiagnosticSetting {
  readonly value: unknown;
  readonly source: ConfigurationSource;
  readonly configPath?: string;
}

/** Effective server settings with secret values redacted and unused fields named. */
export interface ServerConfigurationDiagnostic {
  readonly command: "server";
  readonly settings: Readonly<Record<string, ConfigurationDiagnosticSetting>>;
  readonly ignored: readonly (
    | { readonly field: string; readonly source: ConfigurationSource }
    | { readonly area: ConfigurationArea; readonly reason: string }
  )[];
}

/**
 * Describe effective server settings without runtime resources or secrets.
 * @returns JSON-serializable effective values, provenance and ignored settings.
 */
export function describeServerConfiguration(
  options: ServerOptions,
): ServerConfigurationDiagnostic {
  const { formatter } = options.logging.logOutput;
  const values = {
    rootOrigin: options.rootOrigin.origin,
    web: options.web,
    publicOrigin: options.publicOrigin?.origin,
    listen: options.address,
    loginOrigins: [...options.loginOrigins],
    emailFrom: options.emailFrom ?? `noreply@${options.rootOrigin.hostname}`,
    databaseDriver: options.drizzle.driver,
    dataPath:
      options.drizzle.driver === "pglite"
        ? options.drizzle.dataPath
        : undefined,
    postgresUrl:
      options.drizzle.driver === "postgres" ? "<redacted>" : undefined,
    migrate: options.drizzle.migrate,
    migrationLockTimeout: options.drizzle.lockTimeoutMs,

    logLevel: options.logging.logLevel,
    logFormat:
      formatter === undefined ? "default" : textFormatter().format(formatter),
    logOutput:
      options.logging.logOutput.type === "console"
        ? "-"
        : options.logging.logOutput.path,
  };
  const rank = { default: 0, config: 1, env: 2, cli: 3 };
  const highest = (...keys: string[]) =>
    keys
      .map((key) => options.provenance[key])
      .filter((value) => value !== undefined)
      .sort((left, right) => rank[right.source] - rank[left.source])[0];
  const selected = {
    databaseDriver: highest("databaseDriver", "dataPath", "postgresUrl"),
  };
  const provenanceKeys: Record<string, string> = { listen: "address" };
  const settings = Object.fromEntries(
    Object.entries(values)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        const definition =
          configurationSettings[key as keyof typeof configurationSettings];
        const provenanceKey = provenanceKeys[key] ?? key;
        const provenance = (key === "databaseDriver"
          ? selected[key]
          : options.provenance[provenanceKey]) ?? {
          source: "default" as const,
        };
        return [
          definition.toml,
          { value: definition.secret ? "<redacted>" : value, ...provenance },
        ];
      }),
  );
  return {
    command: "server",
    settings: { ...settings, ...options.mailDiagnostic },
    ignored: [
      ...options.ignored,
      ...configurationProjection(
        "server",
        options.web ? [] : ["web"],
      ).unusedAreas.map((area) => ({
        area,
        reason: "unused by this command",
      })),
    ],
  };
}
