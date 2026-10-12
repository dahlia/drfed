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

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ConfigurationSource, Sourced } from "@drfed/drfed/configuration";
import { defaultPgliteDataPath } from "@drfed/drfed/data-path";
import { resolveDatabaseSettings } from "@drfed/drfed/database-settings";

const workingDirectory = join(tmpdir(), "drfed-database-selector");
const configFile = join(tmpdir(), "drfed-settings", "drfed.toml");

const input = (
  value: string,
  source: ConfigurationSource,
): Sourced<string> => ({ value, source });

describe("database source selection", () => {
  it("selects CLI PostgreSQL over a TOML PGlite path", () => {
    const result = resolveDatabaseSettings({
      dataPath: input("data", "config"),
      postgresUrl: input("postgres://user@db/drfed", "cli"),
    });
    assert.equal(result.database.driver, "postgres");
    assert.deepEqual(result.ignored, [
      { field: "database.data_path", source: "config" },
    ]);
  });
  it("selects CLI PGlite without parsing a foreign lower-source URL", () => {
    const result = resolveDatabaseSettings(
      {
        dataPath: input("data", "cli"),
        postgresUrl: input("not a URL PRIVATE_TOKEN", "config"),
      },
      workingDirectory,
    );
    assert.deepEqual(result.database, {
      driver: "pglite",
      dataPath: join(workingDirectory, "data"),
    });
    assert.deepEqual(result.ignored, [
      { field: "database.url", source: "config" },
    ]);
    assert.ok(!JSON.stringify(result.ignored).includes("PRIVATE_TOKEN"));
  });
  it("rejects selectors that conflict at the winning source", () => {
    for (const source of ["cli", "env", "config"] as const) {
      assert.throws(
        () =>
          resolveDatabaseSettings({
            dataPath: input("data", source),
            postgresUrl: input("postgres://user@db/drfed", source),
          }),
        /same source/u,
      );
    }
  });
  it("defaults to PGlite only when neither selector is supplied", () => {
    assert.deepEqual(resolveDatabaseSettings({}).database, {
      driver: "pglite",
      dataPath: defaultPgliteDataPath(),
    });
  });
  it("fails invalid winning fields without exposing credentials", () => {
    assert.throws(
      () =>
        resolveDatabaseSettings({
          postgresUrl: input("postgres://user:PRIVATE_TOKEN@", "cli"),
          dataPath: input("data", "config"),
        }),
      /Invalid PostgreSQL connection URL/u,
    );
  });
  it("rejects empty selected paths before resolving against cwd or config", () => {
    for (const source of ["cli", "env", "config"] as const) {
      for (const value of ["", " ", "\t"]) {
        assert.throws(
          () =>
            resolveDatabaseSettings({
              dataPath: {
                value,
                source,
                ...(source === "config"
                  ? { configPath: join(tmpdir(), "drfed.toml") }
                  : {}),
              },
            }),
          /cannot be empty/u,
        );
      }
    }
  });

  it("resolves a selected TOML path relative to its file", () => {
    const result = resolveDatabaseSettings(
      {
        dataPath: {
          value: "data",
          source: "config",
          configPath: configFile,
        },
      },
      workingDirectory,
    );
    assert.deepEqual(result.database, {
      driver: "pglite",
      dataPath: join(tmpdir(), "drfed-settings", "data"),
    });
  });
});
