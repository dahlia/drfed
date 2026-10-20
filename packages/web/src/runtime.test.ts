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
import { Server } from "node:net";
import process from "node:process";
import { it } from "node:test";

void it(
  "embeds SSR and static assets with one shared binding, controlled headers and draining close",
  { timeout: 15_000 },
  async () => {
    // oxlint-disable-next-line typescript/unbound-method
    const originalListen = Server.prototype.listen;
    Server.prototype.listen = unexpectedListen;
    const watched = [
      "SIGINT",
      "SIGTERM",
      "uncaughtException",
      "unhandledRejection",
    ] as const;
    const before = watched.map((name) => process.listenerCount(name));
    try {
      const { createWebRuntime } = await import("@drfed/web");
      const { queryGraphql } = await import("@drfed/web/bridge");
      await assert.rejects(
        createWebRuntime({
          publicOrigin: new URL("ftp://drfed.test"),
          graphqlFetch: () => Response.json({}),
        }),
        /Invalid web/u,
      );
      const requests: Request[] = [];
      const started = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<null>();
      const cancelStarted = Promise.withResolvers<null>();
      const cancelRelease = Promise.withResolvers<null>();
      const publicOrigin = new URL("https://drfed.test");
      const runtime = await createWebRuntime({
        publicOrigin,
        graphqlFetch: async (request) => {
          requests.push(request);
          const body: unknown = await request.json();
          const query =
            typeof body === "object" && body !== null && "query" in body
              ? body.query
              : undefined;
          if (query === "{ sleep }") {
            started.resolve(request.signal);
            await release.promise;
          }
          if (query === "{ error }") {
            return new Response(
              new ReadableStream({
                async cancel() {
                  cancelStarted.resolve(null);
                  await cancelRelease.promise;
                },
              }),
              { status: 500 },
            );
          }
          return Response.json({
            data: { viewer: null, localInstanceBySlug: null },
          });
        },
      });
      publicOrigin.hostname = "mutated.invalid";
      try {
        const page = await runtime.fetch(
          new Request("https://drfed.test/about", {
            headers: {
              cookie: `session=${"A".repeat(43)}; unrelated=PRIVATE`,
              authorization: "Bearer ignored",
              forwarded: "host=ignored.invalid",
            },
          }),
        );
        assert.equal(page.status, 200);
        assert.match(await page.text(), /DrFed/u);
        const instancePage = await runtime.fetch(
          new Request("https://drfed.test/instance/test-instance", {
            headers: { cookie: `session=${"A".repeat(43)}` },
          }),
        );
        assert.equal(instancePage.status, 200);
        assert.match(await instancePage.text(), /Instance not found\./u);
        assert.ok(requests.length > 0);
        for (const request of requests) {
          assert.equal(request.url, "https://drfed.test/graphql");
          assert.equal(
            request.headers.get("authorization"),
            `Bearer ${"A".repeat(43)}`,
          );
          assert.equal(request.headers.get("cookie"), null);
          assert.equal(request.headers.get("forwarded"), null);
          assert.equal(request.headers.get("host"), null);
        }
        const asset = await runtime.fetch(
          new Request("https://drfed.test/icon.svg"),
        );
        assert.equal(asset.status, 200);
        assert.match(asset.headers.get("content-type") ?? "", /image\/svg/u);
        assert.match(await asset.text(), /<svg/u);
        const failed = assert.rejects(
          queryGraphql(
            "{ error }",
            {},
            undefined,
            new AbortController().signal,
          ),
          /GraphQL request failed \(500\)/u,
        );
        await cancelStarted.promise;
        const pending = queryGraphql(
          "{ sleep }",
          {},
          undefined,
          new AbortController().signal,
        );
        const signal = await started.promise;
        const close = runtime.close();
        let closed = false;
        // oxlint-disable-next-line promise/prefer-await-to-then
        void close.then(() => {
          closed = true;
          return closed;
        });
        assert.equal(runtime.close(), close);
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(signal.aborted, true);
        release.resolve(null);
        await pending;
        assert.equal(
          closed,
          false,
          "close lost pending error-body cancellation",
        );
        cancelRelease.resolve(null);
        await failed;
        await close;
        const closedResponse = await runtime.fetch(
          new Request("https://drfed.test/about"),
        );
        assert.equal(closedResponse.status, 503);
        await assert.rejects(
          createWebRuntime({
            publicOrigin: new URL("https://drfed.test"),
            graphqlFetch: () => Response.json({}),
          }),
          /already initialized/u,
        );
      } finally {
        release.resolve(null);
        cancelRelease.resolve(null);
        await runtime.close();
      }
      assert.deepEqual(
        watched.map((name) => process.listenerCount(name)),
        before,
      );
    } finally {
      Server.prototype.listen = originalListen;
    }
  },
);

function unexpectedListen(): never {
  throw new Error("Unexpected listening socket.");
}
