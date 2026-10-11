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

import { inspectMigrationState, openPersistentPglite } from "@drfed/models";

const execute = promisify(execFile);
const binary = fileURLToPath(
  new URL("../bin/drfed-account.mjs", import.meta.resolve("@drfed/drfed")),
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

it("keeps account help, version, diagnostics and invalid input resource-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-account-pure-"));
  const data = join(directory, "must-not-exist");
  const preload = join(directory, "guard.mjs");
  const base = [
    "create",
    `--data-path=${data}`,
    "--email=user@example.com",
    "--name=Operator",
  ];
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
    for (const args of [
      ["--help"],
      ["--version"],
      [...base, "--print-config"],
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await run(args, preload);
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /EARLY_RESOURCE/u);
    }
    for (const args of [
      ["create", `--data-path=${data}`, "--email=invalid", "--name=Operator"],
      [
        "create",
        `--data-path=${data}`,
        "--email=operator@localhost",
        "--name=Operator",
      ],
      ["create", `--data-path=${data}`, "--email=user@example.com", "--name= "],
      [
        "create",
        `--data-path=${data}`,
        "--email=user@example.com",
        `--name=${"😀".repeat(101)}`,
      ],
      [...base, "--admin"],
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      const result = await run(args, preload);
      assert.equal(result.code, 1, result.stderr);
      assert.doesNotMatch(result.stderr, /EARLY_RESOURCE/u);
    }
    for (const email of ["o'connor@example.com", "user@bücher.example"]) {
      // oxlint-disable-next-line no-await-in-loop
      const accepted = await run(
        [
          "create",
          `--email=${email}`,
          "--name=Operator",
          `--data-path=${data}`,
          "--print-config",
        ],
        preload,
      );
      assert.equal(accepted.code, 0, accepted.stderr);
    }
    const diagnostic = await run(
      [
        "create",
        "--email=user@example.com",
        "--name=Operator",
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
  "bootstraps a fresh database and preserves existing account names and privileges",
  { timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "drfed-account-operation-"));
    const config = join(directory, "drfed.toml");
    const data = join(directory, "data");
    const base = [
      "create",
      "--config",
      config,
      "--email=Operator@EXAMPLE.COM",
      "--name= Operator ",
    ];
    try {
      await writeFile(config, '[database]\ndata_path="data"\nmigrate=false\n');
      const unprepared = await run(base);
      assert.equal(unprepared.code, 1, unprepared.stderr);
      assert.match(unprepared.stderr, /incompatible-history/u);
      const empty = await openPersistentPglite(data);
      try {
        await empty.ready;
        assert.equal(
          (await inspectMigrationState(empty.client)).status,
          "uninitialized",
        );
      } finally {
        await empty.close();
      }
      const created = await run([...base, "--migrate"], undefined, {
        DRFED_ROOT_ORIGIN: "invalid ignored origin",
        DRFED_SMTP_URL: "invalid ignored mail URL",
      });
      assert.equal(created.code, 0, created.stderr);
      const first = JSON.parse(created.stdout);
      assert.equal(first.status, "created");
      assert.equal(first.account.email, "Operator@example.com");
      assert.equal(first.account.name, "Operator");
      assert.equal(first.account.admin, false);
      const held = await openPersistentPglite(data);
      try {
        await held.ready;
        const sessions = await held.client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM sessions",
        );
        assert.equal(sessions.rows[0]?.count, 0);
        await held.client.query(
          "UPDATE accounts SET admin=true WHERE email=$1",
          ["Operator@example.com"],
        );
        const blocked = await run([...base, "--no-migrate"]);
        assert.equal(blocked.code, 1, blocked.stderr);
        assert.match(blocked.stderr, /locked/u);
      } finally {
        await held.close();
      }
      const repeated = await run([
        "create",
        "--config",
        config,
        "--email=Operator@example.com",
        "--name=Changed name",
        "--no-migrate",
      ]);
      assert.equal(repeated.code, 0, repeated.stderr);
      const existing = JSON.parse(repeated.stdout);
      assert.equal(existing.status, "exists");
      assert.equal(existing.account.id, first.account.id);
      assert.equal(existing.account.name, "Operator");
      assert.equal(existing.account.admin, true);
      const observed = await openPersistentPglite(data);
      try {
        await observed.ready;
        assert.equal(
          (
            await observed.client.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM accounts",
            )
          ).rows[0]?.count,
          1,
        );
      } finally {
        await observed.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
