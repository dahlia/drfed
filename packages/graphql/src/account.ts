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
import builder from "./builder.ts";

export const Account = builder.drizzleNode("accounts", {
  description:
    "Represents an `Account` in the DrFed platform.  " +
    "Note that it differs from the ActivityPub `Actor`s that belong to `Instance`s.",
  fields: (t) => ({
    created: t.expose("created", {
      type: "DateTime",
      description: "The date/time when the `Account` was created.",
    }),
    email: t.expose("email", {
      type: "Email",
      description: "The email address of the `Account`.",
    }),
    uuid: t.expose("id", {
      type: "UUID",
      description: "The UUID of the `Account`.",
    }),
  }),
  id: {
    column(account) {
      return account.id;
    },
    description: "The unique identifier of the `Account`.",
  },
  name: "Account",
});

builder.queryFields((t) => ({
  accountByUuid: t.drizzleField({
    args: {
      uuid: t.arg({
        description: "The UUID of the `Account` to retrieve.",
        required: true,
        type: "UUID",
      }),
    },
    description: "Get an `Account` by its UUID.",
    nullable: true,
    resolve(query, _, { uuid }, ctx) {
      return ctx.db.query.accounts.findFirst(query({ where: { id: uuid } }));
    },
    type: Account,
  }),
}));
