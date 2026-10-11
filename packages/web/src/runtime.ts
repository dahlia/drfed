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

import { type WebRuntimeOptions, installWebBinding } from "./bridge.ts";

export type { GraphqlFetch, WebRuntimeOptions } from "./bridge.ts";

/** One embedded SolidStart server, without a listening socket. */
export interface WebRuntime {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly close: () => Promise<void>;
}

interface NitroRuntime {
  fetch: (request: Request) => Response | Promise<Response>;
  close: () => Promise<void>;
}

/** Initialize the process's single embedded web server.
 * @returns The shared embedded handler and idempotent cleanup.
 */
export async function createWebRuntime(
  options: WebRuntimeOptions,
): Promise<WebRuntime> {
  const owner = installWebBinding(options);
  let nitro: NitroRuntime;
  try {
    const loaded: unknown = await import(
      new URL("../.output/server/index.mjs", import.meta.url).href
    );
    if (!isNitroRuntime(loaded)) {
      throw new Error("Invalid bundled web runtime.");
    }
    nitro = loaded;
  } catch (error) {
    await owner.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    async fetch(request) {
      if (owner.signal.aborted) {
        return new Response("Web runtime is closed.", { status: 503 });
      }
      return nitro.fetch(
        new Request(request, {
          signal: AbortSignal.any([request.signal, owner.signal]),
        }),
      );
    },
    // oxlint-disable-next-line typescript/promise-function-async
    close(): Promise<void> {
      closing ??= (async () => {
        await Promise.resolve();
        try {
          await owner.close();
        } finally {
          await nitro.close();
        }
      })();
      return closing;
    },
  };
}

function isNitroRuntime(value: unknown): value is NitroRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    "fetch" in value &&
    typeof value.fetch === "function" &&
    "close" in value &&
    typeof value.close === "function"
  );
}
