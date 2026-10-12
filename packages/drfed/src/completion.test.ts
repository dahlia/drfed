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
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { env } from "node:process";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { createAccountProgram } from "@drfed/drfed/commands/account-program";
import { createMigrationProgram } from "@drfed/drfed/commands/migrate-program";
import { createWebProgram } from "@drfed/drfed/commands/web-program";
import { createConfigurationBindings } from "@drfed/drfed/configuration";
import { createLoggingParser } from "@drfed/drfed/logging";
import {
  createMailParser,
  mailValueOptionNames,
} from "@drfed/drfed/mail-parser";
import { suggest } from "@optique/core/parser";

const execute = promisify(execFile);
const commands = [
  "drfed-server",
  "drfed-web",
  "drfed-migrate",
  "drfed-account",
];
const shells = ["bash", "zsh", "fish", "pwsh", "nu"];

async function complete(
  command: string,
  args: string[],
  options: { environment?: Record<string, string>; preload?: string } = {},
) {
  const binary = fileURLToPath(
    new URL(`../bin/${command}.mjs`, import.meta.resolve("@drfed/drfed")),
  );
  const result = await execute(
    process.execPath,
    [
      ...(options.preload === undefined
        ? []
        : ["--import", pathToFileURL(options.preload).href]),
      binary,
      ...args,
    ],
    {
      cwd: tmpdir(),
      env: { PATH: env.PATH ?? "", ...options.environment },
      timeout: 45_000,
    },
  );
  assert.equal(result.stderr, "");
  return result.stdout;
}

it("completes aliases and equals-form values through the installed runners", async () => {
  const aliases = await complete("drfed-server", ["completion", "bash", "-"]);
  for (const alias of ["-r", "-l", "-d", "-D", "-s", "-L"]) {
    assert.ok(aliases.split("\n").includes(alias), alias);
  }
  const values = await complete("drfed-server", [
    "completion",
    "bash",
    "--mail-transport=re",
  ]);
  assert.ok(values.split("\n").includes("--mail-transport=resend"));
  assert.ok(!values.includes("smtp"));
});

it(
  "does not suggest options after the argument terminator",
  {
    todo: "Upstream terminator regression: https://github.com/dahlia/optique/issues/1028",
  },
  async () => {
    const suggestions = await complete("drfed-account", [
      "completion",
      "bash",
      "create",
      "--",
      "--",
    ]);
    assert.equal(suggestions.trim(), "");
  },
);

