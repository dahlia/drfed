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
import { RelationsFilter as RelationsFilterImpl } from "drizzle-orm";
import type {
  PgAsyncDatabase,
  PgAsyncTransaction,
  PgQueryResultHKT,
} from "drizzle-orm/pg-core";

import { relations } from "./relations.ts";
import * as schema from "./schema.ts";

/**
 * A database instance.
 */
export type Database = PgAsyncDatabase<
  PgQueryResultHKT,
  typeof schema,
  typeof relations
>;

/**
 * A transaction instance.
 */
export type Transaction = PgAsyncTransaction<
  PgQueryResultHKT,
  typeof schema,
  typeof relations
>;

/**
 * A filter for relations.
 */
export type RelationsFilter<T extends keyof typeof relations> =
  RelationsFilterImpl<(typeof relations)[T], typeof relations>;
