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

import type { GraphQLResponse } from "relay-runtime";

/** A GraphQL fetch handler owned by the embedding application. */
export type GraphqlFetch = (request: Request) => Response | Promise<Response>;

/** Immutable deployment settings shared by the adapter and Nitro server. */
export interface WebRuntimeOptions {
  readonly publicOrigin: URL;
  readonly graphqlFetch: GraphqlFetch;
}

interface Binding {
  readonly publicOrigin: string;
  readonly graphqlFetch: GraphqlFetch;
  readonly abort: AbortController;
  readonly pending: Set<Promise<unknown>>;
}

let binding: Binding | undefined;
let initialized = false;

/** Install the process's single web binding before importing Nitro.
 * @returns Runtime cancellation and shared idempotent cleanup.
 */
export function installWebBinding(options: WebRuntimeOptions) {
  if (initialized) {
    throw new Error("A web runtime was already initialized in this process.");
  }
  const owner = createBinding(options);
  initialized = true;
  return owner;
}

/** Replace the development binding during a Vite restart.
 * Production initialization remains limited to one runtime per process.
 * @returns Cancellation and cleanup for this development server only.
 */
export function installDevelopmentWebBinding(options: WebRuntimeOptions) {
  if (initialized) {
    throw new Error("A production web runtime was already initialized.");
  }
  return createBinding(options);
}

function createBinding(options: WebRuntimeOptions) {
  const origin = new URL(options.publicOrigin.href);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    typeof options.graphqlFetch !== "function"
  ) {
    throw new TypeError("Invalid web runtime settings.");
  }
  const current: Binding = {
    publicOrigin: origin.origin,
    graphqlFetch: options.graphqlFetch,
    abort: new AbortController(),
    pending: new Set(),
  };
  binding = current;
  let closing: Promise<void> | undefined;
  return {
    signal: current.abort.signal,
    // oxlint-disable-next-line typescript/promise-function-async
    close(): Promise<void> {
      closing ??= (async () => {
        // Yield before cancellation can invoke callbacks, preserving identity.
        await Promise.resolve();
        current.abort.abort();
        await Promise.allSettled(current.pending);
        if (binding === current) binding = undefined;
      })();
      return closing;
    },
  };
}

/** Run a server-side Relay request through the configured GraphQL handler.
 * @returns The parsed GraphQL response after its body has been consumed.
 */
export async function queryGraphql(
  query: string,
  variables: Readonly<Record<string, unknown>>,
  accessToken: string | undefined,
  sourceSignal: AbortSignal,
): Promise<GraphQLResponse> {
  const current = binding;
  if (current === undefined || current.abort.signal.aborted) {
    throw new Error("Web runtime is unavailable.");
  }
  const signal = AbortSignal.any([sourceSignal, current.abort.signal]);
  signal.throwIfAborted();
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (accessToken !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(accessToken)) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  const request = new Request(new URL("/graphql", current.publicOrigin), {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
    signal,
  });
  const task = (async () => {
    // Register before the supplied handler can request shutdown.
    await Promise.resolve();
    const response = await current.graphqlFetch(request);
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // Settled cancellation must not expose a handler's raw error.
      }
      throw new Error(`GraphQL request failed (${response.status}).`);
    }
    const result: unknown = await response.json();
    if (!isGraphqlResponse(result)) {
      throw new Error("Invalid GraphQL response.");
    }
    return result;
  })();
  current.pending.add(task);
  try {
    return await task;
  } finally {
    current.pending.delete(task);
  }
}

function isGraphqlResponse(value: unknown): value is GraphQLResponse {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
