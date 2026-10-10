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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type Server, connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const binary = fileURLToPath(
  new URL("../bin/drfed-server.mjs", import.meta.resolve("@drfed/drfed")),
);
async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address != null && typeof address !== "string");
  return { server, port: address.port };
}
async function closeServer(server: Server) {
  const closed = once(server, "close");
  server.close();
  await closed;
}
function startServer(port: number, dataPath: string, preload?: string) {
  const child = spawn(
    process.execPath,
    [
      ...(preload == null ? [] : ["--import", pathToFileURL(preload).href]),
      binary,
      "--root-origin=http://drfed.test",
      "--login-origin=http://drfed.test",
      `--listen=127.0.0.1:${port}`,
      `--pglite-data-path=${dataPath}`,
      "--log-level=error",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.resume();
  const exited = once(child, "close");
  return { child, exited, stderr: () => stderr };
}

async function waitForExit(run: ReturnType<typeof startServer>) {
  const stopTimeout = new AbortController();
  const timeout = async () => {
    await delay(90_000, undefined, { signal: stopTimeout.signal });
    assert.fail(`CLI did not exit within 90 seconds: ${run.stderr()}`);
  };
  try {
    return await Promise.race([run.exited, timeout()]);
  } finally {
    stopTimeout.abort();
  }
}

async function waitForReady(run: ReturnType<typeof startServer>, port: number) {
  let ready = false;
  const readinessDeadline = performance.now() + 90_000;
  while (performance.now() < readinessDeadline) {
    assert.equal(run.child.exitCode, null, run.stderr());
    try {
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(`http://127.0.0.1:${port}/graphql`, {
        method: "POST",
        signal: AbortSignal.timeout(1000),
        headers: { "content-type": "application/json" },
        body: '{"query":"{ __typename }"}',
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Migrations and listening have not finished yet.
    }
    // oxlint-disable-next-line no-await-in-loop
    await delay(100);
  }
  assert.ok(ready, run.stderr());
}

it("preserves a listen error when server startup fails", async () => {
  const { server, port } = await reservePort();
  const dataPath = await mkdtemp(join(tmpdir(), "drfed-startup-"));
  const run = startServer(port, dataPath);
  try {
    const [code] = await waitForExit(run);
    assert.equal(code, 1);
    assert.match(run.stderr(), /EADDRINUSE/u);
  } finally {
    run.child.kill("SIGKILL");
    await closeServer(server);
    await rm(dataPath, { recursive: true, force: true });
  }
});

it("preserves a listen error when database cleanup rejects", async () => {
  const { server, port } = await reservePort();
  const dataPath = await mkdtemp(join(tmpdir(), "drfed-cleanup-"));
  const preload = join(dataPath, "cleanup-failure.mjs");
  await writeFile(
    preload,
    `import { PGlite } from ${JSON.stringify(import.meta.resolve("@electric-sql/pglite"))};
const close = PGlite.prototype.close;
PGlite.prototype.close = async function () {
  await close.call(this);
  throw new Error("PRIVATE_CLEANUP_ERROR");
};
`,
  );
  const run = startServer(port, dataPath, preload);
  try {
    const [code] = await waitForExit(run);
    assert.equal(code, 1);
    assert.match(run.stderr(), /EADDRINUSE/u);
    assert.match(
      run.stderr(),
      /Database cleanup after startup failure failed/u,
    );
    assert.doesNotMatch(run.stderr(), /PRIVATE_CLEANUP_ERROR/u);
  } finally {
    run.child.kill("SIGKILL");
    await closeServer(server);
    await rm(dataPath, { recursive: true, force: true });
  }
});

it("closes the database when a later resource fails to initialize", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "drfed-partial-"));
  const preload = join(dataPath, "partial-failure.mjs");
  const closedMarker = join(dataPath, "database-closed");
  await writeFile(
    preload,
    `import { registerHooks } from "node:module";
import { writeFile } from "node:fs/promises";
import { PGlite } from ${JSON.stringify(import.meta.resolve("@electric-sql/pglite"))};
const close = PGlite.prototype.close;
PGlite.prototype.close = async function () {
  await close.call(this);
  await writeFile(${JSON.stringify(closedMarker)}, "closed");
};
const target = ${JSON.stringify(import.meta.resolve("@upyo/logtape"))};
registerHooks({
  load(url, context, nextLoad) {
    if (url !== target) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: 'export class LogTapeTransport { constructor() { throw new Error("INJECTED_MAILER_FAILURE"); } }',
    };
  }
});
`,
  );
  const run = startServer(8888, dataPath, preload);
  try {
    const [code] = await waitForExit(run);
    assert.equal(code, 1, run.stderr());
    assert.match(run.stderr(), /INJECTED_MAILER_FAILURE/u);
    assert.equal(await readFile(closedMarker, "utf-8"), "closed");
  } finally {
    run.child.kill("SIGKILL");
    await rm(dataPath, { recursive: true, force: true });
  }
});

it(
  "drains an active migration before closing the database on SIGTERM",
  { skip: process.platform === "win32" },
  async () => {
    const dataPath = await mkdtemp(join(tmpdir(), "drfed-migration-stop-"));
    const preload = join(dataPath, "migration-delay.mjs");
    const startedMarker = join(dataPath, "migration-started");
    const closedMarker = join(dataPath, "database-closed");
    await writeFile(
      preload,
      `import { PGlite } from ${JSON.stringify(import.meta.resolve("@electric-sql/pglite"))};
import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
let active = 0;
let delayed = false;
const query = PGlite.prototype.query;
PGlite.prototype.query = async function (...args) {
  active++;
  try {
    if (!delayed) {
      delayed = true;
      await writeFile(${JSON.stringify(startedMarker)}, "started");
      await setTimeout(500);
    }
    return await query.apply(this, args);
  } finally { active--; }
};
const close = PGlite.prototype.close;
PGlite.prototype.close = async function () {
  if (active !== 0) throw new Error("DATABASE_CLOSED_DURING_MIGRATION");
  await close.call(this);
  await writeFile(${JSON.stringify(closedMarker)}, "closed");
};
`,
    );
    const run = startServer(8888, dataPath, preload);
    try {
      let started = false;
      const deadline = performance.now() + 30_000;
      // The read rejects until the child creates the marker; the catch repeats.
      // oxlint-disable-next-line no-unreachable-loop
      while (performance.now() < deadline) {
        assert.equal(run.child.exitCode, null, run.stderr());
        try {
          // oxlint-disable-next-line no-await-in-loop
          await readFile(startedMarker);
          started = true;
          break;
        } catch {
          // Wait until the migration has reached the delayed database operation.
          // oxlint-disable-next-line no-await-in-loop
          await delay(50);
          continue;
        }
      }
      assert.ok(started, run.stderr());
      run.child.kill("SIGTERM");
      const [code, signal] = await waitForExit(run);
      assert.equal(signal, null);
      assert.equal(code, 0, run.stderr());
      assert.equal(await readFile(closedMarker, "utf-8"), "closed");
    } finally {
      run.child.kill("SIGKILL");
      await rm(dataPath, { recursive: true, force: true });
    }
  },
);

for (const stage of ["resolver", "context", "graceful"] as const) {
  it(
    stage === "graceful"
      ? "finishes an accepted GraphQL response during graceful shutdown"
      : `drains ${stage} work after force-closing its HTTP connection`,
    { skip: process.platform === "win32" },
    async () => {
      const { server, port } = await reservePort();
      await closeServer(server);
      const dataPath = await mkdtemp(join(tmpdir(), "drfed-request-stop-"));
      const preload = join(dataPath, "request-delay.mjs");
      const armMarker = join(dataPath, "delay-request");
      const startedMarker = join(dataPath, "request-started");
      const closedMarker = join(dataPath, "database-closed");
      await writeFile(
        preload,
        `import { PGlite } from ${JSON.stringify(import.meta.resolve("@electric-sql/pglite"))};
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
let active = 0;
let delayed = false;
const query = PGlite.prototype.query;
PGlite.prototype.query = async function (...args) {
  active++;
  try {
    if (!delayed && existsSync(${JSON.stringify(armMarker)})) {
      delayed = true;
      await writeFile(${JSON.stringify(startedMarker)}, "started");
      await setTimeout(${stage === "graceful" ? 1000 : 6000});
    }
    return await query.apply(this, args);
  } finally { active--; }
};
const close = PGlite.prototype.close;
PGlite.prototype.close = async function () {
  if (active !== 0) throw new Error("DATABASE_CLOSED_DURING_REQUEST");
  await close.call(this);
  await writeFile(${JSON.stringify(closedMarker)}, "closed");
};
`,
      );
      const run = startServer(port, dataPath, preload);
      let request: Promise<Response | undefined> | undefined;
      try {
        await waitForReady(run, port);
        await writeFile(armMarker, "armed");
        // A force-closed response is expected; observe rejection immediately.
        request = (async () => {
          try {
            return await fetch(`http://127.0.0.1:${port}/graphql`, {
              method: "POST",
              signal: AbortSignal.timeout(20_000),
              headers: {
                "content-type": "application/json",
                ...(stage === "context"
                  ? { authorization: "Bearer missing-token" }
                  : {}),
              },
              body: JSON.stringify({
                query:
                  stage === "context"
                    ? "{ __typename }"
                    : 'mutation { loginByEmail(email: "missing@example.com", verifyUrl: "http://drfed.test/verify?challengeId={challengeId}&code={code}") { challengeId } }',
              }),
            });
          } catch {
            return undefined;
          }
        })();
        const deadline = performance.now() + 10_000;
        let started = false;
        // The read rejects until the request reaches the delayed DB query.
        // oxlint-disable-next-line no-unreachable-loop
        while (performance.now() < deadline) {
          try {
            // oxlint-disable-next-line no-await-in-loop
            await readFile(startedMarker);
            started = true;
            break;
          } catch {
            // oxlint-disable-next-line no-await-in-loop
            await delay(50);
            continue;
          }
        }
        assert.ok(started, run.stderr());
        run.child.kill("SIGTERM");
        const [code, signal] = await waitForExit(run);
        assert.equal(signal, null);
        assert.equal(code, 0, run.stderr());
        if (stage === "graceful") {
          const response = await request;
          assert.ok(
            response,
            "accepted request lost its response during graceful shutdown",
          );
          assert.equal(response.status, 200);
          const result = await response.json();
          assert.equal(result.errors, undefined, JSON.stringify(result));
          assert.ok(result.data.loginByEmail.challengeId);
        }
        assert.equal(await readFile(closedMarker, "utf-8"), "closed");
      } finally {
        run.child.kill("SIGKILL");
        await request;
        await rm(dataPath, { recursive: true, force: true });
      }
    },
  );
}

it(
  "force-closes a stalled upload and exits normally on SIGTERM",
  {
    // Windows child.kill("SIGTERM") forcibly terminates without running handlers.
    skip: process.platform === "win32",
  },
  async () => {
    const { server, port } = await reservePort();
    await closeServer(server);
    const dataPath = await mkdtemp(join(tmpdir(), "drfed-shutdown-"));
    const run = startServer(port, dataPath);
    try {
      await waitForReady(run, port);
      const stalled = connect({ host: "127.0.0.1", port });
      // Force-closing a stalled upload may reset its socket.
      stalled.on("error", () => undefined);
      try {
        await once(stalled, "connect");
        stalled.write(
          "POST /graphql HTTP/1.1\r\nHost: drfed.test\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{",
        );
        await delay(100);
        run.child.kill("SIGTERM");
        const [code, signal] = await waitForExit(run);
        assert.equal(signal, null);
        assert.equal(code, 0, run.stderr());
      } finally {
        stalled.destroy();
      }
    } finally {
      run.child.kill("SIGKILL");
      await rm(dataPath, { recursive: true, force: true });
    }
  },
);
