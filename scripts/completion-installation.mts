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

// Keep shell processes serial to bound resource use during packed-install checks.
// oxlint-disable no-await-in-loop
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Probe shell discovery and explicit loading against an installed npm package. */
export async function probeCompletionInstallation(
  application: string,
  bin: string,
  directory: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const env = {
    ...environment,
    PATH: `${bin}${delimiter}${environment.PATH ?? ""}`,
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_CACHE_HOME: join(directory, "cache"),
    ZDOTDIR: directory,
  };
  const run = async (shell: string, args: string[]) => {
    const result = await execute(shell, args, {
      cwd: directory,
      env,
      timeout: 45_000,
    });
    return result.stdout;
  };
  const zshPaths = (await run("zsh", ["-f", "-c", "print -l -- $fpath"])).split(
    "\n",
  );
  const fishPaths = (
    await run("fish", ["-c", 'printf "%s\\n" $fish_complete_path'])
  ).split("\n");
  assert.ok(!zshPaths.includes(join(application, "completions/zsh")));
  assert.ok(!fishPaths.includes(join(application, "completions/fish")));
  const quotePowerShell = (value: string) => `'${value.replaceAll("'", "''")}'`;
  for (const command of [
    "drfed-server",
    "drfed-web",
    "drfed-migrate",
    "drfed-account",
  ]) {
    const prefix =
      command === "drfed-account"
        ? "create --data-pa"
        : command === "drfed-web"
          ? "--public-or"
          : "--data-pa";
    const expected =
      command === "drfed-web" ? "--public-origin" : "--data-path";
    const line = `${command} ${prefix}`;
    const artifacts = join(application, "completions");
    // Executable links alone do not register these completion definitions.
    const beforeBash = await run("bash", [
      "--noprofile",
      "--norc",
      "-c",
      'complete -p "$1" 2>/dev/null || true',
      "probe",
      command,
    ]);
    assert.equal(beforeBash, "");
    const beforeZsh = await run("zsh", [
      "-f",
      "-c",
      // Shell parameter expansion is intentionally literal JavaScript text.
      // oxlint-disable-next-line no-template-curly-in-string
      'autoload -Uz compinit; compinit -D -i; print -r -- "${_comps[$1]-}"',
      "probe",
      command,
    ]);
    assert.equal(beforeZsh.trim(), "");
    const beforeFish = await run("fish", [
      "-c",
      'complete -C "$argv[1]"',
      line,
    ]);
    assert.ok(!beforeFish.includes(expected));
    const psComplete = `[System.Management.Automation.CommandCompletion]::CompleteInput(${quotePowerShell(line)}, ${line.length}, $null).CompletionMatches.CompletionText`;
    const beforePowerShell = await run("pwsh", [
      "-NoProfile",
      "-Command",
      psComplete,
    ]);
    assert.ok(!beforePowerShell.includes(expected));
    const beforeNu = await run("nu", [
      "--no-config-file",
      "-c",
      "$env.config.completions.external.completer == null | to json",
    ]);
    assert.equal(beforeNu.trim(), "true");

    const bash = await run("bash", [
      "--noprofile",
      "--norc",
      "-c",
      `
source "$1"
shift
COMP_WORDS=("$@")
COMP_CWORD=$(($# - 1))
"_\${COMP_WORDS[0]}"
printf '%s\\n' "\${COMPREPLY[@]}"
`,
      "probe",
      join(artifacts, "bash", command),
      command,
      ...prefix.split(" "),
    ]);
    assert.ok(bash.includes(expected));
    const zsh = await run("zsh", [
      "-f",
      "-c",
      // Shell parameter expansion is intentionally literal JavaScript text.
      // oxlint-disable-next-line no-template-curly-in-string
      'autoload -Uz compinit; compinit -D -i; source "$1"; print -r -- "${_comps[$2]-}"',
      "probe",
      join(artifacts, "zsh", `_${command}`),
      command,
    ]);
    assert.equal(zsh.trim(), `_${command.replaceAll("-", "_")}`);
    const fish = await run("fish", [
      "-c",
      'source "$argv[1]"; complete -C "$argv[2]"',
      join(artifacts, "fish", `${command}.fish`),
      line,
    ]);
    assert.ok(fish.includes(expected));
    const powerShell = await run("pwsh", [
      "-NoProfile",
      "-Command",
      `. ${quotePowerShell(join(artifacts, "pwsh", `${command}.ps1`))}; ${psComplete}`,
    ]);
    assert.ok(powerShell.includes(expected));
    const nuScript = join(directory, `${command}-probe.nu`);
    await writeFile(
      nuScript,
      `source ${JSON.stringify(join(artifacts, "nu", `${command}.nu`))}\ndo $env.config.completions.external.completer ${JSON.stringify(line.split(" "))} | to json\n`,
    );
    const nu = await run("nu", ["--no-config-file", nuScript]);
    assert.ok(nu.includes(expected));
  }
}