it("completion ignores invalid deployment settings and never accesses operator resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-completion-safety-"));
  try {
    const config = join(directory, "invalid.toml");
    const missing = join(directory, "missing.toml");
    const secret = join(directory, "credential.txt");
    const missingSecret = join(directory, "missing-secret");
    const data = join(directory, "database");
    const log = join(directory, "server.log");
    const preload = join(directory, "guard.mjs");
    await writeFile(config, "PRIVATE_CONFIG_CONTENT = [invalid TOML");
    await writeFile(secret, "PRIVATE_CREDENTIAL_CONTENT");
    await writeFile(
      preload,
      `
import fs from "node:fs";
import promises from "node:fs/promises";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { Server, Socket } from "node:net";
const fail = () => { throw new Error("COMPLETION_RESOURCE_ACCESS"); };
const protectedPaths = new Set(${JSON.stringify([config, missing, secret, missingSecret, data, log])});
for (const [target, methods] of [
  [fs, ["readFile", "readFileSync", "open", "openSync", "createReadStream", "createWriteStream", "mkdir", "mkdirSync", "writeFile", "writeFileSync"]],
  [promises, ["readFile", "open", "mkdir", "writeFile"]],
]) {
  for (const method of methods) {
    const original = target[method];
    target[method] = function (path, ...args) {
      if (protectedPaths.has(String(path))) fail();
      return original.call(this, path, ...args);
    };
  }
}
syncBuiltinESMExports();
Server.prototype.listen = fail;
Socket.prototype.connect = fail;
globalThis.fetch = fail;
const guards = new Map([
  ["@drfed/models", ["openPersistentPglite", "preparePostgresDatabase"]],
  ["@drfed/web", ["createWebRuntime"]],
  ["@optique/logtape", ["createLoggingConfig"]],
]);
const constructors = new Map([
  ["@electric-sql/pglite", "PGlite"],
  ["@upyo/smtp", "SmtpTransport"],
  ["@upyo/logtape", "LogTapeTransport"],
]);
registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (resolved.url.includes("/web/.output/")) fail();
  const names = guards.get(specifier);
  const constructor = constructors.get(specifier);
  if (constructor !== undefined) {
    const source = "export * from " + JSON.stringify(resolved.url) + "; export class " + constructor + " { constructor(){throw new Error('COMPLETION_RESOURCE_ACCESS')} }";
    return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
  }
  if (names === undefined && specifier !== "postgres") return resolved;
  let source = "export * from " + JSON.stringify(resolved.url) + ";";
  if (specifier === "postgres") source += "export default function(){throw new Error('COMPLETION_RESOURCE_ACCESS')}";
  else for (const name of names) source += "export function " + name + "(){throw new Error('COMPLETION_RESOURCE_ACCESS')}";
  return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
}});
`,
    );
    // Prove that the preload blocks real access rather than merely reporting
    // unchanged output when no guard has been installed.
    await assert.rejects(
      execute(
        process.execPath,
        [
          "--import",
          pathToFileURL(preload).href,
          "--input-type=module",
          "--eval",
          `import { readFile } from "node:fs/promises"; await readFile(${JSON.stringify(secret)});`,
        ],
        { env: { PATH: env.PATH ?? "" }, timeout: 45_000 },
      ),
      /COMPLETION_RESOURCE_ACCESS/u,
    );
    const environment = {
      DRFED_CONFIG: config,
      DRFED_LISTEN: "invalid address",
      DRFED_PUBLIC_ORIGIN: "not an origin",
      DRFED_BACKEND_URL: "not a URL",
      DRFED_LOGIN_ORIGINS: "invalid JSON",
      DRFED_POSTGRES_URL: "not a database URL",
      DRFED_DATA_PATH: data,
      DRFED_MAIL_TRANSPORT: "unsupported transport",
      DRFED_SMTP_PORT: "not a port",
      DRFED_SMTP_PASSWORD: "PRIVATE_ENV_SECRET",
      DRFED_SMTP_PASSWORD_FILE: secret,
      DRFED_SMTP_ACCESS_TOKEN_FILE: missingSecret,
      DRFED_LOG_OUTPUT: log,
      DRFED_LOG_LEVEL: "invalid level",
    };
    for (const command of commands) {
      const prefix = command === "drfed-account" ? ["create"] : [];
      for (const shell of shells) {
        // oxlint-disable-next-line no-await-in-loop
        const script = await complete(command, ["completion", shell], {
          environment,
          preload,
        });
        assert.ok(script.includes(command));
        assert.doesNotMatch(script, /PRIVATE_|COMPLETION_RESOURCE_ACCESS/u);
        // oxlint-disable-next-line no-await-in-loop
        const suggestions = await complete(
          command,
          ["--completion", shell, ...prefix, "--config", missing, "--h"],
          { environment, preload },
        );
        assert.ok(suggestions.includes("--help"));
        assert.doesNotMatch(
          suggestions,
          /PRIVATE_|COMPLETION_RESOURCE_ACCESS/u,
        );
      }
    }
    const choices = await complete(
      "drfed-server",
      ["completion", "bash", "--mail-transport=re"],
      { environment, preload },
    );
    assert.ok(choices.includes("--mail-transport=resend"));
    const credentials = await complete(
      "drfed-server",
      ["completion", "bash", "--smtp-password", ""],
      { environment, preload },
    );
    assert.doesNotMatch(
      choices + credentials,
      /PRIVATE_|COMPLETION_RESOURCE_ACCESS/u,
    );
    for (const path of [data, log]) {
      // oxlint-disable-next-line no-await-in-loop
      await assert.rejects(access(path), { code: "ENOENT" });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const command of commands) {
  it(`${command} exposes both completion forms for all five shells`, async () => {
    for (const shell of shells) {
      for (const form of ["completion", "--completion"]) {
        // oxlint-disable-next-line no-await-in-loop
        const script = await complete(command, [form, shell]);
        assert.ok(script.includes(command));
        assert.ok(script.length > 100);
        const name =
          shell === "zsh"
            ? `_${command}`
            : shell === "fish"
              ? `${command}.fish`
              : shell === "pwsh"
                ? `${command}.ps1`
                : shell === "nu"
                  ? `${command}.nu`
                  : command;
        // Resolve from the package entry point rather than the test's working directory.
        const artifact = new URL(
          `../completions/${shell}/${name}`,
          import.meta.resolve("@drfed/drfed"),
        );
        if (form === "completion") {
          // The two entry forms embed different runtime invocations. Bundled
          // scripts use the canonical subcommand form.
          // oxlint-disable-next-line no-await-in-loop
          assert.equal(await readFile(artifact, "utf8"), script);
        }
      }
    }
  });

  it(`${command} suggests runner options and command options`, async () => {
    const prefix = command === "drfed-account" ? ["create"] : [];
    const runner = await complete(command, ["completion", "bash", "--h"]);
    assert.ok(runner.includes("--help"));
    const option = command === "drfed-web" ? "--public-origin" : "--data-path";
    const suggestions = await complete(command, [
      "completion",
      "bash",
      ...prefix,
      option.slice(0, -2),
    ]);
    assert.ok(suggestions.includes(option));
  });
}

it("drfed-account suggests its create subcommand", async () => {
  const suggestions = await complete("drfed-account", [
    "completion",
    "bash",
    "cr",
  ]);
  assert.ok(suggestions.includes("create"));
});

it("drfed-server completes mail transport values without deployment configuration", async () => {
  const suggestions = await complete("drfed-server", [
    "completion",
    "bash",
    "--mail-transport",
    "",
  ]);
  assert.ok(suggestions.includes("smtp"));
  assert.ok(suggestions.includes("ses"));
  const filtered = await complete("drfed-server", [
    "completion",
    "bash",
    "--mail-transport",
    "re",
  ]);
  assert.ok(filtered.includes("resend"));
  assert.ok(!filtered.includes("smtp"));
});

it("delegates credential and logging paths to native file completion without reading settings", () => {
  const bindings = createConfigurationBindings({
    env: () => {
      throw new Error("Completion must not read environment settings.");
    },
  });
  const mail = createMailParser(bindings);
  const prefix = "./name with spaces;$(touch marker)[draft]$cash:%/";
  for (const [key, names] of Object.entries(mailValueOptionNames)) {
    if (!key.endsWith("File")) continue;
    const items = suggest(mail, [names[0], prefix]);
    assert.ok(
      items.some(
        (item) =>
          item.kind === "file" &&
          item.type === "file" &&
          item.pattern === prefix,
      ),
      key,
    );
  }
  const items = suggest(createLoggingParser(bindings), [
    "--log-output",
    prefix,
  ]);
  assert.ok(
    items.some(
      (item) =>
        item.kind === "file" && item.type === "file" && item.pattern === prefix,
    ),
  );
});

it("preserves native file and directory suggestions through command configuration bindings", () => {
  const options = {
    env: () => {
      throw new Error("Completion must not read environment settings.");
    },
  };
  const prefix = "./path with spaces/[draft]$cash:%/";
  const account = createAccountProgram(options).program.parser;
  const migrate = createMigrationProgram(options).program.parser;
  const web = createWebProgram(options).program.parser;
  for (const items of [
    suggest(account, ["create", "--config", prefix]),
    suggest(migrate, ["--config", prefix]),
    suggest(web, ["--config", prefix]),
  ]) {
    assert.ok(
      items.some(
        (item) =>
          item.kind === "file" &&
          item.type === "file" &&
          item.pattern === prefix,
      ),
    );
  }
  for (const items of [
    suggest(account, ["create", "-d", prefix]),
    suggest(migrate, ["--data-path", prefix]),
  ]) {
    assert.ok(
      items.some(
        (item) =>
          item.kind === "file" &&
          item.type === "directory" &&
          item.pattern === prefix,
      ),
    );
  }
});

it(
  "loads Bash completion and safely completes paths containing spaces and shell metacharacters",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "drfed-path-completion-"));
    try {
      const bin = join(directory, "bin");
      await mkdir(bin);
      const binary = fileURLToPath(
        new URL("../bin/drfed-server.mjs", import.meta.resolve("@drfed/drfed")),
      );
      await writeFile(
        join(bin, "drfed-server"),
        `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(binary).href)};\n`,
        { mode: 0o755 },
      );
      const script = join(directory, "completion.bash");
      await writeFile(
        script,
        await complete("drfed-server", ["completion", "bash"]),
      );
      const file = "name with spaces;$(touch marker)[draft]$cash:%.toml";
      const folder = "name directory [draft]$cash:%";
      await writeFile(join(directory, file), "PRIVATE_CREDENTIAL_CONTENT");
      await mkdir(join(directory, folder));
      const invoke = async (option: string) => {
        const result = await execute(
          "bash",
          [
            "--noprofile",
            "--norc",
            "-c",
            // Shell array expansion is intentionally literal JavaScript text.
            // oxlint-disable-next-line no-template-curly-in-string
            'source "$1"\nCOMP_WORDS=(drfed-server "$2" "./name")\nCOMP_CWORD=2\n_drfed-server\nprintf "%s\\0" "${COMPREPLY[@]}"',
            "completion-test",
            script,
            option,
          ],
          {
            cwd: directory,
            env: {
              PATH: `${bin}:${dirname(process.execPath)}:${env.PATH ?? ""}`,
            },
            timeout: 45_000,
          },
        );
        assert.equal(result.stderr, "");
        assert.ok(!result.stdout.includes("PRIVATE_CREDENTIAL_CONTENT"));
        return result.stdout.split("\0").filter(Boolean);
      };
      for (const option of [
        "--config",
        "--smtp-password-file",
        "--log-output",
      ]) {
        // oxlint-disable-next-line no-await-in-loop
        const values = await invoke(option);
        assert.ok(
          values.includes(`./${file}`),
          `${option}: ${JSON.stringify(values)}`,
        );
      }
      const values = await invoke("-d");
      assert.ok(values.includes(`./${folder}/`));
      assert.ok(!values.includes(`./${file}`));
      await assert.rejects(access(join(directory, "marker")), {
        code: "ENOENT",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
