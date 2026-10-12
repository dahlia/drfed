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

import process from "node:process";

import { MigrationPreparationError, PgliteStoreError } from "@drfed/models";
import { text } from "@optique/core/message";
import { printError, run } from "@optique/run";

import metadata from "../../package.json" with { type: "json" };
import { openDatabaseRuntime } from "../database-runtime.ts";
import { OperationRegistry } from "../operations.ts";
import { ResourceOwner } from "../resources.ts";
import { createAccount } from "./account-create.ts";
import {
  createAccountProgram,
  describeAccountConfiguration,
  resolveAccountOptions,
} from "./account-program.ts";

/** Run the installed account creation command without server resources. */
export async function main(): Promise<void> {
  const invocation = createAccountProgram();
  let options: ReturnType<typeof resolveAccountOptions>;
  try {
    const raw = await run(invocation.program, {
      contexts: invocation.contexts,
      contextOptions: { load: (parsed) => invocation.load(parsed) },
      help: "option",
      completion: "both",
      showChoices: true,
      showDefault: true,
      version: { option: true, value: metadata.version },
    });
    options = resolveAccountOptions(raw);
  } catch (error) {
    printError([
      text(
        error instanceof Error
          ? error.message
          : "Could not resolve configuration.",
      ),
    ]);
    process.exitCode = 1;
    return;
  }
  if (options.printConfig) {
    console.log(JSON.stringify(describeAccountConfiguration(options), null, 2));
    return;
  }
  const owner = new ResourceOwner();
  const operations = new OperationRegistry();
  let interrupted = false;
  let failed = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    if (interrupted) process.exit(1);
    interrupted = true;
    failed = true;
    operations.abort();
    deadline = setTimeout(() => process.exit(1), 10_000);
    deadline.unref();
  };
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    const result = await operations.run(async (signal) => {
      const database = await openDatabaseRuntime(
        options.database,
        owner,
        options.database.migrate ? "apply" : "inspect",
        signal,
      );
      if (database.state.status !== "ready") {
        throw new MigrationPreparationError(
          "incompatible-history",
          database.state,
        );
      }
      signal.throwIfAborted();
      return await createAccount(database.db, {
        email: options.email,
        name: options.name,
      });
    });
    console.log(
      JSON.stringify(
        { command: "account", action: "create", ...result },
        null,
        2,
      ),
    );
  } catch (error) {
    const cleanAbort =
      interrupted &&
      (error === operations.signal.reason ||
        (error instanceof MigrationPreparationError &&
          error.code === "aborted" &&
          !error.cleanupFailed));
    if (!cleanAbort) {
      const message =
        error instanceof MigrationPreparationError ||
        error instanceof PgliteStoreError
          ? `${error.code}: ${error.message}`
          : "Could not create the account.";
      printError([text(message)]);
      failed = true;
    }
  } finally {
    operations.abort();
    await operations.drain();
    try {
      await owner.close();
    } catch {
      printError([text("Could not cleanly close the database.")]);
      failed = true;
    }
    if (deadline !== undefined) clearTimeout(deadline);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
  process.exitCode = failed ? 1 : 0;
}
