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
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { inspectMigrationState, openPersistentPglite } from "@drfed/models";

const binary = fileURLToPath(
  new URL("../bin/drfed-server.mjs", import.meta.resolve("@drfed/drfed")),
);

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const closed = once(server, "close");
  server.close();
  await closed;
  return address.port;
}
function start(dataPath: string, port: number, noMigrate = false) {
  const child = spawn(
    process.execPath,
    [
      binary,
      "--root-origin=http://drfed.test",
      "--login-origin=http://drfed.test",
      `--listen=127.0.0.1:${port}`,
      `--data-path=${dataPath}`,
      "--log-level=error",
      ...(noMigrate ? ["--no-migrate"] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const closed = once(child, "exit", { signal: AbortSignal.timeout(60_000) });
  // Observe failure even if readiness itself fails before awaiting exit.
  // oxlint-disable-next-line promise/prefer-await-to-then
  void closed.catch(() => undefined);
  return { child, closed, stderr: () => stderr };
}
async function ready(
  run: ReturnType<typeof start>,
  port: number,
): Promise<void> {
  const deadline = performance.now() + 45_000;
  while (performance.now() < deadline) {
    assert.equal(run.child.exitCode, null, run.stderr());
    try {
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"query":"{ __typename }"}',
        signal: AbortSignal.timeout(500),
      });
      // oxlint-disable-next-line no-await-in-loop, no-underscore-dangle
      if (response.ok && (await response.json()).data?.__typename === "Query") {
        return;
      }
    } catch {
      /* The listener has not started yet. */
    }
    // oxlint-disable-next-line no-await-in-loop
    await delay(50);
  }
  assert.fail(`Readiness timeout: ${run.stderr()}`);
}
async function stop(run: ReturnType<typeof start>): Promise<void> {
  run.child.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
  const [code, signal] = await run.closed;
  if (process.platform !== "win32") {
    assert.equal(code, 0, run.stderr());
    assert.equal(signal, null);
  }
}

it(
  "requires exact ready history, holds ownership and safely upgrades legacy metadata",
  { timeout: 180_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "drfed-database-startup-"));
    const dataPath = join(directory, "data");
    const port = await freePort();
    const children: ReturnType<typeof start>[] = [];
    try {
      const fresh = start(dataPath, port, true);
      children.push(fresh);
      assert.equal((await fresh.closed)[0], 1, fresh.stderr());
      assert.match(fresh.stderr(), /incompatible-history/u);
      const empty = await openPersistentPglite(dataPath);
      try {
        await empty.ready;
        assert.equal(
          (await inspectMigrationState(empty.client)).status,
          "uninitialized",
        );
      } finally {
        await empty.close();
      }

      const initial = start(dataPath, port);
      children.push(initial);
      await ready(initial, port);
      const duplicate = start(dataPath, await freePort());
      children.push(duplicate);
      assert.equal((await duplicate.closed)[0], 1, duplicate.stderr());
      assert.match(duplicate.stderr(), /already in use/u);
      await stop(initial);
      const repeat = start(dataPath, port, true);
      children.push(repeat);
      await ready(repeat, port);
      await stop(repeat);

      const legacy = await openPersistentPglite(dataPath);
      try {
        await legacy.ready;
        await legacy.client.exec(
          "ALTER TABLE drizzle.__drizzle_migrations DROP COLUMN name, DROP COLUMN applied_at; UPDATE drizzle.__drizzle_migrations SET created_at = created_at + 321;",
        );
        assert.equal(
          (await inspectMigrationState(legacy.client)).status,
          "upgrade-required",
        );
      } finally {
        await legacy.close();
      }
      const legacyReadonly = start(dataPath, port, true);
      children.push(legacyReadonly);
      assert.equal(
        (await legacyReadonly.closed)[0],
        1,
        legacyReadonly.stderr(),
      );
      const upgrade = start(dataPath, port);
      children.push(upgrade);
      await ready(upgrade, port);
      await stop(upgrade);
      const damaged = await openPersistentPglite(dataPath);
      try {
        await damaged.ready;
        const state = await inspectMigrationState(damaged.client);
        assert.equal(state.status, "ready");
        const rows = await damaged.client.query<{
          created_at: string;
          applied_at: string | null;
        }>(
          "SELECT created_at, applied_at FROM drizzle.__drizzle_migrations ORDER BY id",
        );
        assert.ok(
          rows.rows.every(
            (row) =>
              Number(row.created_at) % 1000 === 321 && row.applied_at === null,
          ),
        );
        await damaged.client.exec(
          "UPDATE drizzle.__drizzle_migrations SET hash = repeat('0', 64) WHERE id = 1",
        );
      } finally {
        await damaged.close();
      }
      const incompatible = start(dataPath, port);
      children.push(incompatible);
      assert.equal((await incompatible.closed)[0], 1, incompatible.stderr());
      assert.match(incompatible.stderr(), /incompatible-history/u);
      const final = await openPersistentPglite(dataPath);
      try {
        await final.ready;
        assert.equal(
          (await inspectMigrationState(final.client)).status,
          "modified",
        );
      } finally {
        await final.close();
      }
    } finally {
      for (const run of children) {
        if (run.child.exitCode === null && run.child.signalCode === null) {
          run.child.kill("SIGKILL");
        }
      }
      await Promise.allSettled(children.map((run) => run.closed));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
