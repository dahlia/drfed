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
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

async function complete(command: string, args: string[]) {
  const binary = fileURLToPath(
    new URL(`../bin/${command}.mjs`, import.meta.resolve("@drfed/drfed")),
  );
  const result = await execute(process.execPath, [binary, ...args], {
    cwd: tmpdir(),
    env: { PATH: env.PATH ?? "" },
    timeout: 45_000,
  });
  assert.equal(result.stderr, "");
  return result.stdout;
}

for (const command of commands) {
  it(`${command} exposes both completion forms for all five shells`, async () => {
    for (const shell of shells) {
      for (const form of ["completion", "--completion"]) {
        // oxlint-disable-next-line no-await-in-loop
        const script = await complete(command, [form, shell]);
        assert.ok(script.includes(command));
        assert.ok(script.length > 100);
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
