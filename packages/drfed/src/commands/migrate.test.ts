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
import { join } from "node:path";
import { env } from "node:process";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  inspectMigrationState,
  openPersistentPglite,
  verifyMigrationManifest,
} from "@drfed/models";

const execute = promisify(execFile);
const binary = fileURLToPath(
  new URL("../bin/drfed-migrate.mjs", import.meta.resolve("@drfed/drfed")),
);

async function run(
  args: string[],
  preload?: string,
  environment: Record<string, string> = {},
) {
  try {
    const result = await execute(
      process.execPath,
      [
        ...(preload === undefined
          ? []
          : ["--import", pathToFileURL(preload).href]),
        binary,
        ...args,
      ],
      { env: { PATH: env.PATH ?? "", ...environment }, timeout: 45_000 },
    );
    return { code: 0, ...result };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: result.code ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}

it("keeps migration help, version, diagnostics and parse failures resource-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-migrate-pure-"));
  const data = join(directory, "must-not-exist");
  const preload = join(directory, "guard.mjs");
  try {
    await writeFile(
      preload,
      `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (specifier === "postgres") return { url: "data:text/javascript," + encodeURIComponent("export default function(){ throw new Error('EARLY_RESOURCE'); }"), shortCircuit: true };
  if (specifier !== "@drfed/models") return resolved;
  const source = "export * from " + JSON.stringify(resolved.url) + "; export function openPersistentPglite(){ throw new Error('EARLY_RESOURCE'); } export function preparePostgresDatabase(){ throw new Error('EARLY_RESOURCE'); }";
  return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
}});`,
    );
    for (const [suffix, code] of [
      ["--help", 0],
      ["--version", 0],
      ["--print-config", 0],
      ["--unknown-option", 1],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await run([`--data-path=${data}`, suffix], preload);
      assert.equal(result.code, code, result.stderr);
      assert.doesNotMatch(result.stderr, /EARLY_RESOURCE/u);
    }
    const diagnostic = await run(
      [
        "--postgres-url=postgres://user:PRIVATE_PASSWORD@localhost/drfed",
        "--print-config",
      ],
      preload,
    );
    assert.equal(diagnostic.code, 0, diagnostic.stderr);
    assert.doesNotMatch(
      diagnostic.stdout + diagnostic.stderr,
      /PRIVATE_PASSWORD|EARLY_RESOURCE/u,
    );
    await assert.rejects(access(data), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it(
  "checks without DrFed DDL, applies despite migrate=false, and preserves refusal exit codes after cleanup",
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "drfed-migrate-operation-"));
    const config = join(directory, "drfed.toml");
    const data = join(directory, "data");
    try {
      await writeFile(config, '[database]\ndata_path="data"\nmigrate=false\n');
      const fresh = await run(["--config", config, "--check"]);
      assert.equal(fresh.code, 1, fresh.stderr);
      assert.equal(JSON.parse(fresh.stdout).status, "uninitialized");
      const uninitialized = await openPersistentPglite(data);
      try {
        await uninitialized.ready;
        assert.equal(
          (await inspectMigrationState(uninitialized.client)).status,
          "uninitialized",
        );
        assert.equal(
          (
            await uninitialized.client.query<{ table: string | null }>(
              "SELECT to_regclass('public.accounts') AS table",
            )
          ).rows[0]?.table,
          null,
        );
      } finally {
        await uninitialized.close();
      }
      const applied = await run(["--config", config], undefined, {
        DRFED_MIGRATE: "bad ignored value",
        DRFED_ROOT_ORIGIN: "bad ignored origin",
        DRFED_SMTP_URL: "bad ignored URL",
      });
      assert.equal(applied.code, 0, applied.stderr);
      assert.equal(JSON.parse(applied.stdout).status, "ready");
      const ready = await run(["--config", config, "--check"]);
      assert.equal(ready.code, 0, ready.stderr);
      assert.equal(
        JSON.parse(ready.stdout).applied,
        (await verifyMigrationManifest()).migrations.length,
      );
      const changed = await openPersistentPglite(data);
      try {
        await changed.ready;
        await changed.client.exec(
          "UPDATE drizzle.__drizzle_migrations SET hash=repeat('0',64) WHERE id=1",
        );
      } finally {
        await changed.close();
      }
      const incompatible = await run(["--config", config, "--check"]);
      assert.equal(incompatible.code, 1, incompatible.stderr);
      assert.equal(JSON.parse(incompatible.stdout).status, "modified");
      const refused = await run(["--config", config]);
      assert.equal(refused.code, 1, refused.stderr);
      assert.match(refused.stderr, /incompatible-history/u);
      const observed = await openPersistentPglite(data);
      try {
        await observed.ready;
        assert.equal(
          (await inspectMigrationState(observed.client)).status,
          "modified",
        );
      } finally {
        await observed.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

for (const mode of ["apply", "check"] as const) {
  it(
    `returns failure and releases ownership when ${mode} is interrupted`,
    { timeout: 60_000, skip: process.platform === "win32" },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "drfed-migrate-abort-"));
      const data = join(directory, "data");
      const preload = join(directory, "interrupt.mjs");
      try {
        await writeFile(
          preload,
          `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context); if (specifier !== "@drfed/models") return resolved;
  const source = "export * from " + JSON.stringify(resolved.url) + "; import * as real from " + JSON.stringify(resolved.url) + "; async function interrupt(){process.kill(process.pid,'SIGTERM');await new Promise(resolve=>setTimeout(resolve,30));} export async function inspectMigrationState(...args){await interrupt();return real.inspectMigrationState(...args);} export async function preparePgliteDatabase(...args){await interrupt();return real.preparePgliteDatabase(...args);}";
  return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
}});`,
        );
        const interrupted = await run(
          [`--data-path=${data}`, ...(mode === "check" ? ["--check"] : [])],
          preload,
        );
        assert.equal(interrupted.code, 1, interrupted.stderr);
        assert.equal(interrupted.stdout, "");
        const subsequent = await run([`--data-path=${data}`, "--check"]);
        assert.equal(subsequent.code, 1, subsequent.stderr);
        assert.equal(JSON.parse(subsequent.stdout).status, "uninitialized");
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
