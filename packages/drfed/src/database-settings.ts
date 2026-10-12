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

import { url } from "@optique/core/valueparser";
import { path } from "@optique/run/valueparser";

import {
  type ConfigurationSource,
  type Sourced,
  configurationPath,
} from "./configuration.ts";
import { defaultPgliteDataPath } from "./data-path.ts";
import { resolvePostgresConnection } from "./postgres-settings.ts";

const priority: Readonly<Record<ConfigurationSource, number>> = {
  default: 0,
  config: 1,
  env: 2,
  cli: 3,
};

type Input = Sourced<string | undefined> | undefined;

/** Explicit selectors for the database variant, retaining their sources. */
export interface DatabaseSettings {
  readonly dataPath?: Input;
  readonly postgresUrl?: Input;
}

function selectDatabaseKind(settings: DatabaseSettings) {
  const selectors = [settings.dataPath, settings.postgresUrl].filter(
    (value): value is Sourced<string> => value?.value !== undefined,
  );
  const highest = Math.max(
    0,
    ...selectors.map((value) => priority[value.source]),
  );
  const atHighest = (value: Input) =>
    value?.value !== undefined && priority[value.source] === highest;
  if (atHighest(settings.dataPath) && atHighest(settings.postgresUrl)) {
    throw new Error(
      "PGlite data path and PostgreSQL URL are mutually exclusive at the same source.",
    );
  }
  const driver = atHighest(settings.postgresUrl) ? "postgres" : "pglite";

  return driver;
}

/**
 * Select a database kind before validating branch-specific values.
 * @returns Plain runtime settings and metadata for ignored foreign fields.
 */
export function resolveDatabaseSettings(
  settings: DatabaseSettings,
  cwd = process.cwd(),
) {
  const driver = selectDatabaseKind(settings);
  const foreign =
    driver === "postgres" ? settings.dataPath : settings.postgresUrl;
  const ignored =
    foreign?.value === undefined
      ? []
      : [
          {
            field:
              driver === "postgres" ? "database.data_path" : "database.url",
            source: foreign.source,
          },
        ];
  if (driver === "postgres") {
    const value = settings.postgresUrl?.value;
    if (value === undefined) {
      throw new Error(
        "PostgreSQL requires --postgres-url, DRFED_POSTGRES_URL or database.url.",
      );
    }
    const parsed = url({
      allowedProtocols: ["postgres:", "postgresql:"],
    }).parse(value);
    if (!parsed.success) throw new Error("Invalid PostgreSQL connection URL.");
    resolvePostgresConnection(parsed.value);
    return {
      database: { driver: "postgres" as const, databaseUrl: parsed.value },
      ignored,
    };
  }
  if (settings.dataPath?.value === undefined) {
    return {
      database: {
        driver: "pglite" as const,
        dataPath: defaultPgliteDataPath(),
      },
      ignored,
    };
  }
  if (settings.dataPath.value.trim() === "") {
    throw new Error("PGlite data directory cannot be empty.");
  }
  const absolute = configurationPath(settings.dataPath, cwd);
  const parsed = path({ type: "directory" }).parse(absolute);
  if (!parsed.success) throw new Error("Invalid PGlite data directory.");
  return {
    database: { driver: "pglite" as const, dataPath: parsed.value },
    ignored,
  };
}
