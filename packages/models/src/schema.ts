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
import { sql } from "drizzle-orm";
import {
  check,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * The database table to represent accounts.
 */
export const accounts = pgTable(
  "accounts",
  {
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    email: varchar({ length: 255 }).notNull().unique(),
    id: uuid().primaryKey(),
  },
  (table) => [
    check(
      "accounts_email_check",
      sql`${table.email} ~ '^[^@]+@[^@]+\\.[^@]+$'`,
    ),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

/**
 * The database table to represent instances.
 */
export const instances = pgTable(
  "instances",
  {
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    expires: timestamp({ withTimezone: true }).notNull(),
    id: uuid().primaryKey(),
    slug: varchar({ length: 100 }).notNull().unique(),
  },
  (table) => [
    check("instances_slug_check", sql`${table.slug} ~ '^[a-z0-9-]{4,100}$'`),
    check(
      "instances_expires_check",
      sql`${table.expires} < (${table.created} + INTERVAL '1 year')`,
    ),
  ],
);

export type Instance = typeof instances.$inferSelect;
export type NewInstance = typeof instances.$inferInsert;

/**
 * The association table between instances and its member accounts.
 */
export const instanceMembers = pgTable(
  "instance_members",
  {
    accountId: uuid()
      .notNull()
      .references(() => accounts.id),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    instanceId: uuid()
      .notNull()
      .references(() => instances.id),
  },
  (table) => [primaryKey({ columns: [table.instanceId, table.accountId] })],
);

export type InstanceMember = typeof instanceMembers.$inferSelect;
export type NewInstanceMember = typeof instanceMembers.$inferInsert;
