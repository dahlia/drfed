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
import { object } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { multiple } from "@optique/core/modifiers";
import { type InferValue, parse } from "@optique/core/parser";
import { argument, option, passThrough } from "@optique/core/primitives";
import type { Program } from "@optique/core/program";
import { string } from "@optique/core/valueparser";

import { createConfigurationBindings } from "./configuration.ts";
import { createParser, valueOptionNames } from "./parser.ts";

/**
 * Select operational vs schema bindings through a resource-free Optique pass.
 * The final parser still strictly validates every token. This pass consumes no
 * environment/config values and honors Optique's option terminator semantics.
 * @returns The mode whose setting bindings the complete invocation needs.
 */
export function selectInvocationMode(
  args: readonly string[],
): "server" | "schema" {
  const [first, ...aliases] = Object.values(valueOptionNames).flat();
  if (first === undefined) {
    throw new Error("Missing CLI value-option definitions.");
  }
  const selected = parse(
    object({
      schema: option("--generate-graphql-schema"),
      optionValues: multiple(option(first, ...aliases, string())),
      extra: passThrough({ format: "nextToken" }),
      values: multiple(argument(string())),
    }),
    args,
  );
  return selected.success && selected.value.schema ? "schema" : "server";
}

/**
 * Create independent CLI bindings for one invocation.
 * @returns The program, its source contexts and explicit configuration loader.
 */
export function createProgram(
  options: Parameters<typeof createConfigurationBindings>[0] & {
    readonly mode?: "server" | "schema";
  } = {},
) {
  const bindings = createConfigurationBindings(options);
  const parser = createParser(bindings, options.mode);
  const program: Program<"sync", InferValue<typeof parser>> = {
    metadata: {
      description: message`Run a DrFed server.`,
      name: "drfed-server",
    },
    parser,
  };
  return { program, contexts: bindings.contexts, load: bindings.load };
}
