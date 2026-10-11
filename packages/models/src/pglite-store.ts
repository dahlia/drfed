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
/// <reference path="./fs-native-extensions.d.ts" />
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";

export type PgliteStoreCode =
  | "invalid-path"
  | "lock-unavailable"
  | "locked"
  | "open-failed"
  | "close-failed";

const explanations: Record<PgliteStoreCode, string> = {
  "invalid-path": "Invalid persistent PGlite data directory or lock file.",
  "lock-unavailable":
    "The native PGlite file lock is unavailable on this platform.",
  locked: "The PGlite data directory is already in use by another owner.",
  "open-failed": "Could not open the persistent PGlite store.",
  "close-failed":
    "Could not close PGlite storage cleanly; terminate this owner before retrying.",
};

/** A sanitized storage failure; filesystem and database causes are omitted. */
export class PgliteStoreError extends Error {
  readonly code: PgliteStoreCode;
  constructor(code: PgliteStoreCode) {
    super(explanations[code]);
    this.name = "PgliteStoreError";
    this.code = code;
  }
}

export interface PersistentPgliteStore {
  readonly client: PGlite;
  /** Initialization completion with sanitized open-failed errors. */
  readonly ready: Promise<void>;
  /** The real absolute data directory, shared by all aliases of this store. */
  readonly dataPath: string;
  /** Shared completion; closes the database before releasing its native lock. */
  close(): Promise<void>;
}

// Keep failed-close owners' handles reachable: garbage collection must not
// silently release a lock while the corresponding database might remain active.
const heldFiles = new Set<FileHandle>();

async function canonicalDataPath(dataPath: string): Promise<string> {
  if (typeof dataPath !== "string" || dataPath.trim() === "") {
    throw new PgliteStoreError("invalid-path");
  }
  try {
    await mkdir(dataPath, { recursive: true, mode: 0o700 });
    return await realpath(dataPath);
  } catch {
    throw new PgliteStoreError("invalid-path");
  }
}

async function closeLock(handle: FileHandle): Promise<void> {
  try {
    await handle.close();
    heldFiles.delete(handle);
  } catch {
    heldFiles.add(handle);
    throw new PgliteStoreError("close-failed");
  }
}

async function acquireLock(dataPath: string): Promise<FileHandle> {
  let tryLock: (fd: number) => boolean;
  try {
    ({ tryLock } = await import("fs-native-extensions"));
  } catch {
    throw new PgliteStoreError("lock-unavailable");
  }
  const path = join(dataPath, ".drfed.lock");
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      // Native open flags are deliberately combined; never follow a lock symlink.
      // oxlint-disable-next-line no-bitwise
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new PgliteStoreError("invalid-path");
  }
  try {
    const [file, entry] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      !file.isFile() ||
      !entry.isFile() ||
      file.nlink !== 1 ||
      file.dev !== entry.dev ||
      file.ino !== entry.ino
    ) {
      throw new PgliteStoreError("invalid-path");
    }
    if (!tryLock(handle.fd)) throw new PgliteStoreError("locked");
    heldFiles.add(handle);
    return handle;
  } catch (error) {
    await closeLock(handle);
    if (error instanceof PgliteStoreError) throw error;
    throw new PgliteStoreError("lock-unavailable");
  }
}

async function readyStore(client: PGlite): Promise<void> {
  try {
    await client.waitReady;
  } catch {
    throw new PgliteStoreError("open-failed");
  }
}

/**
 * Open an exclusively owned persistent PGlite store on a local filesystem.
 * Register close immediately, then await ready before using the client.
 * The stable .drfed.lock file is never removed: replacing its inode could split
 * owners across two locks. OS locks survive suspension and release on process
 * exit; no heartbeat, PID guessing or stale-lock deletion is used.
 * @returns The initializing client, canonical directory and owned close method.
 */
export async function openPersistentPglite(
  dataPath: string,
): Promise<PersistentPgliteStore> {
  const canonical = await canonicalDataPath(dataPath);
  const handle = await acquireLock(canonical);
  let client: PGlite;
  try {
    client = new PGlite(canonical);
  } catch {
    await closeLock(handle);
    throw new PgliteStoreError("open-failed");
  }
  const ready = readyStore(client);
  // The caller may close before awaiting readiness; retain its rejection for
  // observers without creating an unhandled promise during ownership transfer.
  // oxlint-disable-next-line promise/prefer-await-to-then
  void ready.catch(() => undefined);
  let closing: Promise<void> | undefined;
  return {
    client,
    ready,
    dataPath: canonical,
    close() {
      // Assign completion before invoking callbacks, including reentrant close.
      // oxlint-disable-next-line promise/prefer-await-to-then
      return (closing ??= Promise.resolve().then(async () => {
        try {
          await client.close();
        } catch {
          throw new PgliteStoreError("close-failed");
        }
        await closeLock(handle);
        return undefined;
      }));
    },
  };
}
