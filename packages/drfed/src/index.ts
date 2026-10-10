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
import { writeFile } from "node:fs/promises";
import process from "node:process";

import createFederation, { createInboundRecorder } from "@drfed/federation";
import { KeyGenerationQueue } from "@drfed/federation/task-queue";
import { createYogaServer } from "@drfed/graphql";
import { migrate } from "@drfed/models";
import { PgliteKvStore } from "@fedify/pglite";
import { PostgresKvStore } from "@fedify/postgres";
import {
  configure,
  dispose,
  getConsoleSink,
  getLogger,
} from "@logtape/logtape";
import { createLoggingConfig } from "@optique/logtape";
import { run } from "@optique/run";
import { serve } from "srvx";

import metadata from "../package.json" with { type: "json" };
import { OperationRegistry } from "./operations.ts";
import type {
  Options,
  SchemaGeneratorOptions,
  ServerOptions,
} from "./parser.ts";
import program from "./program.ts";
import { ResourceOwner } from "./resources.ts";
import { createServerRuntime } from "./runtime-options.ts";
import seedData from "./seed.ts";
import { createFetchHandler, warnAboutStrandedInstances } from "./serving.ts";

async function runServer(configuration: ServerOptions) {
  const owner = new ResourceOwner();
  const operations = new OperationRegistry();
  owner.register(null, () => dispose(), { owned: true });
  let server: ReturnType<typeof serve> | undefined;
  let closing: Promise<void> | undefined;
  let signalled = false;

  async function cleanup(): Promise<void> {
    operations.abort();
    const errors: unknown[] = [];
    let forced: Promise<void> | undefined;
    const forceTimer = setTimeout(() => {
      if (server == null) return;
      const currentServer = server;
      forced = (async () => {
        try {
          await currentServer.close(true);
        } catch (error) {
          errors.push(error);
        }
      })();
    }, 5000);
    try {
      const results = await Promise.allSettled([
        server?.close(),
        operations.drain(),
      ]);
      for (const result of results) {
        if (result.status === "rejected") errors.push(result.reason);
      }
      if (forced != null) await forced;
    } finally {
      clearTimeout(forceTimer);
      try {
        await owner.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Server cleanup failed.");
    }
  }

  function stop(): Promise<void> {
    // Assign before invoking abort callbacks so reentrant cleanup is shared.
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
    const options = createServerRuntime(configuration, owner);
    const { credentials, db } = options.drizzle;
    if (options.drizzle.migrate) {
      await operations.run(() => migrate({ credentials }));
    }
    if (options.seed) await operations.run(() => seedData(db));
    const kv =
      "driver" in credentials
        ? new PgliteKvStore(credentials.client)
        : new PostgresKvStore(credentials.client);
    const federation = await operations.run(() =>
      createFederation(db, {
        kv,
        queue: { task: new KeyGenerationQueue() },
        taskQueueResolution: "strict",
        manuallyStartQueue: true,
        allowPrivateAddress: true,
      }),
    );
    // The registry drains the worker before owned database cleanup.
    void (async () => {
      try {
        await operations.run((signal) =>
          federation.startQueue(undefined, { queue: "task", signal }),
        );
      } catch {
        if (!operations.signal.aborted) {
          getLogger(["drfed", "server"]).error(
            "Actor key worker stopped unexpectedly.",
          );
        }
      }
    })();
    const { emailFrom, mailer, rootOrigin, loginOrigins } = options;
    const yogaServer = createYogaServer(db, federation, {
      rootOrigin,
      emailFrom,
      mailer,
      loginOrigins,
      trackOperation: (operation) => operations.track(operation),
    });
    await operations.run(() => warnAboutStrandedInstances(db, rootOrigin));
    const fetchHandler = createFetchHandler({
      federation: createInboundRecorder({ db, federation, rootOrigin }),
      rootOrigin,
      serveControlSurface: yogaServer.fetch,
    });
    const ownedServer = owner.register(
      serve({
        async fetch(request) {
          if (operations.signal.aborted) {
            return new Response("Server is stopping.", { status: 503 });
          }
          try {
            return await operations.run(() => fetchHandler(request));
          } catch (error) {
            if (operations.signal.aborted) {
              return new Response("Server is stopping.", { status: 503 });
            }
            throw error;
          }
        },
        hostname: options.address.host,
        manual: true,
        gracefulShutdown: false,
        port: options.address.port,
      }),
      (resource) => resource.close(true),
      { owned: true },
    );
    server = ownedServer;
    await operations.run(async () => {
      await ownedServer.serve();
    });
  } catch (error) {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    const deadline = Promise.withResolvers<never>();
    const timeout = setTimeout(
      () => deadline.reject(new Error("Startup cleanup timed out.")),
      10_000,
    );
    try {
      await Promise.race([stop(), deadline.promise]);
    } catch {
      throw new Error("Database cleanup after startup failure failed.", {
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
    throw new Error("Could not start the server.", { cause: error });
  }
}

async function runSchemaGenerator(
  options: SchemaGeneratorOptions,
): Promise<void> {
  const [{ schema }, { printSchema }] = await Promise.all([
    import("@drfed/graphql/schema"),
    import("graphql"),
  ]);
  const schemaCode = printSchema(schema);
  if (options.outputFile === "-") {
    // oxlint-disable-next-line no-console
    console.log(schemaCode);
    return;
  }
  await writeFile(options.outputFile, schemaCode, { encoding: "utf-8" });
}

export async function main(): Promise<void> {
  const options: Options = run(program, {
    help: "option",
    showChoices: true,
    showDefault: true,
    version: {
      option: true,
      value: metadata.version,
    },
  });
  const loggingConfig = await createLoggingConfig(
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

  await configure(loggingConfig);

  if ("generateGraphqlSchema" in options) {
    try {
      await runSchemaGenerator(options);
    } finally {
      await dispose();
    }
  } else {
    await runServer(options);
  }
}
