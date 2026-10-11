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

// oxlint-disable no-control-regex no-useless-escape
// Email syntax requires explicit control-character rejection and slash literals.

import { type Database, schema } from "@drfed/models";
import { normalizeEmail } from "@drfed/models/email";
import { uuidV7 } from "@drfed/models/uuid";
import { message } from "@optique/core/message";
import type { ValueParser } from "@optique/core/valueparser";

/** Email validation with the same case-preserving normalization as login. */
export const accountEmail: ValueParser<"sync", string> = {
  mode: "sync",
  metavar: "EMAIL",
  placeholder: "user@example.com",
  parse(input) {
    try {
      const value = input.trim();
      const [local, host, extra] = value.split("@");
      if (
        local == null ||
        host == null ||
        extra !== undefined ||
        /[\u0000-\u001f\u007f]/u.test(input) ||
        /[\s/\\:#?%\[\]]/u.test(host) ||
        !/^(?:[a-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+\/=?^_`{|}~-]+)*|"(?:[^"\\\u0000-\u001f\u007f]|\\[\u0020-\u007e])*")$/iu.test(
          local,
        )
      ) {
        throw new Error();
      }
      const normalized = normalizeEmail(value);
      const domain = normalized.slice(normalized.lastIndexOf("@") + 1);
      if (
        domain.length > 253 ||
        !domain.includes(".") ||
        !domain
          .split(".")
          .every(
            (label) =>
              label.length <= 63 &&
              /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label),
          )
      ) {
        throw new Error();
      }
      return { success: true, value: normalized };
    } catch {
      return { success: false, error: message`Invalid account email.` };
    }
  },
  format: (value) => value,
};

/**
 * Validate and normalize account inputs before database acquisition.
 * @returns Email and trimmed name within the database column limits.
 */
export function resolveAccountInput(email: string, name: string) {
  const parsed = accountEmail.parse(email);
  if (!parsed.success) throw new Error("Invalid account email.");
  const normalizedEmail = normalizeEmail(parsed.value);
  const normalizedName = name.trim();
  if (Array.from(normalizedEmail).length > 255) {
    throw new Error("Account email must be at most 255 characters.");
  }
  if (
    !normalizedName ||
    normalizedName.includes("\0") ||
    Array.from(normalizedName).length > 100
  ) {
    throw new Error("Account name must contain 1 to 100 characters.");
  }
  return { email: normalizedEmail, name: normalizedName };
}

/**
 * Create an unprivileged account, preserving every existing account field.
 * @returns Whether the account was created, with its stored public identity.
 */
export async function createAccount(
  db: Database,
  input: ReturnType<typeof resolveAccountInput>,
) {
  const columns = {
    id: schema.accounts.id,
    email: schema.accounts.email,
    name: schema.accounts.name,
    admin: schema.accounts.admin,
  };
  const [created] = await db
    .insert(schema.accounts)
    .values({
      id: uuidV7(),
      email: input.email,
      name: input.name,
      admin: false,
    })
    .onConflictDoNothing({ target: schema.accounts.email })
    .returning(columns);
  if (created !== undefined) {
    return { status: "created" as const, account: created };
  }
  const existing = await db.query.accounts.findFirst({
    columns: { id: true, email: true, name: true, admin: true },
    where: { email: input.email },
  });
  if (existing === undefined) {
    throw new Error("Could not read the existing account.");
  }
  return { status: "exists" as const, account: existing };
}
