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
import { it } from "node:test";

import { OperationRegistry } from "@drfed/drfed/operations";
import { ResourceOwner } from "@drfed/drfed/resources";

it("closes owned resources once in reverse order and leaves borrowed resources open", async () => {
  const owner = new ResourceOwner();
  const closed: string[] = [];
  for (const [name, owned] of [
    ["database", true],
    ["external", false],
    ["mailer", true],
  ] as const) {
    owner.register(
      name,
      (value) => {
        closed.push(value);
      },
      { owned },
    );
  }
  const first = owner.close();
  assert.equal(first, owner.close());
  await first;
  assert.deepEqual(closed, ["mailer", "database"]);
  assert.throws(() => owner.register("late", () => undefined, { owned: true }));
});

it("attempts remaining cleanup after an earlier cleanup rejects", async () => {
  const owner = new ResourceOwner();
  const failure = new Error("failed cleanup");
  let databaseClosed = false;
  owner.register(
    null,
    () => {
      databaseClosed = true;
    },
    { owned: true },
  );
  owner.register(
    null,
    () => {
      throw failure;
    },
    { owned: true },
  );
  await assert.rejects(owner.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.ok(databaseClosed);
});

it("waits for cancelled work before draining and rejects new operations", async () => {
  const operations = new OperationRegistry();
  const ready = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  let cancelled = false;
  const active = operations.run(async (signal) => {
    signal.addEventListener(
      "abort",
      () => {
        cancelled = true;
      },
      { once: true },
    );
    ready.resolve();
    await completed.promise;
  });
  await ready.promise;
  let drained = false;
  const shutdown = operations.drain();
  // oxlint-disable-next-line promise/prefer-await-to-then
  void shutdown.then(() => {
    drained = true;
    return undefined;
  });
  await Promise.resolve();
  assert.ok(cancelled);
  assert.equal(drained, false);
  await assert.rejects(
    operations.run(() => assert.fail("late work started")),
    { name: "AbortError" },
  );
  completed.resolve();
  await Promise.all([active, shutdown]);
  assert.ok(drained);
});

it("does not lose work when shutdown is requested by the operation itself", async () => {
  const operations = new OperationRegistry();
  const completed = Promise.withResolvers<void>();
  let shutdown: Promise<void> | undefined;
  let drained = false;
  const active = operations.run(async () => {
    shutdown = operations.drain();
    // oxlint-disable-next-line promise/prefer-await-to-then
    void shutdown.then(() => {
      drained = true;
      return undefined;
    });
    await completed.promise;
  });
  await Promise.resolve();
  assert.ok(shutdown);
  assert.equal(drained, false);
  completed.resolve();
  await Promise.all([active, shutdown]);
  assert.ok(drained);
});

it("drains rejected operations and cancels work that has not started", async () => {
  const operations = new OperationRegistry();
  const failure = new Error("operation failed");
  await assert.rejects(
    operations.run(() => {
      throw failure;
    }),
    (error) => error === failure,
  );
  const waiting = operations.run(() => assert.fail("cancelled work started"));
  operations.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  await operations.drain();
});

it("allows accepted work to register continuations while draining", async () => {
  const operations = new OperationRegistry();
  const ready = Promise.withResolvers<void>();
  const next = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const continuation = Promise.withResolvers<Promise<void>>();
  const parent = operations.run(async () => {
    ready.resolve();
    await next.promise;
    continuation.resolve(
      operations.track(async () => {
        await completed.promise;
      }),
    );
  });
  await ready.promise;
  let drained = false;
  const shutdown = (async () => {
    await operations.drain();
    drained = true;
  })();
  next.resolve();
  await parent;
  assert.equal(drained, false);
  await assert.rejects(
    operations.run(() => assert.fail("new work started")),
    { name: "AbortError" },
  );
  completed.resolve();
  await Promise.all([continuation.promise, shutdown]);
  assert.ok(drained);
});
