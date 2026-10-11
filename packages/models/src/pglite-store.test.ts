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
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  PgliteStoreError,
  openPersistentPglite,
} from "@drfed/models/pglite-store";

function failure(code: string): (error: unknown) => boolean {
  return (error) => error instanceof PgliteStoreError && error.code === code;
}

async function withDirectory(
  run: (path: string) => Promise<void>,
): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), "drfed-pglite-lock-"));
  try {
    await run(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

const ownerScript = `
import { openPersistentPglite, PgliteStoreError } from "@drfed/models/pglite-store";
let store;
try { store=await openPersistentPglite(process.argv[1]); }
catch (error) {
  if(error instanceof PgliteStoreError && error.code === "locked") {
    process.send({event:"locked"}); process.disconnect();
  } else { throw error; }
}
if (store) {
  await store.ready;
  await store.client.query("CREATE TABLE IF NOT EXISTS ownership_probe (value text)");
  await store.client.query("INSERT INTO ownership_probe VALUES ('persistent')");
  process.on("message", async (message) => {
    if(message === "close") {
      await store.close(); process.send({event:"closed"});process.disconnect();
    }
  });
  process.send({event:"ready"});
}
`;

function spawnOwner(path: string): ChildProcess {
  return spawn(
    process.execPath,
    ["--input-type=module", "-e", ownerScript, path],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
}

async function message(child: ChildProcess): Promise<string> {
  const [value] = await once(child, "message", {
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(value && typeof value === "object" && "event" in value);
  return String(value.event);
}

async function stopOwner(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Resume only our own child before terminating it, including failed suspend tests.
  if (process.platform !== "win32") child.kill("SIGCONT");
  const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
  child.kill("SIGKILL");
  await exited;
}

it(
  "keeps a canonical persistent store exclusive until database close completes",
  { timeout: 20_000 },
  async () => {
    await withDirectory(async (directory) => {
      const dataPath = join(directory, "data");
      const store = await openPersistentPglite(dataPath);
      let release: () => void = () => {
        throw new Error("close gate missing");
      };
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalClose = store.client.close.bind(store.client);
      try {
        await store.ready;
        assert.equal(store.dataPath, await realpath(dataPath));
        await store.client.query("CREATE TABLE persistent_probe (value text)");
        await store.client.query(
          "INSERT INTO persistent_probe VALUES ('saved')",
        );
        const alias = join(directory, "alias");
        await symlink(dataPath, alias, "junction");
        await assert.rejects(openPersistentPglite(alias), failure("locked"));
        store.client.close = async () => {
          await gate;
          await originalClose();
        };
        const closing = store.close();
        assert.equal(store.close(), closing);
        await assert.rejects(openPersistentPglite(dataPath), failure("locked"));
        release();
        await closing;
        const reopened = await openPersistentPglite(alias);
        try {
          const result = await reopened.client.query(
            "SELECT value FROM persistent_probe",
          );
          assert.deepEqual(result.rows, [{ value: "saved" }]);
          assert.equal(reopened.dataPath, store.dataPath);
        } finally {
          await reopened.close();
        }
        assert.equal((await readFile(join(dataPath, ".drfed.lock"))).length, 0);
      } finally {
        release();
        await store.close();
      }
    });
  },
);

it("rejects empty paths, non-directory data paths and non-regular lock entries", async () => {
  await assert.rejects(openPersistentPglite("  "), failure("invalid-path"));
  await withDirectory(async (directory) => {
    const file = join(directory, "file");
    await writeFile(file, "private path contents");
    await assert.rejects(openPersistentPglite(file), failure("invalid-path"));
    await mkdir(join(directory, ".drfed.lock"));
    await assert.rejects(
      openPersistentPglite(directory),
      failure("invalid-path"),
    );
  });
});

it("refuses a hard-linked lock file without truncating its existing bytes", async () => {
  await withDirectory(async (directory) => {
    const target = join(directory, "target");
    await writeFile(target, "keep existing bytes");
    await link(target, join(directory, ".drfed.lock"));
    await assert.rejects(
      openPersistentPglite(directory),
      failure("invalid-path"),
    );
    assert.equal(await readFile(target, "utf8"), "keep existing bytes");
  });
});

it(
  "gives exactly one owner a simultaneously contested directory",
  { timeout: 30_000 },
  async () => {
    await withDirectory(async (directory) => {
      const first = spawnOwner(directory);
      const second = spawnOwner(directory);
      try {
        const results = await Promise.all([message(first), message(second)]);
        assert.deepEqual([...results].sort(), ["locked", "ready"]);
        const owner = results[0] === "ready" ? first : second;
        const closed = message(owner);
        owner.send("close");
        assert.equal(await closed, "closed");
      } finally {
        await Promise.all([stopOwner(first), stopOwner(second)]);
      }
      const store = await openPersistentPglite(directory);
      try {
        assert.deepEqual(
          (await store.client.query("SELECT value FROM ownership_probe")).rows,
          [{ value: "persistent" }],
        );
      } finally {
        await store.close();
      }
    });
  },
);

it(
  "does not steal a suspended owner's lock and recovers after SIGKILL",
  { skip: process.platform === "win32", timeout: 30_000 },
  async () => {
    await withDirectory(async (directory) => {
      const owner = spawnOwner(directory);
      try {
        assert.equal(await message(owner), "ready");
        assert.equal(owner.kill("SIGSTOP"), true);
        await delay(50);
        await assert.rejects(
          openPersistentPglite(directory),
          failure("locked"),
        );
        const exited = once(owner, "exit", {
          signal: AbortSignal.timeout(10_000),
        });
        owner.kill("SIGKILL");
        await exited;
        const recovered = await openPersistentPglite(directory);
        try {
          assert.deepEqual(
            (await recovered.client.query("SELECT value FROM ownership_probe"))
              .rows,
            [{ value: "persistent" }],
          );
        } finally {
          await recovered.close();
        }
      } finally {
        await stopOwner(owner);
      }
    });
  },
);

it(
  "holds a failed-close lock until its owner process exits",
  { timeout: 30_000 },
  async () => {
    await withDirectory(async (directory) => {
      const script = `
import assert from "node:assert/strict";
import { openPersistentPglite, PgliteStoreError } from "@drfed/models/pglite-store";
const store = await openPersistentPglite(process.argv[1]); await store.ready;
const actualClose=store.client.close.bind(store.client);
store.client.close=async()=>{throw new Error("PRIVATE_FAILURE");};
await assert.rejects(store.close(), error=>error instanceof PgliteStoreError && error.code === "close-failed" && !error.stack.includes("PRIVATE_FAILURE"));
await assert.rejects(openPersistentPglite(process.argv[1]), error=>error instanceof PgliteStoreError && error.code === "locked");
await actualClose(); process.send({event:"retained"});process.disconnect();
`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script, directory],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      try {
        const exited = once(child, "exit", {
          signal: AbortSignal.timeout(15_000),
        });
        assert.equal(await message(child), "retained");
        const [code] = await exited;
        assert.equal(code, 0);
        const recovered = await openPersistentPglite(directory);
        await recovered.close();
      } finally {
        await stopOwner(child);
      }
    });
  },
);

it(
  "exposes sanitized initialization failure without losing the close boundary",
  { timeout: 30_000 },
  async () => {
    await withDirectory(async (directory) => {
      await writeFile(
        join(directory, "PG_VERSION"),
        "invalid PRIVATE_STORAGE_FAILURE",
      );
      const script = `
import assert from "node:assert/strict";
import { openPersistentPglite, PgliteStoreError } from "@drfed/models/pglite-store";
const store=await openPersistentPglite(process.argv[1]);
await assert.rejects(store.ready, error=>error instanceof PgliteStoreError && error.code === "open-failed" && !error.stack.includes("PRIVATE_STORAGE_FAILURE"));
await assert.rejects(store.close(), error=>error instanceof PgliteStoreError && error.code === "close-failed");
await assert.rejects(openPersistentPglite(process.argv[1]), error=>error instanceof PgliteStoreError && error.code === "locked");
// All assertions passed; clear the SDK's deliberately failed-init exit status.
process.exitCode=0;
process.send({event:"sanitized"});process.disconnect();
`;
      const child = spawn(
        process.execPath,
        ["--input-type=module", "-e", script, directory],
        { stdio: ["ignore", "ignore", "pipe", "ipc"] },
      );
      try {
        const exited = once(child, "exit", {
          signal: AbortSignal.timeout(15_000),
        });
        assert.equal(await message(child), "sanitized");
        const [code] = await exited;
        assert.equal(code, 0);
        assert.equal(
          await readFile(join(directory, "PG_VERSION"), "utf8"),
          "invalid PRIVATE_STORAGE_FAILURE",
        );
      } finally {
        await stopOwner(child);
      }
    });
  },
);
