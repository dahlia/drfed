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

import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  type ConfigurationSource,
  type Sourced,
  configurationPath,
} from "./configuration.ts";

/** A credential variant selected without reading its file. */
export type SecretSource =
  | { readonly type: "literal"; readonly value: string }
  | { readonly type: "file"; readonly path: string };

const priority: Readonly<Record<ConfigurationSource, number>> = {
  default: 0,
  config: 1,
  env: 2,
  cli: 3,
};

/** Select one source-aware literal/file variant without opening anything.
 * @returns The highest-priority variant, or undefined when neither is supplied.
 */
export function resolveSecretSource(
  literal: Sourced<string | undefined> | undefined,
  file: Sourced<string | undefined> | undefined,
  field: string,
  cwd = process.cwd(),
): SecretSource | undefined {
  const literalRank =
    literal?.value === undefined ? -1 : priority[literal.source];
  const fileRank = file?.value === undefined ? -1 : priority[file.source];
  if (literalRank < 0 && fileRank < 0) return undefined;
  if (literalRank === fileRank) {
    throw new Error(`Conflicting secret variants for ${field}.`);
  }
  if (fileRank > literalRank && file?.value !== undefined) {
    if (file.value.trim() === "") {
      throw new Error(`Invalid secret file setting for ${field}.`);
    }
    return {
      type: "file",
      path: configurationPath(file as Sourced<string>, cwd),
    };
  }
  return { type: "literal", value: literal?.value ?? "" };
}

/** Read only a selected credential; file paths and contents stay out of errors.
 * @returns The credential, removing exactly one final LF or CRLF from files.
 */
export async function readSecretSource(
  source: SecretSource,
  field: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (source.type === "literal") return source.value;
  try {
    // O_NONBLOCK prevents a mistaken FIFO path from blocking before fstat.
    // Windows exposes only its supported file-open flags.
    const nonblocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
    // oxlint-disable-next-line no-bitwise
    const flags = constants.O_RDONLY | nonblocking;
    const file = await open(source.path, flags);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 65_536) throw new Error();
      const bytes = await file.readFile({ signal });
      if (bytes.byteLength > 65_536) throw new Error();
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return value.replace(/\r?\n$/u, "");
    } finally {
      await file.close();
    }
  } catch {
    signal?.throwIfAborted();
    throw new Error(`Unable to read secret for ${field}.`);
  }
}
