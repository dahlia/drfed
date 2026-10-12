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

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import {
  createAccount,
  resolveAccountInput,
} from "@drfed/drfed/commands/account-create";
import { openDatabaseRuntime } from "@drfed/drfed/database-runtime";
import { ResourceOwner } from "@drfed/drfed/resources";

it("normalizes inputs and counts Unicode characters according to database limits", () => {
  assert.deepEqual(resolveAccountInput("Operator@EXAMPLE.COM", " Operator "), {
    email: "Operator@example.com",
    name: "Operator",
  });
  assert.equal(
    resolveAccountInput("o'connor@example.com", "Operator").email,
    "o'connor@example.com",
  );
  assert.equal(
    resolveAccountInput("user@bücher.example", "Operator").email,
    "user@xn--bcher-kva.example",
  );
  assert.equal(
    resolveAccountInput("user@example.com", "😀".repeat(100)).name,
    "😀".repeat(100),
  );
  for (const name of ["", "  ", "bad\0name", "😀".repeat(101)]) {
    assert.throws(
      () => resolveAccountInput("user@example.com", name),
      /Account name/u,
    );
  }
  for (const email of [
    "not-email",
    "operator@localhost",
    '"a\nb"@example.com',
    '"a\rb"@example.com',
    '"a\0b"@example.com',
    "user@example.com/path",
    "user@example.com:443",
    "user@example.com\nInjected",
  ]) {
    assert.throws(
      () => resolveAccountInput(email, "Operator"),
      /Invalid account email/u,
    );
  }
});

it("creates one unprivileged account concurrently and never accepts extra privileged fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-account-race-"));
  const owner = new ResourceOwner();
  try {
    const runtime = await openDatabaseRuntime(
      {
        driver: "pglite",
        dataPath: directory,
        migrate: true,
        lockTimeoutMs: 30_000,
      },
      owner,
      "apply",
    );
    const input = resolveAccountInput("user@example.com", "Operator");
    const malicious = {
      ...input,
      admin: true,
      id: "00000000-0000-4000-8000-000000000000",
    };
    const results = await Promise.all([
      createAccount(runtime.db, malicious),
      createAccount(runtime.db, { ...input, name: "Another name" }),
    ]);
    assert.deepEqual(
      new Set(results.map((result) => result.status)),
      new Set(["created", "exists"]),
    );
    assert.equal(results[0]?.account.id, results[1]?.account.id);
    assert.equal(results[0]?.account.name, results[1]?.account.name);
    for (const result of results) {
      assert.equal(result.account.admin, false);
      assert.notEqual(result.account.id, malicious.id);
    }
    assert.equal((await runtime.db.query.accounts.findMany()).length, 1);
  } finally {
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});
