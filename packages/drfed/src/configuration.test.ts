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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  configurationBoolean,
  configurationPath,
  configurationProjection,
  configurationProvenance,
  configurationSettings,
  createConfigurationBindings,
  decodeConfiguration,
  stringArray,
} from "@drfed/drfed/configuration";
import { object } from "@optique/core/constructs";
import { multiple, optional } from "@optique/core/modifiers";
import { option } from "@optique/core/primitives";
import { string, url } from "@optique/core/valueparser";
import { run } from "@optique/run";

async function fixture<T>(operation: (directory: string) => Promise<T>) {
  const directory = await mkdtemp(join(tmpdir(), "drfed-config-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function makeParser(env: Record<string, string>, cwd: string) {
  const bindings = createConfigurationBindings({
    env: (name) => env[name],
    cwd,
  });
  const parser = object({
    configPath: optional(bindings.bindConfigPath(option("--config", string()))),
    listen: bindings.bind(
      option("--listen", string()),
      configurationSettings.listen,
      string(),
      (value) => value,
      "localhost:8888",
    ),
    migrate: bindings.bind(
      option("--migrate", configurationBoolean()),
      configurationSettings.migrate,
      configurationBoolean(),
      String,
      true,
    ),
    dataPath: bindings.bind(
      option("--data-path", string()),
      configurationSettings.dataPath,
      string(),
      (value) => value,
    ),
    loginOrigins: bindings.bind(
      multiple(option("--login-origin", string()), { min: 1 }),
      configurationSettings.loginOrigins,
      stringArray(),
      JSON.stringify,
    ),
  });
  return { parser, bindings };
}

async function parse(args: string[], env: Record<string, string>, cwd: string) {
  const { parser, bindings } = makeParser(env, cwd);
  return await run(parser, {
    args,
    contexts: bindings.contexts,
    contextOptions: { load: bindings.load },
    colors: false,
    maxWidth: 80,
    stderr: () => undefined,
    onExit(code): never {
      throw new Error(`CLI exit ${code}`);
    },
  });
}

describe("shared configuration bindings", () => {
  it("preserves CLI > env > TOML > default and false values", async () => {
    await fixture(async (directory) => {
      await writeFile(
        join(directory, "drfed.toml"),
        '[server]\nlisten = "config:8888"\n[database]\nmigrate = false\n',
      );
      const config = await parse(["--config", "drfed.toml"], {}, directory);
      assert.deepEqual(config.listen, {
        value: "config:8888",
        source: "config",
        configPath: join(directory, "drfed.toml"),
      });
      assert.equal(config.migrate?.value, false);
      assert.equal(config.migrate?.source, "config");
      const env = await parse(
        ["--config", "drfed.toml"],
        { DRFED_LISTEN: "env:8888", DRFED_MIGRATE: "false" },
        directory,
      );
      assert.deepEqual(env.listen, { value: "env:8888", source: "env" });
      assert.deepEqual(env.migrate, { value: false, source: "env" });
      const cli = await parse(
        ["--config", "drfed.toml", "--listen", "cli:8888", "--migrate", "true"],
        { DRFED_LISTEN: "env:8888", DRFED_MIGRATE: "false" },
        directory,
      );
      assert.deepEqual(cli.listen, { value: "cli:8888", source: "cli" });
      assert.deepEqual(cli.migrate, { value: true, source: "cli" });
      const defaults = await parse([], {}, directory);
      assert.deepEqual(defaults.listen, {
        value: "localhost:8888",
        source: "default",
      });
      assert.deepEqual(defaults.migrate, { value: true, source: "default" });
      assert.equal(defaults.dataPath?.value, undefined);
    });
  });

  it("replaces arrays by source instead of appending", async () => {
    await fixture(async (directory) => {
      await writeFile(
        join(directory, "drfed.toml"),
        '[server]\nlogin_origins = ["https://config.example"]\n',
      );
      const env = {
        DRFED_CONFIG: "drfed.toml",
        DRFED_LOGIN_ORIGINS: '["https://env.example"]',
      };
      const result = await parse(
        [
          "--login-origin",
          "https://one.example",
          "--login-origin",
          "https://two.example",
        ],
        env,
        directory,
      );
      assert.deepEqual(result.loginOrigins, {
        value: ["https://one.example", "https://two.example"],
        source: "cli",
      });
      assert.deepEqual((await parse([], env, directory)).loginOrigins, {
        value: ["https://env.example"],
        source: "env",
      });
      assert.deepEqual(
        (await parse([], { ...env, DRFED_LOGIN_ORIGINS: "[]" }, directory))
          .loginOrigins,
        { value: [], source: "env" },
      );
    });
  });

  it("selects the explicit CLI file ahead of DRFED_CONFIG", async () => {
    await fixture(async (directory) => {
      await writeFile(
        join(directory, "cli.toml"),
        '[server]\nlisten = "cli-file:8888"\n',
      );
      const result = await parse(
        ["--config", "cli.toml"],
        { DRFED_CONFIG: "missing.toml" },
        directory,
      );
      assert.equal(result.listen?.value, "cli-file:8888");
      assert.equal(result.configPath?.source, "cli");
      await assert.rejects(
        parse([], { DRFED_CONFIG: "missing.toml" }, directory),
        /Cannot read configuration file/u,
      );
    });
  });

  it("resolves each path against its source directory", async () => {
    await fixture(async (directory) => {
      await writeFile(
        join(directory, "drfed.toml"),
        '[database]\ndata_path = "data"\n',
      );
      const result = await parse(["--config", "drfed.toml"], {}, directory);
      assert.ok(result.dataPath);
      assert.equal(
        configurationPath(result.dataPath, "/unrelated"),
        join(directory, "data"),
      );
      assert.equal(
        configurationPath({ value: "data", source: "cli" }, directory),
        join(directory, "data"),
      );
      assert.equal(
        configurationPath({ value: "data", source: "env" }, directory),
        join(directory, "data"),
      );
    });
  });

  it("validates unused TOML structure without consuming unused env", async () => {
    await fixture(async (directory) => {
      await writeFile(
        join(directory, "drfed.toml"),
        '[web]\nbackend_url = "not a URL"\n[mail]\ntransport = "future-provider"\n',
      );
      const result = await parse(
        ["--config", "drfed.toml"],
        { DRFED_POSTGRES_URL: "bad", DRFED_SMTP_URL: "bad" },
        directory,
      );
      assert.equal(result.listen?.source, "default");
      assert.throws(
        () => decodeConfiguration("[web]\nlisten = 123"),
        /Invalid configuration structure/u,
      );
      assert.throws(
        () => decodeConfiguration('[server]\nlistne = "typo"'),
        /Invalid configuration structure/u,
      );
    });
  });

  it("ignores configuration files and env during genuine help/version", async () => {
    const bindings = createConfigurationBindings({
      env: () => {
        throw new Error("ENV_READ");
      },
    });
    const parser = object({
      configPath: optional(
        bindings.bindConfigPath(option("--config", string())),
      ),
    });
    for (const args of [["--help"], ["--version"]]) {
      // Runner callbacks deliberately terminate one invocation at a time.
      // oxlint-disable-next-line no-await-in-loop
      await assert.rejects(
        async () =>
          await run(parser, {
            args,
            contexts: bindings.contexts,
            contextOptions: {
              load: () => {
                throw new Error("CONFIG_READ");
              },
            },
            help: "option",
            version: "0.1.0",
            stdout: () => undefined,
            stderr: () => undefined,
            colors: false,
            maxWidth: 80,
            onExit(code): never {
              throw new Error(`EARLY_EXIT_${code}`);
            },
          }),
        /EARLY_EXIT_0/u,
      );
    }
  });

  it("rejects duplicate keys, unsafe keys and secrets without echoing values", () => {
    assert.throws(
      () => decodeConfiguration('[server]\nlisten = "a"\nlisten = "b"'),
      /Invalid TOML/u,
    );
    assert.throws(
      () => decodeConfiguration("__proto__.polluted = true"),
      /Invalid TOML/u,
    );
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
    // Node:assert receives an error predicate, not an async callback.
    // oxlint-disable-next-line promise/prefer-await-to-callbacks
    assert.throws(
      () => decodeConfiguration('[mail]\nfrom = ["PRIVATE_TOKEN"]'),
      // Node:assert calls this error predicate synchronously.
      // oxlint-disable-next-line promise/prefer-await-to-callbacks
      (error) =>
        error instanceof Error && !error.message.includes("PRIVATE_TOKEN"),
    );
    const provenance = configurationProvenance({
      secret: {
        value: "PRIVATE_TOKEN",
        source: "config",
        configPath: "/etc/drfed.toml",
      },
      absent: undefined,
    });
    assert.deepEqual(provenance, {
      secret: { source: "config", configPath: "/etc/drfed.toml" },
    });
    assert.ok(!JSON.stringify(provenance).includes("PRIVATE_TOKEN"));
  });

  it("redacts secret-bearing CLI and env errors", async () => {
    for (const source of ["cli", "env"] as const) {
      const privateUrl = "postgres://user:PRIVATE_TOKEN@";
      const bindings = createConfigurationBindings({
        env: (name) =>
          name === "DRFED_POSTGRES_URL" && source === "env"
            ? privateUrl
            : undefined,
      });
      const valueParser = url({
        allowedProtocols: ["postgres:", "postgresql:"],
      });
      const parser = object({
        postgres: bindings.bind(
          option("--postgres-url", valueParser),
          configurationSettings.postgresUrl,
          valueParser,
          (value) => value,
        ),
      });
      let output = "";
      // Test runner exits sequentially so each diagnostic has its own capture.
      // oxlint-disable-next-line no-await-in-loop
      await assert.rejects(
        async () =>
          await run(parser, {
            args: source === "cli" ? ["--postgres-url", privateUrl] : [],
            contexts: bindings.contexts,
            contextOptions: { load: () => undefined },
            colors: false,
            maxWidth: 80,
            stderr: (value) => {
              output += value;
            },
            onExit(code): never {
              throw new Error(`CLI exit ${code}`);
            },
          }),
        /CLI exit 1/u,
      );
      assert.match(output, /Invalid setting "?database\.url"?/u);
      assert.ok(!output.includes("PRIVATE_TOKEN"));
    }
  });

  it("documents non-secret defaults without exposing secret defaults", async () => {
    const bindings = createConfigurationBindings({ env: () => undefined });
    const parser = object({
      listen: bindings.bind(
        option("--listen", string()),
        configurationSettings.listen,
        string(),
        (value) => value,
        "localhost:8888",
      ),
      postgres: bindings.bind(
        option("--postgres-url", string()),
        configurationSettings.postgresUrl,
        string(),
        (value) => value,
        "postgres://user:PRIVATE_TOKEN@db/test",
      ),
    });
    let output = "";
    await assert.rejects(
      async () =>
        await run(parser, {
          args: ["--help"],
          contexts: bindings.contexts,
          contextOptions: { load: () => undefined },
          help: "option",
          showDefault: true,
          colors: false,
          maxWidth: 80,
          stdout: (value) => {
            output += value;
          },
          onExit(code): never {
            throw new Error(`EARLY_EXIT_${code}`);
          },
        }),
      /EARLY_EXIT_0/u,
    );
    assert.ok(output.includes("localhost:8888"));
    assert.ok(!output.includes("PRIVATE_TOKEN"));
  });

  it("rejects invalid env instead of falling back to TOML", async () => {
    await fixture(async (directory) => {
      await writeFile(
        join(directory, "drfed.toml"),
        "[database]\nmigrate = true\n",
      );
      await assert.rejects(
        parse(
          ["--config", "drfed.toml"],
          { DRFED_MIGRATE: "maybe" },
          directory,
        ),
        /CLI exit 1/u,
      );
      await assert.rejects(
        parse([], { DRFED_LOGIN_ORIGINS: '"not an array"' }, directory),
        /CLI exit 1/u,
      );
    });
  });
});

describe("command configuration projections", () => {
  it("keeps database-only commands independent of server, mail and telemetry", () => {
    for (const command of ["migrate", "account"] as const) {
      const projection = configurationProjection(command);
      assert.deepEqual(projection.areas, ["database"]);
      assert.deepEqual(
        projection.settings.map((entry) => entry.toml),
        ["database.data_path", "database.url", "database.lock_timeout_ms"],
      );
      assert.ok(projection.unusedAreas.includes("mail"));
      assert.ok(projection.unusedAreas.includes("telemetry"));
    }
  });
  it("separates standalone web settings and backend-only mode", () => {
    const web = configurationProjection("web");
    assert.deepEqual(new Set(web.areas), new Set(["web", "telemetry"]));
    assert.ok(web.settings.some((entry) => entry.env === "WEB_LISTEN"));
    assert.ok(!web.settings.some((entry) => entry.env === "LISTEN"));
    assert.ok(!web.settings.some((entry) => entry.secret));
    const backend = configurationProjection("server", ["web"]);
    assert.ok(backend.unusedAreas.includes("web"));
    assert.ok(!backend.settings.some((entry) => entry.toml.startsWith("web.")));
  });
});
