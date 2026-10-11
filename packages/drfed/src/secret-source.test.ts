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
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import {
  readSecretSource,
  resolveSecretSource,
} from "@drfed/drfed/secret-source";

it("selects one credential variant by source and rejects same-source ambiguity", () => {
  assert.deepEqual(
    resolveSecretSource(
      { source: "config", value: "IGNORED" },
      { source: "cli", value: "secret" },
      "test",
      "/work",
    ),
    { type: "file", path: "/work/secret" },
  );
  assert.deepEqual(
    resolveSecretSource(
      { source: "cli", value: "SELECTED" },
      { source: "env", value: "missing" },
      "test",
    ),
    { type: "literal", value: "SELECTED" },
  );
  assert.throws(
    () =>
      resolveSecretSource(
        { source: "env", value: "SECRET" },
        { source: "env", value: "PRIVATE_PATH" },
        "test",
      ),
    { message: "Conflicting secret variants for test." },
  );
  assert.deepEqual(
    resolveSecretSource(
      undefined,
      {
        source: "config",
        value: "password",
        configPath: "/settings/drfed.toml",
      },
      "test",
      "/work",
    ),
    { type: "file", path: "/settings/password" },
  );
});

it("reads UTF-8 files and strips exactly one final LF or CRLF", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-secrets-"));
  const path = join(directory, "password");
  try {
    for (const [contents, expected] of [
      ["SECRET\n", "SECRET"],
      ["SECRET\r\n", "SECRET"],
      ["SECRET\n\n", "SECRET\n"],
      ["  SECRET  ", "  SECRET  "],
    ] as const) {
      // The cases intentionally rewrite the same file in order.
      // oxlint-disable-next-line no-await-in-loop
      await writeFile(path, contents);
      assert.equal(
        // oxlint-disable-next-line no-await-in-loop
        await readSecretSource({ type: "file", path }, "test"),
        expected,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects unreadable, non-regular, oversized and invalid UTF-8 files opaquely", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-secret-errors-"));
  try {
    const malformed = join(directory, "PRIVATE_INVALID_UTF8");
    const oversized = join(directory, "PRIVATE_OVERSIZED");
    await writeFile(malformed, Buffer.from([255]));
    await writeFile(oversized, Buffer.alloc(65_537));
    for (const path of [
      directory,
      join(directory, "PRIVATE_MISSING"),
      malformed,
      oversized,
    ]) {
      // oxlint-disable-next-line no-await-in-loop
      await assert.rejects(readSecretSource({ type: "file", path }, "test"), {
        message: "Unable to read secret for test.",
      });
    }
    const signal = AbortSignal.abort(new Error("stopped"));
    await assert.rejects(
      readSecretSource({ type: "literal", value: "SECRET" }, "test", signal),
      { message: "stopped" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it(
  "supports projected secret symlinks",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "drfed-secret-link-"));
    try {
      await writeFile(join(directory, "versioned-secret"), "SECRET\n");
      await symlink("versioned-secret", join(directory, "secret"));
      assert.equal(
        // oxlint-disable-next-line no-await-in-loop
        await readSecretSource(
          { type: "file", path: join(directory, "secret") },
          "test",
        ),
        "SECRET",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
