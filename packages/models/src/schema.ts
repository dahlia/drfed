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
import { uuid, varchar, pgTable, check, timestamp } from "drizzle-orm/pg-core";

export const accounts = pgTable(
  "accounts",
  {
    id: uuid().primaryKey(),
    email: varchar({ length: 255 }).notNull().unique(),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check(
      "accounts_email_check",
      sql`${table.email} ~ '^[^@]+@[^@]+\\.[^@]+$'`,
    ),
  ],
);

export const instances = pgTable(
  "instances",
  {
    id: uuid().primaryKey(),
    slug: varchar({ length: 100 }).notNull().unique(),
    expires: timestamp({ withTimezone: true }).notNull(),
    created: timestamp({ withTimezone: true })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    check("instances_slug_check", sql`${table.slug} ~ '^[a-z0-9-]{4,100}$'`),
    check(
      "instances_expires_check",
      sql`${table.expires} < (${table.created} + INTERVAL '1 year')`,
    ),
  ],
);

export const instanceMembers = pgTable("instance_members", {
  instanceId: uuid()
    .notNull()
    .primaryKey()
    .references(() => instances.id),
  accountId: uuid()
    .notNull()
    .primaryKey()
    .references(() => accounts.id),
  created: timestamp({ withTimezone: true })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});
