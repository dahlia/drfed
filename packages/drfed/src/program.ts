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
import { message } from "@optique/core/message";
import type { InferValue } from "@optique/core/parser";
import type { Program } from "@optique/core/program";

import { createConfigurationBindings } from "./configuration.ts";
import { createParser } from "./parser.ts";

/**
 * Create independent CLI bindings for one invocation.
 * @returns The program, its source contexts and explicit configuration loader.
 */
export function createProgram(
  options: Parameters<typeof createConfigurationBindings>[0] = {},
) {
  const bindings = createConfigurationBindings(options);
  const parser = createParser(bindings);
  const program: Program<"sync", InferValue<typeof parser>> = {
    metadata: {
      description: message`Run a DrFed server.`,
      name: "drfed-server",
    },
    parser,
  };
  return { program, contexts: bindings.contexts, load: bindings.load };
}
