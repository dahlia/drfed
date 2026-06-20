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
import { type Database, relations } from "@drfed/models";
import SchemaBuilder from "@pothos/core";
import DrizzlePlugin from "@pothos/plugin-drizzle";
import { getTableConfig } from "drizzle-orm/pg-core";

/**
 * The context data for the GraphQL server, which includes the incoming request
 * object and any additional information needed for processing GraphQL queries
 * and mutations.
 */
export interface ServerContext {
  /**
   * The incoming HTTP request.
   */
  readonly request: Request;

  /**
   * The database instance.
   */
  readonly db: Database;
}

/**
 * The user-related context data for the GraphQL server, which include every
 * field from the {@link ServerContext}.
 */
export interface UserContext extends ServerContext {}

export interface PothosTypes {
  DefaultFieldNullability: false;
  Context: UserContext;
}

/**
 * The GraphQL schema builder.
 */
export const builder = new SchemaBuilder<PothosTypes>({
  plugins: [DrizzlePlugin],
  defaultFieldNullability: false,
  drizzle: {
    client(ctx) {
      return ctx.db;
    },
    getTableConfig,
    relations,
  },
});

export default builder;
