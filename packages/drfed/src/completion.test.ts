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
import { tmpdir } from "node:os";
import { env } from "node:process";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
