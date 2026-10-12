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

import { prepareWebRequest } from "@drfed/web/request-policy";

const publicOrigin = "https://drfed.test";

void it("requires public authority and restores scheme without trusting proxy headers", async () => {
  const abort = new AbortController();
  const request = new Request("http://DRFED.test./path?query=yes", {
    method: "POST",
    headers: {
      host: "DRFED.test.",
      forwarded: "host=evil.test;proto=http",
      "x-forwarded-host": "evil.test",
      "x-forwarded-proto": "http",
      cookie: "session=secret",
    },
    body: "payload",
    signal: abort.signal,
  });
  const prepared = prepareWebRequest(request, publicOrigin);
  assert.ok(prepared instanceof Request);
  assert.equal(prepared.url, "https://drfed.test/path?query=yes");
  assert.equal(prepared.headers.get("host"), "drfed.test");
  assert.equal(prepared.headers.get("cookie"), "session=secret");
  assert.equal(prepared.headers.get("forwarded"), null);
  assert.equal(prepared.headers.get("x-forwarded-host"), null);
  assert.equal(prepared.headers.get("x-forwarded-proto"), null);
  assert.equal(await prepared.text(), "payload");
  abort.abort();
  assert.equal(prepared.signal.aborted, true);
  for (const host of [
    "evil.test",
    "instance.drfed.test",
    "deep.instance.drfed.test",
    "drfed.test:80",
  ]) {
    const result = prepareWebRequest(
      new Request(`http://${host}/icon.svg`, { headers: { host } }),
      publicOrigin,
    );
    assert.ok(result instanceof Response);
    assert.equal(result.status, 421);
  }
  for (const host of [
    "evil.test",
    "bad host",
    "drfed.test@evil.test",
    "drfed.test,evil.test",
    "drfed.test/path",
  ]) {
    const result = prepareWebRequest(
      new Request("http://drfed.test/about", { headers: { host } }),
      publicOrigin,
    );
    assert.ok(result instanceof Response);
    assert.equal(result.status, 400);
  }
});

void it("gates every server-function spelling before consuming the body", () => {
  const paths = [
    "/_server",
    "/_server/action",
    "/_serverOther",
    "/_server%2f..%2fabout",
    "/_server%5c..%5cabout",
    "/%5fserver%2f..%2fabout",
    "/%5fserver",
    "/%255fserver",
    "/%2f_server",
    "/%5c_server",
    "/prefix/%2e%2e/_server",
  ];
  for (const path of paths) {
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]) {
      const result = prepareWebRequest(
        new Request(`http://drfed.test${path}`, { method }),
        publicOrigin,
      );
      assert.ok(result instanceof Response, `${method} ${path}`);
      assert.equal(result.status, 405, `${method} ${path}`);
      assert.equal(result.headers.get("allow"), "POST");
    }
    for (const origin of [
      undefined,
      "null",
      "not an origin",
      "https://instance.drfed.test",
      "http://drfed.test",
      "https://drfed.test, https://evil.test",
      "https://drfed.test/path",
      "https://user@drfed.test",
    ]) {
      const headers = new Headers({
        referer: "https://drfed.test/valid-fallback",
        "sec-fetch-site": "same-site",
      });
      if (origin === undefined) headers.delete("referer");
      else headers.set("origin", origin);
      const request = new Request(`http://drfed.test${path}`, {
        method: "POST",
        headers,
        body: "not serialized",
      });
      const result = prepareWebRequest(request, publicOrigin);
      assert.ok(result instanceof Response);
      assert.equal(result.status, 403, `${path} ${origin}`);
      assert.equal(request.bodyUsed, false);
    }
  }
  for (const headers of [
    { origin: "https://drfed.test" },
    { origin: "https://drfed.test:443" },
    { referer: "https://drfed.test/some/page?yes" },
  ]) {
    assert.ok(
      prepareWebRequest(
        new Request("http://drfed.test/_server?id=action", {
          method: "POST",
          headers,
          body: "payload",
        }),
        publicOrigin,
      ) instanceof Request,
    );
  }
  assert.ok(
    prepareWebRequest(
      new Request("http://drfed.test/confirm/challenge?code=private"),
      publicOrigin,
    ) instanceof Request,
  );
  assert.ok(
    prepareWebRequest(
      new Request("http://drfed.test/graphql", { method: "POST", body: "{}" }),
      publicOrigin,
    ) instanceof Request,
  );
});
