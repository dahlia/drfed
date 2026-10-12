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

import { AsyncLocalStorage } from "node:async_hooks";
import process from "node:process";

import { type WebRuntime, createWebRuntime } from "@drfed/web";
import {
  configure,
  dispose,
  getConsoleSink,
  getLogger,
} from "@logtape/logtape";
import { text } from "@optique/core/message";
import { createLoggingConfig } from "@optique/logtape";
import { printError, run } from "@optique/run";
import { serve } from "srvx";

import metadata from "../../package.json" with { type: "json" };
import { OperationRegistry } from "../operations.ts";
import { ResourceOwner } from "../resources.ts";
import {
  type WebOptions,
  createWebProgram,
  describeWebConfiguration,
  resolveWebOptions,
} from "./web-program.ts";

function startupFailure(stage: string, error: unknown): string {
  const knownCodes = [
    "EADDRINUSE",
    "EACCES",
    "ENOENT",
    "ENOTDIR",
    "ERR_MODULE_NOT_FOUND",
  ];
  const code =
    error != null && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  return typeof code === "string" && knownCodes.includes(code)
    ? `${stage} (${code})`
    : stage;
}

async function startWeb(options: WebOptions): Promise<void> {
  const owner = new ResourceOwner();
  const operations = new OperationRegistry();
  owner.register(null, () => dispose(), { owned: true });
  let server: ReturnType<typeof serve> | undefined;
  let closing: Promise<void> | undefined;
  let signalled = false;
  let startupStage = "web runtime";

  async function cleanup(): Promise<void> {
    operations.abort();
    const errors: unknown[] = [];
    let forced: Promise<void> | undefined;
    const timer = setTimeout(() => {
      if (server === undefined) return;
      const active = server;
      forced = (async () => {
        try {
          await active.close(true);
        } catch (error) {
          errors.push(error);
        }
      })();
    }, 5_000);
    try {
      const settled = await Promise.allSettled([
        server?.close(),
        operations.drain(),
      ]);
      for (const result of settled) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      if (forced !== undefined) await forced;
    } finally {
      clearTimeout(timer);
      try {
        await owner.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Web cleanup failed.");
    }
  }
  function stop(): Promise<void> {
    // Assign before cancellation callbacks can request cleanup again.
    // oxlint-disable-next-line promise/prefer-await-to-then
    return (closing ??= Promise.resolve().then(cleanup));
  }
  function shutdown(): void {
    if (signalled) process.exit(1);
    signalled = true;
    const deadline = setTimeout(() => process.exit(1), 10_000);
    // oxlint-disable promise/prefer-await-to-then
    void stop().then(
      () => {
        clearTimeout(deadline);
        process.exit(0);
      },
      () => process.exit(1),
    );
    // oxlint-enable promise/prefer-await-to-then
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    const web: WebRuntime = await operations.run(async (signal) => {
      const runtime = owner.register(
        await createWebRuntime({
          publicOrigin: options.publicOrigin,
          graphqlFetch(request) {
            return operations.track((operationSignal) =>
              fetch(new URL("/graphql", options.backendUrl), {
                method: request.method,
                headers: request.headers,
                body: request.body,
                duplex: "half",
                redirect: "error",
                signal: AbortSignal.any([request.signal, operationSignal]),
              } as RequestInit & { duplex: "half" }),
            );
          },
        }),
        (resource) => resource.close(),
        { owned: true },
      );
      signal.throwIfAborted();
      return runtime;
    });
    startupStage = "HTTP listener";
    const listener = owner.register(
      serve({
        async fetch(request) {
          if (operations.signal.aborted) {
            return new Response("Web server is stopping.", { status: 503 });
          }
          try {
            return await operations.run(() => web.fetch(request));
          } catch (error) {
            if (operations.signal.aborted) {
              return new Response("Web server is stopping.", { status: 503 });
            }
            throw error;
          }
        },
        hostname: options.address.host,
        port: options.address.port,
        manual: true,
        gracefulShutdown: false,
      }),
      (resource) => resource.close(true),
      { owned: true },
    );
    server = listener;
    await operations.run(async () => {
      await listener.serve();
    });
    getLogger(["drfed", "web"]).info("Web frontend is available at {origin}.", {
      origin: options.publicOrigin.origin,
    });
  } catch (error) {
    getLogger(["drfed", "web"]).error(
      "Web frontend startup failed during {failure}.",
      {
        failure: startupFailure(startupStage, error),
      },
    );
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    const deadline = Promise.withResolvers<never>();
    const timer = setTimeout(
      () => deadline.reject(new Error("Web startup cleanup timed out.")),
      10_000,
    );
    try {
      await Promise.race([stop(), deadline.promise]);
    } finally {
      clearTimeout(timer);
    }
    throw error;
  }
}

/** Run the installed standalone web command with resource-free preflight. */
export async function main(): Promise<void> {
  const invocation = createWebProgram();
  let options: WebOptions;
  try {
    const raw = await run(invocation.program, {
      contexts: invocation.contexts,
      contextOptions: { load: invocation.load },
      help: "option",
      showChoices: true,
      showDefault: true,
      version: { option: true, value: metadata.version },
    });
    options = resolveWebOptions(raw);
  } catch (error) {
    printError([
      text(
        error instanceof Error
          ? error.message
          : "Could not resolve web configuration.",
      ),
    ]);
    process.exitCode = 1;
    return;
  }
  if (options.printConfig) {
    console.log(JSON.stringify(describeWebConfiguration(options), null, 2));
    return;
  }
  let startupStage = "logging";
  try {
    const config = await createLoggingConfig(
      options.logging,
      {},
      {
        contextLocalStorage: new AsyncLocalStorage(),
        sinks: {
          stderr: getConsoleSink({
            levelMap: {
              trace: "error",
              debug: "error",
              info: "error",
              warning: "error",
              error: "error",
              fatal: "error",
            },
          }),
        },
        loggers: [
          {
            category: ["logtape", "meta"],
            lowestLevel: "warning",
            sinks: ["stderr"],
          },
        ],
      },
    );
    await configure(config);
    startupStage = "web frontend";
    await startWeb(options);
  } catch (error) {
    printError([
      text(
        `Could not start ${startupFailure(startupStage, error)}; check the listen address, logging output and installed files.`,
      ),
    ]);
    process.exitCode = 1;
  }
}
