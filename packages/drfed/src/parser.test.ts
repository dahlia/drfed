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
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { describe, it } from "@logtape/testing-node/autoload";

const execFileAsync = promisify(execFile);

const commandTimeout = 30_000;

// Exercise the built command so parser and startup behavior stay aligned with
// what installed users receive.
const binary = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "drfed-server.mjs",
);

async function run(
  args: readonly string[],
  preload?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        ...(preload == null ? [] : ["--import", pathToFileURL(preload).href]),
        binary,
        ...args,
      ],
      {
        // A deliberately minimal environment, independent of what the
        // developer happens to have exported.
        env: { PATH: process.env.PATH ?? "" },
        timeout: commandTimeout,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (e) {
    const error = e as { code?: number; stdout?: string; stderr?: string };
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

describe("drfed-server", () => {
  it("requires --root-origin to serve", async () => {
    const { code, stderr } = await run(["--data-path", "/nonexistent-drfed"]);

    assert.notEqual(code, 0);
    assert.match(stderr, /Missing option .*--root-origin/u);
  });

  it("advertises --root-origin as required in its help", async () => {
    const { code, stdout } = await run(["--help"]);
    assert.equal(code, 0);
    // Optional options are bracketed in the usage line; this one must not be.
    assert.match(stdout, /--root-origin\/-r ORIGIN/u);
    assert.doesNotMatch(stdout, /\[--root-origin/u);
  });

  it("no longer accepts the old --root-domain option", async () => {
    // If the retired option were reinstated, parsing would instead stop on
    // the missing --login-origin, which says something else entirely.
    const dataPath = await mkdtemp(join(tmpdir(), "drfed-parser-test-"));
    try {
      const { code, stderr } = await run([
        "--data-path",
        dataPath,
        "--root-origin=https://drfed.net",
        "--root-domain=drfed.net",
      ]);
      assert.notEqual(code, 0);
      // The message names the offending token, so this cannot pass for some
      // other reason.
      assert.match(stderr, /Unexpected option or argument: "--root-domain/u);
    } finally {
      await rm(dataPath, { force: true, recursive: true });
    }
  });

  it("rejects a root origin that names an IP address", async () => {
    const { code, stderr } = await run([
      "--data-path",
      "/nonexistent-drfed",
      "--root-origin=http://127.0.0.1:8888",
    ]);
    assert.notEqual(code, 0);
    assert.match(stderr, /IP address/u);
  });

  it("accepts --email-from and rejects a malformed address", async () => {
    const dataPath = await mkdtemp(join(tmpdir(), "drfed-parser-test-"));
    try {
      // Valid: parsing gets past the option and stops only on the missing
      // required --login-origin option.
      const accepted = await run([
        "--data-path",
        dataPath,
        "--root-origin=https://drfed.net",
        "--email-from=postmaster@mail.example",
      ]);
      assert.notEqual(accepted.code, 0);
      assert.match(
        accepted.stderr,
        /Expected at least 1 values, but got only 0\./u,
      );

      const rejected = await run([
        "--data-path",
        dataPath,
        "--root-origin=https://drfed.net",
        "--login-origin=https://drfed.net",
        "--email-from=not-an-address",
      ]);
      assert.notEqual(rejected.code, 0);
      assert.match(rejected.stderr, /Expected a valid email address/u);
    } finally {
      await rm(dataPath, { force: true, recursive: true });
    }
  });

  it("generates the GraphQL schema without a root origin", async () => {
    // Schema generation is the other branch of the parser and must stay
    // usable without any deployment configuration.
    const { code, stdout } = await run([
      "--generate-graphql-schema",
      "--output-file",
      "-",
    ]);
    assert.equal(code, 0);
    assert.match(stdout, /type Query/u);
  });
  it("keeps help, version, schema and parse failures resource-free", async () => {
    const parent = await mkdtemp(join(tmpdir(), "drfed-pure-cli-"));
    const dataPath = join(parent, "must-not-exist");
    const preload = join(parent, "reject-resources.mjs");
    try {
      await writeFile(
        preload,
        `
      import { registerHooks } from "node:module";
      const constructors = new Map([
        ["@electric-sql/pglite", "PGlite"],
        ["postgres", "default"],
        ["@upyo/smtp", "SmtpTransport"],
        ["@upyo/logtape", "LogTapeTransport"],
      ]);
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const resolved = nextResolve(specifier, context);
          const name = constructors.get(specifier);
          if (name == null) return resolved;
          const target = JSON.stringify(resolved.url);
          const source = name === "default"
            ? "export * from " + target + "; export default function () { throw new Error('EARLY_RESOURCE_CONSTRUCTION'); }"
            : "export * from " + target + ";" +
            "import { " + name + " as Original } from " + target + ";" +
            "export class " + name + " extends Original {" +
            "constructor() { throw new Error('EARLY_RESOURCE_CONSTRUCTION'); } }";
          return { url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true };
        },
      });
    `,
      );

      const base = [
        "--root-origin=http://drfed.test",
        "--login-origin=http://drfed.test",
        "--smtp-url=smtp://localhost:25",
      ];
      // Both database branches must stay resource-free through early exits.
      for (const database of [
        `--data-path=${dataPath}`,
        "--database-url=postgres://localhost/drfed",
      ]) {
        for (const suffix of [
          ["--help"],
          ["--version"],
          ["--unknown-option"],
        ]) {
          // oxlint-disable-next-line no-await-in-loop
          const result = await run([...base, database, ...suffix], preload);
          assert.equal(
            result.code,
            suffix[0] === "--unknown-option" ? 1 : 0,
            result.stderr,
          );
          // oxlint-disable-next-line no-await-in-loop
          await assert.rejects(access(dataPath), { code: "ENOENT" });
          assert.doesNotMatch(result.stderr, /EARLY_RESOURCE_CONSTRUCTION/u);
        }
      }
      const schema = await run(["--generate-graphql-schema"], preload);
      assert.equal(schema.code, 0, schema.stderr);
      assert.match(schema.stdout, /type Query/u);
      const startup = await run([...base, `--data-path=${dataPath}`], preload);
      assert.equal(startup.code, 1);
      assert.match(startup.stderr, /EARLY_RESOURCE_CONSTRUCTION/u);
      await assert.rejects(access(dataPath), { code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
