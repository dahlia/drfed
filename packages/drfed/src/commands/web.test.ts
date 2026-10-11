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
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { createServer as createSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const binary = fileURLToPath(
  new URL("../bin/drfed-web.mjs", import.meta.resolve("@drfed/drfed")),
);

async function command(args: string[], cwd: string, preload: string) {
  try {
    const result = await execute(
      process.execPath,
      ["--import", pathToFileURL(preload).href, binary, ...args],
      { cwd, env: { PATH: process.env.PATH ?? "" }, timeout: 30_000 },
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

it("keeps web metadata, diagnostics and parse failures resource-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-web-pure-"));
  try {
    const preload = join(directory, "guard.mjs");
    const logPath = join(directory, "must-not-open.log");
    await writeFile(
      preload,
      `import { registerHooks } from "node:module";
import { Server } from "node:net";
Server.prototype.listen = function () { throw new Error("EARLY_LISTENER"); };
registerHooks({ resolve(specifier, context, next) {
 const result = next(specifier, context);
 if (specifier === "@drfed/web") return { url: "data:text/javascript," + encodeURIComponent("export function createWebRuntime(){throw new Error('EARLY_WEB')}"), shortCircuit: true };
 if (specifier === "@optique/logtape") return { url: "data:text/javascript," + encodeURIComponent("export * from " + JSON.stringify(result.url) + "; export function createLoggingConfig(){throw new Error('EARLY_LOGGING')}"), shortCircuit: true };
 return result;
}});
`,
    );
    const base = [
      "--public-origin=https://app.example",
      "--backend-url=http://backend.example",
      `--log-output=${logPath}`,
    ];
    const help = await command(["--help"], directory, preload);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--backend-url/u);
    const version = await command(["--version"], directory, preload);
    assert.equal(version.code, 0);
    const diagnostic = await command(
      [...base, "--print-config"],
      directory,
      preload,
    );
    assert.equal(diagnostic.code, 0, diagnostic.stderr);
    assert.equal(JSON.parse(diagnostic.stdout).command, "web");
    const invalid = await command(
      [...base, "--backend-url=ftp://invalid.example"],
      directory,
      preload,
    );
    assert.equal(invalid.code, 1);
    assert.doesNotMatch(
      help.stderr + version.stderr + diagnostic.stderr + invalid.stderr,
      /EARLY_/u,
    );
    await assert.rejects(access(logPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it(
  "serves standalone SSR and assets through its fixed HTTP backend and stops cleanly",
  { timeout: 30_000 },
  async () => {
    const received: {
      path: string | undefined;
      auth: string | undefined;
      cookie: string | undefined;
    }[] = [];
    let holdBody = false;
    const bodyStarted = Promise.withResolvers<void>();
    const bodyClosed = Promise.withResolvers<void>();
    const backend = createServer((request, response) => {
      received.push({
        path: request.url,
        auth: request.headers.authorization,
        cookie: request.headers.cookie,
      });
      request.resume();
      request.once("end", () => {
        response.setHeader("content-type", "application/json");
        if (holdBody) {
          response.write('{"data":');
          response.once("close", () => bodyClosed.resolve());
          bodyStarted.resolve();
        } else {
          response.end(JSON.stringify({ data: { viewer: null } }));
        }
      });
    });
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    const backendAddress = backend.address();
    assert.ok(backendAddress !== null && typeof backendAddress !== "string");
    const socket = createSocket();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const address = socket.address();
    assert.ok(address !== null && typeof address !== "string");
    await socket[Symbol.asyncDispose]();
    const publicOrigin = `https://localhost:${address.port}`;
    const child = spawn(
      process.execPath,
      [
        "--expose-gc",
        "--import=data:text/javascript,setInterval(() => globalThis.gc(), 50).unref()",
        binary,
        `--public-origin=${publicOrigin}`,
        `--backend-url=http://127.0.0.1:${backendAddress.port}`,
        `--listen=127.0.0.1:${address.port}`,
      ],
      {
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const ready = Promise.withResolvers<null>();
    const closed = Promise.withResolvers<{
      code: number | null;
      signal: string | null;
    }>();
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Listening on:")) ready.resolve(null);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", ready.reject);
    child.once("close", (code, signal) => {
      ready.reject(new Error(`Web CLI exited before ready: ${output}`));
      closed.resolve({ code, signal });
    });
    let result;
    let heldRequest: ReturnType<typeof httpRequest> | undefined;
    try {
      await ready.promise;
      const base = `http://localhost:${address.port}`;
      const page = await fetch(`${base}/about`, {
        headers: {
          cookie: `session=${"A".repeat(43)}; unrelated=PRIVATE`,
          authorization: "Bearer IGNORED",
          "x-forwarded-host": "evil.test",
        },
      });
      assert.equal(page.status, 200);
      assert.match(await page.text(), /DrFed/u);
      assert.ok(received.length > 0);
      assert.ok(
        received.every(
          (request) =>
            request.path === "/graphql" &&
            request.auth === `Bearer ${"A".repeat(43)}` &&
            request.cookie === undefined,
        ),
      );
      const count = received.length;
      const denied = await fetch(`${base}/_server%2f..%2fabout`, {
        method: "POST",
        headers: { origin: `https://instance.localhost:${address.port}` },
        body: "invalid serialized body",
      });
      assert.equal(denied.status, 403);
      assert.equal(received.length, count);
      const rejected = Promise.withResolvers<number>();
      const outgoing = httpRequest(
        `${base}/about`,
        { headers: { host: `evil.localhost:${address.port}` } },
        (response) => {
          response.resume();
          rejected.resolve(response.statusCode ?? 0);
        },
      );
      outgoing.once("error", rejected.reject);
      outgoing.end();
      assert.equal(await rejected.promise, 421);
      const asset = await fetch(`${base}/icon.svg`);
      assert.equal(asset.status, 200);
      assert.match(await asset.text(), /<svg/u);
      holdBody = true;
      heldRequest = httpRequest(`${base}/about`, (response) => {
        response.resume();
      });
      heldRequest.on("error", () => {
        // Forced HTTP closure during shutdown may reset the test connection.
      });
      heldRequest.end();
      await bodyStarted.promise;
      // Exercise cancellation after collection of the transient fetch request.
      await delay(250);
    } finally {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        result = await closed.promise;
        if (process.platform !== "win32") await bodyClosed.promise;
      } finally {
        heldRequest?.destroy();
        clearTimeout(timer);
        await backend[Symbol.asyncDispose]();
      }
    }
    if (process.platform !== "win32") {
      assert.deepEqual(result, { code: 0, signal: null }, output);
    }
  },
);

it("closes an acquired web runtime when HTTP listener startup fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-web-rollback-"));
  try {
    const preload = join(directory, "rollback.mjs");
    const closed = join(directory, "closed.txt");
    const source = `import { writeFile } from 'node:fs/promises'; export async function createWebRuntime(){return {fetch:()=>Response.json({}),close:()=>writeFile(${JSON.stringify(closed)},'closed')}}`;
    await writeFile(
      preload,
      `import { registerHooks } from "node:module";
import { Server } from "node:net";
Server.prototype.listen = function () { throw new Error("LISTEN_FAILED"); };
const source = ${JSON.stringify(source)};
registerHooks({ resolve(specifier, context, next) {
 const result = next(specifier, context);
 if (specifier !== "@drfed/web") return result;
 return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
}});
`,
    );
    const result = await command(
      [
        "--public-origin=http://app.example",
        "--backend-url=http://backend.example",
      ],
      directory,
      preload,
    );
    assert.equal(result.code, 1);
    assert.equal(await readFile(closed, "utf8"), "closed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
