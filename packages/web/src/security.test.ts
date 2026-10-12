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
import { readFile } from "node:fs/promises";
import { it } from "node:test";

import { createWebRuntime } from "@drfed/web";
import { toCrossJSON } from "seroval";

void it("protects actual server functions and issues a secure cookie behind HTTP TLS termination", async () => {
  const requests: Request[] = [];
  let mutations = 0;
  const runtime = await createWebRuntime({
    publicOrigin: new URL("https://drfed.test"),
    graphqlFetch: async (request) => {
      requests.push(request);
      const body: unknown = await request.json();
      if (
        typeof body === "object" &&
        body !== null &&
        "query" in body &&
        typeof body.query === "string" &&
        body.query.includes("mutation CompleteLoginChallenge")
      ) {
        mutations += 1;
        return Response.json({
          data: {
            completeLoginChallenge: {
              accessToken: "A".repeat(43),
              expires: "2099-01-01T00:00:00Z",
            },
          },
        });
      }
      return Response.json({ data: { viewer: null } });
    },
  });
  try {
    const moduleUrl = import.meta.resolve("@drfed/web");
    const bundle = await readFile(
      new URL("../.output/server/_ssr/ssr.mjs", moduleUrl),
      "utf8",
    );
    const reference =
      /completeLoginChallengeMutation = [^;]+;[\s\S]*?createServerReference\("(?<id>[^" ]+)"/u.exec(
        bundle,
      )?.[1];
    assert.ok(reference !== undefined, "built login action registration");
    const node = JSON.stringify(
      toCrossJSON([
        {
          challengeId: "00000000-0000-7000-8000-000000000001",
          code: "fixture",
        },
      ]),
    );
    const body = `;0x${new TextEncoder().encode(node).length.toString(16).padStart(8, "0")};${node}`;
    const url = `http://drfed.test/_server?id=${reference}`;
    const paths = [
      url,
      url.replace("/_server", "/%5fserver"),
      url.replace("/_server", "/_serverOther"),
      url.replace("/_server", "/_server%2f..%2fabout"),
      url.replace("/_server", "/_server%5c..%5cabout"),
    ];
    await Promise.all(
      paths.flatMap((path) =>
        ["GET", "HEAD"].map(async (method) => {
          const denied = await runtime.fetch(new Request(path, { method }));
          assert.equal(denied.status, 405);
        }),
      ),
    );
    await Promise.all(
      paths.map(async (path) => {
        const denied = await runtime.fetch(
          new Request(path, {
            method: "POST",
            headers: {
              origin: "https://instance.drfed.test",
              "x-start-type": "0",
              "x-server-instance": "fixture",
            },
            body,
          }),
        );
        assert.equal(denied.status, 403);
      }),
    );
    assert.equal(requests.length, 0);
    const page = await runtime.fetch(
      new Request(
        "http://drfed.test/confirm/00000000-0000-7000-8000-000000000001?code=fixture",
      ),
    );
    assert.equal(page.status, 200);
    await page.text();
    assert.equal(mutations, 0);
    const response = await runtime.fetch(
      new Request(url, {
        method: "POST",
        headers: {
          origin: "https://drfed.test",
          "x-start-type": "0",
          "x-server-instance": "fixture",
          "x-forwarded-proto": "http",
          forwarded: "proto=http",
        },
        body,
      }),
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    await response.text();
    assert.equal(response.status, 200);
    assert.equal(mutations, 1);
    assert.match(cookie, /session=A{43}/u);
    assert.match(cookie, /; Secure/u);
    assert.match(cookie, /; HttpOnly/u);
    assert.match(cookie, /; SameSite=Lax/u);
    assert.match(cookie, /; Path=\//u);
    assert.doesNotMatch(cookie, /Domain=/u);
    assert.ok(
      requests.every((request) => request.url === "https://drfed.test/graphql"),
    );
  } finally {
    await runtime.close();
  }
});
