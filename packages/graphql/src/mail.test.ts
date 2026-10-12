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

// oxlint-disable no-await-in-loop
// Each behavior uses one sequentially replaced transport fixture.

import assert from "node:assert/strict";
import { it } from "node:test";

import { createYogaServer } from "@drfed/graphql";
import { schema } from "@drfed/models";
import { type LogRecord, configure, reset } from "@logtape/logtape";

import { withTestHarness } from "./harness.test.ts";

const mutation = `mutation Login($email: Email!) {
  loginByEmail(email: $email, verifyUrl: "https://drfed.test/verify?challengeId={challengeId}&code={code}") { challengeId }
}`;
const secret = "provider-token-password-login-code";
const email = "operator@example.com";

it("keeps failed receipts and thrown provider errors opaque and out of logs", async () => {
  const records: LogRecord[] = [];
  await configure({
    reset: true,
    sinks: {
      capture: (record) => {
        records.push(record);
      },
    },
    loggers: [
      {
        category: ["drfed", "graphql", "auth"],
        lowestLevel: "debug",
        sinks: ["capture"],
      },
    ],
  });
  try {
    await withTestHarness(async ({ db, mailer, post }) => {
      await db.insert(schema.accounts).values({
        id: "00000000-0000-4000-8000-000000000001",
        email,
        name: "Operator",
      });
      for (const behavior of [
        "receipt",
        "throw",
        "reject",
        "success",
      ] as const) {
        let sends = 0;
        mailer.send = () => {
          sends += 1;
          if (behavior === "throw") throw new Error(secret);
          if (behavior === "reject") return Promise.reject(new Error(secret));
          return Promise.resolve(
            behavior === "receipt"
              ? { successful: false as const, errorMessages: [secret] }
              : { successful: true as const, messageId: secret },
          );
        };
        for (const address of [email, "unknown@example.com"]) {
          const response = await post({
            query: mutation,
            variables: { email: address },
          });
          assert.equal(response.status, 200);
          const body = await response.json();
          assert.equal(body.errors, undefined);
          assert.equal(typeof body.data.loginByEmail.challengeId, "string");
        }
        assert.equal(sends, 1);
      }
      assert.equal((await db.query.loginChallenges.findMany()).length, 4);
    });
    assert.ok(
      records.some((record) => record.properties.outcome === "exception"),
    );
    assert.ok(records.some((record) => record.properties.outcome === "failed"));
    assert.ok(!JSON.stringify(records).includes(secret));
  } finally {
    await reset();
  }
});

for (const source of ["request", "shutdown"] as const) {
  it(
    `propagates ${source} cancellation and retains work until an ignoring provider settles`,
    { timeout: 10_000 },
    async () => {
      await withTestHarness(async ({ db, mailer, federation }) => {
        await db.insert(schema.accounts).values({
          id: "00000000-0000-4000-8000-000000000001",
          email,
          name: "Operator",
        });
        const requestAbort = new AbortController();
        const shutdownAbort = new AbortController();
        const started = Promise.withResolvers<AbortSignal>();
        const release = Promise.withResolvers<void>();
        const pending = new Set<Promise<unknown>>();
        mailer.send = async (_message, options) => {
          assert.ok(options?.signal);
          started.resolve(options.signal);
          await release.promise;
          throw new Error(secret);
        };
        const yoga = createYogaServer(db, federation, {
          mailer,
          rootOrigin: new URL("https://drfed.test"),
          loginOrigins: new Set(["https://drfed.test"]),
          shutdownSignal: shutdownAbort.signal,
          trackOperation: async (operation) => {
            const task = Promise.resolve().then(operation);
            pending.add(task);
            try {
              return await task;
            } finally {
              pending.delete(task);
            }
          },
        });
        const response = Promise.resolve(
          yoga.fetch(
            new Request("https://drfed.test/graphql", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ query: mutation, variables: { email } }),
              signal: requestAbort.signal,
            }),
          ),
        ).catch(() => undefined);
        try {
          const signal = await started.promise;
          (source === "request" ? requestAbort : shutdownAbort).abort(
            new Error(secret),
          );
          assert.equal(signal.aborted, true);
          assert.ok(pending.size > 0);
          release.resolve();
          const result = await response;
          if (result !== undefined) {
            assert.ok(!(await result.text()).includes(secret));
          }
          await Promise.allSettled([...pending]);
          assert.equal(pending.size, 0);
        } finally {
          release.resolve();
          requestAbort.abort();
          shutdownAbort.abort();
          await response;
          await Promise.allSettled([...pending]);
          await yoga[Symbol.asyncDispose]();
        }
      });
    },
  );
}
