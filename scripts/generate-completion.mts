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

// oxlint-disable node/no-top-level-await
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const application = fileURLToPath(
  new URL("../packages/drfed/", import.meta.url),
);
const commands = [
  "drfed-server",
  "drfed-web",
  "drfed-migrate",
  "drfed-account",
];
const shells = ["bash", "zsh", "fish", "pwsh", "nu"] as const;
const scripts: { path: string; contents: string }[] = [];

for (const command of commands) {
  for (const shell of shells) {
    // Run the built installed entry point, including its runner-supplied options.
    // oxlint-disable-next-line no-await-in-loop
    const { stdout, stderr } = await execute(
      process.execPath,
      [join(application, "bin", `${command}.mjs`), "completion", shell],
      {
        cwd: tmpdir(),
        env: { PATH: process.env.PATH ?? "" },
        timeout: 45_000,
      },
    );
    if (stderr !== "" || stdout.length === 0) {
      throw new Error(`Could not generate ${shell} completion for ${command}.`);
    }
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
    scripts.push({
      path: join(application, "completions", shell, name),
      contents: stdout,
    });
  }
}

// Do not replace artifacts until every command has generated successfully.
for (const shell of shells) {
  // oxlint-disable-next-line no-await-in-loop
  await mkdir(join(application, "completions", shell), { recursive: true });
}
await Promise.all(
  scripts.map(({ path, contents }) => writeFile(path, contents)),
);
