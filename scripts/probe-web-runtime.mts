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
// oxlint-disable no-console node/no-top-level-await
import { spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const bindingSource = `
export const binding = { value: "unset", closes: 0 };
`;

const entrySource = `
import "#nitro/virtual/polyfills";
import { useNitroApp, useNitroHooks } from "nitro/app";
import { binding } from "./binding.mjs";
const app = useNitroApp();
const hooks = useNitroHooks();
hooks.hook("close", () => { binding.closes++; });
export const readBinding = () => binding.value;
export const fetch = app.fetch;
export const close = () => hooks.callHook("close");
`;

const verificationSource = String.raw`
import assert from "node:assert/strict";
import { Server } from "node:net";
import { binding } from "./probe/binding.mjs";

// A runtime error handler can swallow assertions, so failure is the default.
process.exitCode = 1;

// Fail even a transient listen attempt; handle-count inspection alone could
// miss a listener opened and closed during import.
let listenAttempts = 0;
Server.prototype.listen = function () {
  listenAttempts++;
  throw new Error("Unexpected listener");
};
const watched = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"];
const before = watched.map((name) => process.listenerCount(name));
const realFetch = globalThis.fetch;
let backendRequests = 0;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url === "http://backend.invalid/graphql") {
    backendRequests++;
    return Response.json({ data: { viewer: null } });
  }
  throw new Error("Unexpected network request: " + request.url);
};
process.argv = [process.execPath, "verify.mjs", "--backend-url", "http://backend.invalid"];
binding.value = "installed-before-import";
const runtime = await import("./.output/server/index.mjs");
assert.equal(listenAttempts, 0);
assert.equal(runtime.readBinding(), binding.value);
binding.value = "updated-after-import";
assert.equal(runtime.readBinding(), binding.value);
assert.deepEqual(watched.map((name) => process.listenerCount(name)), before);
try {
  const page = await runtime.fetch(new Request("http://drfed.localhost/about"));
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /DrFed/);
  assert.ok(backendRequests > 0, "SSR must reach the GraphQL stub");
  const asset = await runtime.fetch(new Request("http://drfed.localhost/icon.svg"));
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(await asset.text(), /<svg/);
  assert.equal(listenAttempts, 0);
  assert.deepEqual(watched.map((name) => process.listenerCount(name)), before);
} finally {
  await runtime.close();
  globalThis.fetch = realFetch;
}
assert.equal(binding.closes, 1);
assert.equal(listenAttempts, 0);
assert.deepEqual(watched.map((name) => process.listenerCount(name)), before);
process.exitCode = 0;
console.log("Verified embedded SolidStart/Nitro runtime without HTTP listening.");
`;

const root = fileURLToPath(new URL("../", import.meta.url));
const web = join(root, "packages", "web");
const requireWeb = createRequire(join(web, "package.json"));
const vite = join(
  dirname(requireWeb.resolve("vite/package.json")),
  "bin",
  "vite.js",
);
const work = await realpath(await mkdtemp(join(tmpdir(), "drfed-web-probe-")));

try {
  await prepareFixture();
  await run([vite, "build"], work, 120_000);
  await run([join(work, "verify.mjs")], work, 30_000);
  console.log(
    "Web runtime probe passed: SSR, static assets, external binding, close, no listener.",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

async function prepareFixture(): Promise<void> {
  // Build the actual application with its generated Relay artifacts, without
  // rewriting the checked-out Vite config or production output.
  await Promise.all(
    ["src", "public"].map((name) =>
      cp(join(web, name), join(work, name), { recursive: true }),
    ),
  );
  await mkdir(join(work, "node_modules"));
  const dependencies = await readdir(join(web, "node_modules"));
  await Promise.all(
    dependencies
      .filter((name) => !name.startsWith("."))
      .map((name) =>
        symlink(
          join(web, "node_modules", name),
          join(work, "node_modules", name),
          process.platform === "win32" ? "junction" : "dir",
        ),
      ),
  );
  await writeFile(join(work, "package.json"), '{"type":"module"}');
  const tsconfig = JSON.parse(
    await readFile(join(web, "tsconfig.json"), "utf8"),
  );
  tsconfig.extends = join(root, "tsconfig.json");
  await writeFile(join(work, "tsconfig.json"), JSON.stringify(tsconfig));
  await mkdir(join(work, "probe"));
  await writeFile(join(work, "probe", "binding.mjs"), bindingSource);
  await writeFile(
    join(work, "probe", "entry.mjs"),
    entrySource.replace(
      '"./binding.mjs"',
      JSON.stringify(pathToFileURL(join(work, "probe", "binding.mjs")).href),
    ),
  );
  await writeFile(join(work, "verify.mjs"), verificationSource);
  const original = await readFile(join(web, "vite.config.ts"), "utf8");
  const marker = "nitro(),";
  if (original.split(marker).length !== 2) {
    throw new Error(
      "Expected exactly one nitro() plugin in the current Vite config.",
    );
  }
  const binding = join(work, "probe", "binding.mjs");
  const options = JSON.stringify({
    preset: "node-server",
    buildDir: join(work, ".nitro"),
    entry: join(work, "probe", "entry.mjs"),
    rollupConfig: { external: [binding, pathToFileURL(binding).href] },
  });
  await writeFile(
    join(work, "vite.config.ts"),
    original
      .replace(marker, `nitro(${options}),`)
      .replace(
        "plugins: [",
        `cacheDir: ${JSON.stringify(join(work, ".vite"))}, plugins: [`,
      ),
  );
}

async function run(
  args: string[],
  cwd: string,
  timeout: number,
): Promise<void> {
  // oxlint-disable-next-line promise/avoid-new
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error(`Probe subprocess exceeded ${timeout}ms.`);
      child.kill("SIGKILL");
    }, timeout);
    child.once("error", (error) => {
      failure = error;
    });
    // Wait for stdio and the child to close before removing its working files.
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (failure !== undefined) {
        reject(failure);
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`Probe subprocess failed: code=${code}, signal=${signal}.`),
        );
      }
    });
  });
}
