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
// Pack and install serially to bound resource use; restarts share one database.
// oxlint-disable no-console node/no-top-level-await no-await-in-loop
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "drfed-packaging-"));
const packages = ["models", "federation", "graphql", "drfed"];
const windows = process.platform === "win32";
const npm = windows
  ? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
  : resolve(
      dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    );
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !/^npm_config_/iu.test(key) &&
      !["NODE_OPTIONS", "NODE_PATH", "TEST"].includes(key),
  ),
);
const pathKey =
  Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ""}`;
env.npm_config_cache = join(temporary, "cache");
env.npm_config_userconfig = join(temporary, "npmrc");
env.npm_config_globalconfig = join(temporary, "global-npmrc");
env.npm_config_registry = "https://registry.npmjs.org/";

interface Manifest {
  name: string;
  version: string;
  main: string;
  types: string;
  dependencies?: Record<string, string>;
  exports?: unknown;
  bin?: Record<string, string>;
}

async function run(command: string, args: string[], cwd: string) {
  return await execute(command, args, {
    cwd,
    env,
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function pack(name: string) {
  const { stdout } = await run(
    "pnpm",
    ["pack", "--json", "--pack-destination", temporary],
    join(root, "packages", name),
  );
  const result = JSON.parse(stdout) as {
    filename: string;
    files: { path: string }[];
  };
  const archive = resolve(temporary, result.filename);
  const packed = await run(
    "tar",
    ["-xOf", archive, "package/package.json"],
    temporary,
  );
  const manifest = JSON.parse(packed.stdout) as Manifest;
  const source = JSON.parse(
    await readFile(join(root, "packages", name, "package.json"), "utf8"),
  ) as Manifest;
  assert.equal(manifest.name, source.name);
  assert.equal(manifest.version, source.version);
  for (const version of Object.values(manifest.dependencies ?? {})) {
    assert.ok(!/^(?:workspace:|catalog:|file:|link:)/u.test(version), version);
  }
  const files = new Set(result.files.map(({ path }) => path));
  function checkTargets(value: unknown): void {
    if (typeof value === "string") {
      assert.ok(
        files.has(value.replace(/^\.\//u, "")),
        `Missing packed entry: ${value}`,
      );
    } else if (value != null && typeof value === "object") {
      Object.values(value).forEach(checkTargets);
    }
  }
  checkTargets(manifest.main);
  checkTargets(manifest.types);
  checkTargets(manifest.exports);
  checkTargets(manifest.bin);
  assert.ok(![...files].some((path) => path.startsWith("src/")));
  if (name === "models") {
    const migrations = await readdir(join(root, "packages/models/drizzle"), {
      recursive: true,
    });
    const sql = migrations.filter((path) => path.endsWith(".sql"));
    assert.ok(sql.length > 0);
    for (const path of sql) {
      assert.ok(
        files.has(`drizzle/${path.replaceAll("\\", "/")}`),
        `Missing packed migration: ${path}`,
      );
    }
  }
  console.log(`Packed ${manifest.name}@${manifest.version}`);
  return { archive, manifest };
}

// oxlint-disable-next-line max-statements
async function smoke(
  binary: string,
  cwd: string,
  dataPath: string,
  migrate: boolean,
) {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const address = socket.address();
  assert.ok(address != null && typeof address !== "string");
  await socket[Symbol.asyncDispose]();
  const child = spawn(
    process.execPath,
    [
      binary,
      `--listen=127.0.0.1:${address.port}`,
      `--data-path=${dataPath}`,
      "--root-origin=http://drfed.test",
      "--login-origin=http://drfed.test",
      "--log-level=error",
      ...(migrate ? [] : ["--no-migrate"]),
    ],
    {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      killSignal: "SIGKILL",
    },
  );
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<{
    code: number | null;
    signal: string | null;
  }>();
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-65_536);
    if (output.includes("Listening on:")) ready.resolve();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-65_536);
  });
  child.once("error", ready.reject);
  child.once("close", (code, signal) => {
    ready.reject(
      new Error(
        `Installed CLI exited before readiness (${code}, ${signal}): ${output}`,
      ),
    );
    closed.resolve({ code, signal });
  });
  let result;
  try {
    await ready.promise;
    const response = await fetch(`http://127.0.0.1:${address.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        query: `mutation Login($email: Email!, $verifyUrl: URITemplate!) {
          loginByEmail(email: $email, verifyUrl: $verifyUrl) { challengeId }
        }`,
        variables: {
          email: "unknown@example.com",
          verifyUrl:
            "http://drfed.test/verify?challengeId={challengeId}&code={code}",
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.errors, undefined, JSON.stringify(body));
    assert.ok(body.data.loginByEmail.challengeId);
  } finally {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    try {
      result = await closed.promise;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!windows) assert.deepEqual(result, { code: 0, signal: null }, output);
}

try {
  await writeFile(env.npm_config_userconfig, "");
  await writeFile(env.npm_config_globalconfig, "");
  const packed = [];
  for (const name of packages) packed.push(await pack(name));
  for (const global of [false, true]) {
    const prefix = join(temporary, global ? "global" : "local");
    await mkdir(prefix);
    await writeFile(
      join(prefix, "package.json"),
      '{"private":true,"type":"module"}',
    );
    await run(
      process.execPath,
      [
        npm,
        "install",
        ...(global ? ["--global", "--prefix", prefix] : []),
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...packed.map(({ archive }) => archive),
      ],
      prefix,
    );
    const modules =
      global && !windows
        ? join(prefix, "lib/node_modules")
        : join(prefix, "node_modules");
    const application = join(modules, "@drfed/drfed");
    const require = createRequire(join(application, "package.json"));
    for (const { manifest } of packed) {
      const installed = JSON.parse(
        await readFile(join(modules, manifest.name, "package.json"), "utf8"),
      );
      assert.equal(installed.version, manifest.version);
      if (manifest.name !== "@drfed/drfed") {
        assert.equal(
          await realpath(require.resolve(manifest.name)),
          await realpath(join(modules, manifest.name, manifest.main)),
        );
      }
    }
    const binary = join(application, "bin/drfed-server.mjs");
    const linked = global
      ? join(prefix, windows ? "drfed-server.cmd" : "bin/drfed-server")
      : join(modules, ".bin", windows ? "drfed-server.cmd" : "drfed-server");
    if (!windows) assert.equal(await realpath(linked), await realpath(binary));
    else {
      assert.ok((await readFile(linked, "utf8")).includes("drfed-server.mjs"));
    }
    const help = windows
      ? await run(
          process.execPath,
          [
            npm,
            "exec",
            "--offline",
            ...(global ? ["--global", "--prefix", prefix] : []),
            "--",
            "drfed-server",
            "--help",
          ],
          prefix,
        )
      : await run(linked, ["--help"], prefix);
    assert.ok(help.stdout.includes("--root-origin"));
    await smoke(binary, prefix, join(prefix, "data"), true);
    await smoke(binary, prefix, join(prefix, "data"), false);
    console.log(
      `${global ? "Global" : "Local"} npm install: bin, GraphQL, migration and persistent restart passed`,
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
