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
import type { Database } from "@drfed/models";
import {
  type YogaServerInstance,
  createYoga,
  useExecutionCancellation,
} from "graphql-yoga";

import type { ServerContext, UserContext } from "./builder.ts";
import { schema } from "./schema.ts";

/**
 * Creates a Yoga server instance with the provided schema and context.
 * @param db The database instance.
 * @returns A `YogaServerInstance` configured with the schema and context for
 *          handling GraphQL requests.
 */
export function createYogaServer(
  db: Database,
): YogaServerInstance<ServerContext, UserContext> {
  return createYoga({
    // oxlint-disable-next-line require-await
    async context(ctx) {
      return { db, request: ctx.request };
    },
    plugins: [useExecutionCancellation()],
    schema,
  });
}
