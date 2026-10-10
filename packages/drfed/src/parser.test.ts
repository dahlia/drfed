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
import { execFile } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, it } from "@logtape/testing-node/autoload";

const execFileAsync = promisify(execFile);

const commandTimeout = 30_000;

// Exercise the built command so parser and startup behavior stay aligned with
// what installed users receive.
const binary = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "drfed-server.mjs",
);

async function run(
  args: readonly string[],
  preload?: string,
  environment: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        ...(preload == null ? [] : ["--import", pathToFileURL(preload).href]),
        binary,
        ...args,
      ],
      {
        // A deliberately minimal environment, independent of what the
        // developer happens to have exported.
        env: { PATH: process.env.PATH ?? "", ...environment },
        timeout: commandTimeout,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (e) {
    const error = e as { code?: number; stdout?: string; stderr?: string };
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

async function writeResourceGuard(preload: string): Promise<void> {
  await writeFile(
    preload,
    `
      import { registerHooks } from "node:module";
      const constructors = new Map([
        ["@electric-sql/pglite", "PGlite"],
        ["postgres", "default"],
        ["@upyo/smtp", "SmtpTransport"],
        ["@upyo/logtape", "LogTapeTransport"],
      ]);
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const resolved = nextResolve(specifier, context);
          const name = constructors.get(specifier);
          if (name == null) return resolved;
          const target = JSON.stringify(resolved.url);
          const source = name === "default"
            ? "export * from " + target + "; export default function () { throw new Error('EARLY_RESOURCE_CONSTRUCTION'); }"
            : "export * from " + target + ";" +
            "import { " + name + " as Original } from " + target + ";" +
            "export class " + name + " extends Original {" +
            "constructor() { throw new Error('EARLY_RESOURCE_CONSTRUCTION'); } }";
          return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
        },
      });
    `,
  );
}

describe("drfed-server", () => {
  it("requires --root-origin to serve", async () => {
    const { code, stderr } = await run(["--data-path", "/nonexistent-drfed"]);

    assert.notEqual(code, 0);
    assert.match(stderr, /Missing option .*--root-origin/u);
  });

  it("documents --root-origin as configurable in its help", async () => {
    const { code, stdout } = await run(["--help"]);
    assert.equal(code, 0);
    // The value is required, but its CLI spelling is optional because it
    // can be supplied by the shared file or environment.
    assert.match(stdout, /--root-origin\/-r ORIGIN/u);
    assert.match(stdout, /\[--root-origin/u);
  });

  it("no longer accepts the old --root-domain option", async () => {
    // If the retired option were reinstated, parsing would instead stop on
    // the missing --login-origin, which says something else entirely.
    const dataPath = await mkdtemp(join(tmpdir(), "drfed-parser-test-"));
    try {
      const { code, stderr } = await run([
        "--data-path",
        dataPath,
        "--root-origin=https://drfed.net",
        "--root-domain=drfed.net",
      ]);
      assert.notEqual(code, 0);
      // The message names the offending token, so this cannot pass for some
      // other reason.
      assert.match(stderr, /Unexpected option or argument: "--root-domain/u);
    } finally {
      await rm(dataPath, { force: true, recursive: true });
    }
  });

  it("rejects a root origin that names an IP address", async () => {
    const { code, stderr } = await run([
      "--data-path",
      "/nonexistent-drfed",
      "--root-origin=http://127.0.0.1:8888",
    ]);
    assert.notEqual(code, 0);
    assert.match(stderr, /IP address/u);
  });

  it("accepts --email-from and rejects a malformed address", async () => {
    const dataPath = await mkdtemp(join(tmpdir(), "drfed-parser-test-"));
    try {
      // Valid: parsing gets past the option and stops only on the missing
      // required --login-origin option.
      const accepted = await run([
        "--data-path",
        dataPath,
        "--root-origin=https://drfed.net",
        "--email-from=postmaster@mail.example",
      ]);
      assert.notEqual(accepted.code, 0);
      assert.match(
        accepted.stderr,
        /Expected at least 1 values, but got only 0\./u,
      );

      const rejected = await run([
        "--data-path",
        dataPath,
        "--root-origin=https://drfed.net",
        "--login-origin=https://drfed.net",
        "--email-from=not-an-address",
      ]);
      assert.notEqual(rejected.code, 0);
      assert.match(rejected.stderr, /Expected a valid email address/u);
    } finally {
      await rm(dataPath, { force: true, recursive: true });
    }
  });

  it("generates the GraphQL schema without a root origin", async () => {
    // Schema generation is the other branch of the parser and must stay
    // usable without any deployment configuration.
    const { code, stdout } = await run([
      "--generate-graphql-schema",
      "--output-file",
      "-",
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /type Query/u);
  });
  it("keeps help, version, schema and parse failures resource-free", async () => {
    const parent = await mkdtemp(join(tmpdir(), "drfed-pure-cli-"));
    const dataPath = join(parent, "must-not-exist");
    const preload = join(parent, "reject-resources.mjs");
    try {
      await writeResourceGuard(preload);

      const base = [
        "--root-origin=http://drfed.test",
        "--login-origin=http://drfed.test",
        "--smtp-url=smtp://localhost:25",
      ];
      // Both database branches must stay resource-free through early exits.
      for (const database of [
        `--data-path=${dataPath}`,
        "--database-url=postgres://localhost/drfed",
      ]) {
        for (const suffix of [
          ["--help"],
          ["--version"],
          ["--unknown-option"],
        ]) {
          // oxlint-disable-next-line no-await-in-loop
          const result = await run([...base, database, ...suffix], preload);
          assert.equal(
            result.code,
            suffix[0] === "--unknown-option" ? 1 : 0,
            result.stderr,
          );
          // oxlint-disable-next-line no-await-in-loop
          await assert.rejects(access(dataPath), { code: "ENOENT" });
          assert.doesNotMatch(result.stderr, /EARLY_RESOURCE_CONSTRUCTION/u);
        }
      }
      const schema = await run(["--generate-graphql-schema"], preload);
      assert.equal(schema.code, 0, schema.stderr);
      assert.match(schema.stdout, /type Query/u);
      const configPath = join(parent, "drfed.toml");
      await writeFile(
        configPath,
        [
          "[server]",
          'root_origin = "http://drfed.test"',
          'login_origins = ["http://drfed.test"]',
          "[database]",
          `data_path = ${JSON.stringify(dataPath.replaceAll("\\", "/"))}`,
        ].join("\n"),
      );
      for (const [args, environment] of [
        [
          ["--config", configPath],
          { DRFED_CONFIG: join(parent, "absent.toml") },
        ],
        [[], { DRFED_CONFIG: configPath }],
      ] as const) {
        // oxlint-disable-next-line no-await-in-loop
        const configured = await run(args, preload, environment);
        assert.equal(configured.code, 1, configured.stderr);
        assert.match(configured.stderr, /EARLY_RESOURCE_CONSTRUCTION/u);
        // oxlint-disable-next-line no-await-in-loop
        await assert.rejects(access(dataPath), { code: "ENOENT" });
      }
      for (const early of [
        "--help",
        "--version",
        "--generate-graphql-schema",
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        const result = await run(
          [early, "--config", join(parent, "absent.toml")],
          preload,
        );
        assert.equal(result.code, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /EARLY_RESOURCE_CONSTRUCTION/u);
      }
      await writeFile(configPath, '[server]\nroot_orgin = "SECRET_VALUE"');
      const invalidConfig = await run(["--config", configPath], preload);
      assert.equal(invalidConfig.code, 1);
      assert.doesNotMatch(
        invalidConfig.stderr,
        /EARLY_RESOURCE_CONSTRUCTION|SECRET_VALUE/u,
      );
      await assert.rejects(access(dataPath), { code: "ENOENT" });
      const logPath = join(parent, "must-not-exist.log");
      const schemaWithLog = await run(
        ["--generate-graphql-schema", "--log-output", logPath],
        preload,
      );
      assert.equal(schemaWithLog.code, 0, schemaWithLog.stderr);
      await assert.rejects(access(logPath), { code: "ENOENT" });
      const badLogPath = join(parent, "absent-directory", "output.log");
      const loggingFailure = await run(
        [...base, `--data-path=${dataPath}`, "--log-output", badLogPath],
        preload,
      );
      assert.equal(loggingFailure.code, 1);
      assert.match(loggingFailure.stderr, /Could not initialize logging/u);
      assert.doesNotMatch(
        loggingFailure.stderr,
        /EARLY_RESOURCE_CONSTRUCTION|at .*index.mjs/u,
      );
      await assert.rejects(access(dataPath), { code: "ENOENT" });
      const startup = await run([...base, `--data-path=${dataPath}`], preload);
      assert.equal(startup.code, 1);
      assert.match(startup.stderr, /EARLY_RESOURCE_CONSTRUCTION/u);
      await assert.rejects(access(dataPath), { code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
  it("prints selected configuration with redacted secrets and no resources", async () => {
    const parent = await mkdtemp(join(tmpdir(), "drfed-diagnostic-"));
    const config = join(parent, "drfed.toml");
    const preload = join(parent, "reject-resources.mjs");
    const dataPath = join(parent, "must-not-exist");
    const logPath = join(parent, "must-not-exist.log");
    try {
      await writeResourceGuard(preload);
      await writeFile(
        config,
        [
          "[server]",
          'root_origin = "http://drfed.test"',
          'login_origins = ["http://config.test"]',
          "[database]",
          'data_path = "must-not-exist"',
          "[mail]",
          'transport = "logtape"',
          "[web]",
          'backend_url = "invalid but unused"',
          "[telemetry]",
          'log_output = "must-not-exist.log"',
        ].join("\n"),
      );
      const result = await run(
        [
          "--print-config",
          "--config",
          config,
          "--login-origin",
          "http://cli.test/",
          "--postgres-url",
          "postgres://PRIVATE_USER:PRIVATE_PASSWORD@localhost/drfed",
          "--smtp-url",
          "smtp://PRIVATE_USER:SMTP_PASSWORD@localhost:25",
        ],
        preload,
        {
          DRFED_LOGIN_ORIGINS: '["http://env.test"]',
          DRFED_BACKEND_URL: "invalid and unused",
        },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /PRIVATE_USER|PRIVATE_PASSWORD|SMTP_PASSWORD|EARLY_RESOURCE_CONSTRUCTION/u,
      );
      const diagnostic = JSON.parse(result.stdout);
      assert.equal(diagnostic.command, "server");
      assert.deepEqual(diagnostic.settings["server.login_origins"], {
        value: ["http://cli.test"],
        source: "cli",
      });
      assert.deepEqual(diagnostic.settings["database.driver"], {
        value: "postgres",
        source: "cli",
      });
      assert.deepEqual(diagnostic.settings["database.url"], {
        value: "<redacted>",
        source: "cli",
      });
      assert.deepEqual(diagnostic.settings["mail.transport"], {
        value: "smtp",
        source: "cli",
      });
      assert.deepEqual(diagnostic.settings["mail.smtp.url"], {
        value: "<redacted>",
        source: "cli",
      });
      assert.deepEqual(diagnostic.settings["telemetry.log_output"], {
        value: logPath,
        source: "config",
        configPath: config,
      });
      assert.equal(diagnostic.settings["database.data_path"], undefined);
      assert.ok(
        diagnostic.ignored.some(
          (entry: { field?: string }) => entry.field === "database.data_path",
        ),
      );
      assert.ok(
        diagnostic.ignored.some(
          (entry: { area?: string }) => entry.area === "web",
        ),
      );
      await assert.rejects(access(dataPath), { code: "ENOENT" });
      await assert.rejects(access(logPath), { code: "ENOENT" });
      const logOnly = await run(
        ["--print-config", "--config", config, "--mail-transport", "logtape"],
        preload,
        { DRFED_SMTP_URL: "IGNORED_SMTP_SECRET" },
      );
      assert.equal(logOnly.code, 0, logOnly.stderr);
      assert.doesNotMatch(
        logOnly.stdout + logOnly.stderr,
        /IGNORED_SMTP_SECRET|EARLY_RESOURCE_CONSTRUCTION/u,
      );
      const ignoredMail = JSON.parse(logOnly.stdout);
      assert.deepEqual(ignoredMail.settings["mail.transport"], {
        value: "logtape",
        source: "cli",
      });
      assert.ok(
        ignoredMail.ignored.some(
          (entry: { field?: string; source?: string }) =>
            entry.field === "mail.smtp.url" && entry.source === "env",
        ),
      );
      const loggingPrefix = await run(
        ["--log-level", "debug", "--config", config, "--print-config"],
        preload,
      );
      assert.equal(loggingPrefix.code, 0, loggingPrefix.stderr);
      assert.deepEqual(
        JSON.parse(loggingPrefix.stdout).settings["telemetry.log_level"],
        { value: "debug", source: "cli" },
      );
      const invalidLoggingPrefix = await run(
        ["--log-level", "bad", "--config", config, "--print-config"],
        preload,
      );
      assert.equal(invalidLoggingPrefix.code, 1);
      assert.doesNotMatch(
        invalidLoggingPrefix.stderr,
        /EARLY_RESOURCE_CONSTRUCTION/u,
      );
      const optionLookingValue = await run(
        [
          "--print-config",
          "--config",
          config,
          "--log-output",
          "--generate-graphql-schema",
        ],
        preload,
      );
      assert.equal(optionLookingValue.code, 0, optionLookingValue.stderr);
      assert.deepEqual(
        JSON.parse(optionLookingValue.stdout).settings["telemetry.log_output"],
        {
          value: join(process.cwd(), "--generate-graphql-schema"),
          source: "cli",
        },
      );
      const invalid = await run(
        ["--print-config", "--config", config],
        preload,
        { DRFED_LISTEN: "bad address" },
      );
      assert.equal(invalid.code, 1);
      assert.doesNotMatch(invalid.stderr, /EARLY_RESOURCE_CONSTRUCTION/u);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("ignores operational environment in schema, help and version projections", async () => {
    const environment = {
      DRFED_CONFIG: "/absent-drfed-file.toml",
      DRFED_LOG_LEVEL: "invalid",
      DRFED_LOG_FORMAT: "invalid",
      DRFED_LOG_OUTPUT: "",
      DRFED_ROOT_ORIGIN: "invalid",
      DRFED_LOGIN_ORIGINS: "invalid",
      DRFED_MIGRATE: "invalid",
      DRFED_POSTGRES_URL: "PRIVATE_PASSWORD",
      DRFED_SMTP_URL: "SMTP_PASSWORD",
    };
    for (const mode of ["--help", "--version", "--generate-graphql-schema"]) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await run([mode], undefined, environment);
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /PRIVATE_PASSWORD|SMTP_PASSWORD/u,
      );
      if (mode === "--generate-graphql-schema") {
        assert.match(result.stdout, /type Query/u);
      }
    }
    for (const logging of [
      ["--log-level", "ignored-invalid-level"],
      ["-L", "info"],
      ["--log-format", "ignored-invalid-format"],
      ["--log-output", ""],
    ]) {
      for (const args of [
        [...logging, "--generate-graphql-schema"],
        ["--generate-graphql-schema", ...logging],
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        const result = await run(args, undefined, environment);
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /type Query/u);
        assert.doesNotMatch(
          result.stdout + result.stderr,
          /PRIVATE_PASSWORD|SMTP_PASSWORD/u,
        );
      }
    }
    const terminated = await run(
      ["--", "--generate-graphql-schema"],
      undefined,
      environment,
    );
    assert.equal(terminated.code, 1);
    assert.doesNotMatch(terminated.stdout, /type Query/u);
  });
});
