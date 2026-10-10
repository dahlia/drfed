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

import type { OperationTracker } from "@drfed/graphql";
import {
  type DrFedSchemaTypes,
  builder as applicationBuilder,
} from "@drfed/graphql/builder";
import SchemaBuilder from "@pothos/core";
import { createYoga, useExecutionCancellation } from "graphql-yoga";

for (const hook of ["resolveType", "isTypeOf"] as const) {
  it(
    `tracks ${hook} work after Yoga cancels execution`,
    { timeout: 10_000 },
    async () => {
      const started = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      const pending = new Set<Promise<unknown>>();
      const trackOperation: OperationTracker = async (operation) => {
        // Register before invoking callbacks that can request shutdown.
        // oxlint-disable-next-line promise/prefer-await-to-then
        const task = Promise.resolve().then(operation);
        pending.add(task);
        try {
          return await task;
        } finally {
          pending.delete(task);
        }
      };
      const builder = new SchemaBuilder<DrFedSchemaTypes>({
        ...applicationBuilder.options,
        plugins: ["drfedOperations"],
      });
      const item = builder.objectRef<object>("TrackedItem");
      builder.objectType(item, {
        fields: (t) => ({ value: t.string({ resolve: () => "value" }) }),
        isTypeOf: async () => {
          if (hook === "isTypeOf") {
            started.resolve();
            await completed.promise;
          }
          return true;
        },
      });
      const union = builder.unionType("TrackedUnion", {
        types: [item],
        resolveType: async () => {
          if (hook === "resolveType") {
            started.resolve();
            await completed.promise;
          }
          return "TrackedItem";
        },
      });
      builder.queryType({
        fields: (t) => ({
          item: t.field({
            type: hook === "resolveType" ? union : item,
            resolve: () => ({}),
          }),
        }),
      });
      const yoga = createYoga({
        schema: builder.toSchema(),
        context: { trackOperation },
        plugins: [useExecutionCancellation()],
        logging: false,
      });
      const abort = new AbortController();
      const response = (async () => {
        try {
          return await yoga.fetch(
            new Request("http://drfed.test/graphql", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ query: "{ item { __typename } }" }),
              signal: abort.signal,
            }),
          );
        } catch {
          return undefined;
        }
      })();
      try {
        await started.promise;
        abort.abort();
        await response;
        assert.ok(
          pending.size > 0,
          "HTTP cancellation lost the unfinished type operation",
        );
        completed.resolve();
        while (pending.size > 0) {
          // A completed type resolver can schedule its isTypeOf hook.
          // oxlint-disable-next-line no-await-in-loop
          await Promise.allSettled([...pending]);
        }
        assert.equal(pending.size, 0);
      } finally {
        abort.abort();
        completed.resolve();
        await response;
        await Promise.allSettled([...pending]);
        await yoga[Symbol.asyncDispose]();
      }
    },
  );
}
