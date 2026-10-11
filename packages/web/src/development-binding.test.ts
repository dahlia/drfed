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

import {
  installDevelopmentWebBinding,
  installWebBinding,
  queryGraphql,
} from "@drfed/web/bridge";

void it("replaces a dev binding without an old close clearing or cancelling its replacement", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<null>();
  const old = installDevelopmentWebBinding({
    publicOrigin: new URL("http://old.test"),
    graphqlFetch: async (request) => {
      started.resolve(request.signal);
      await release.promise;
      return Response.json({ data: { name: "old" } });
    },
  });
  const pending = queryGraphql(
    "query {}",
    {},
    undefined,
    new AbortController().signal,
  );
  const oldSignal = await started.promise;
  const next = installDevelopmentWebBinding({
    publicOrigin: new URL("https://new.test"),
    graphqlFetch: (request) => Response.json({ data: { url: request.url } }),
  });
  const closing = old.close();
  assert.equal(old.close(), closing);
  await Promise.resolve();
  assert.equal(oldSignal.aborted, true);
  assert.equal(next.signal.aborted, false);
  release.resolve(null);
  await pending;
  await closing;
  assert.deepEqual(
    await queryGraphql("query {}", {}, undefined, new AbortController().signal),
    { data: { url: "https://new.test/graphql" } },
  );
  await next.close();
  await assert.rejects(
    queryGraphql("query {}", {}, undefined, new AbortController().signal),
    /unavailable/u,
  );
  const production = installWebBinding({
    publicOrigin: new URL("https://prod.test"),
    graphqlFetch: () => Response.json({ data: {} }),
  });
  assert.throws(
    () =>
      installDevelopmentWebBinding({
        publicOrigin: new URL("https://dev.test"),
        graphqlFetch: () => Response.json({}),
      }),
    /production/u,
  );
  await production.close();
});
