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
  createControlSurface,
  createFetchHandler,
  findStrandedInstances,
  getIngressMetadata,
  warnAboutStrandedInstances,
} from "@drfed/drfed/serving";
import createFederation, { createInboundRecorder } from "@drfed/federation";
import { migrate, relations, schema } from "@drfed/models";
import { uuidV7 as uuid } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import {
  MemoryKvStore,
  generateCryptoKeyPair,
  signRequest,
  verifyRequest,
} from "@fedify/fedify";
import { CryptographicKey } from "@fedify/vocab";
import { type LogRecord, withConfig } from "@logtape/logtape";
import { describe } from "@logtape/testing-node/autoload";
import { drizzle } from "drizzle-orm/pglite";

const rootOrigin = new URL("https://drfed.net");

/**
 * A stand-in for the request object a server adapter hands the handler, whose
 * `url` may be a string `URL` refuses.  `Request` cannot express that: undici
 * parses the URL in its own constructor.
 * @param url The request URL, valid or not.
 * @param host The `Host` header to report.
 * @returns Something shaped enough like a `Request` for the router.
 */
function fakeRequest(url: string, host: string): Request {
  return { headers: new Headers({ host }), url } as Request;
}

function handler(): {
  handle: (request: Request) => Promise<Response>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  federationCalls: string[];
  controlCalls: string[];
} {
  const federationCalls: string[] = [];
  const controlCalls: string[] = [];
  const handle = createFetchHandler({
    rootOrigin,
    federation: {
      async fetch(request, options) {
        federationCalls.push(request.url);
        // Stand in for a dispatcher that resolved to nothing, which is what
        // every route does on a subdomain no instance has claimed.
        return await options.onNotFound(request);
      },
    },
    serveControlSurface(request) {
      controlCalls.push(request.url);
      return new Response("graphql", { status: 200 });
    },
  });
  return {
    handle,
    fetch: async (url, init) => await handle(new Request(url, init)),
    federationCalls,
    controlCalls,
  };
}

describe("createFetchHandler()", () => {
  it("serves ActivityPub on an instance subdomain", async () => {
    const { fetch, federationCalls, controlCalls } = handler();
    const response = await fetch("https://foo-bar.drfed.net/users/x");
    assert.equal(response.status, 404);
    assert.deepEqual(federationCalls, ["https://foo-bar.drfed.net/users/x"]);
    assert.deepEqual(controlCalls, []);
  });

  it("keeps the control surface off instance subdomains", async () => {
    // The whole point of routing by authority: a tenant's host must never
    // answer for GraphQL, even though the same process serves it.
    const { fetch, federationCalls, controlCalls } = handler();
    const response = await fetch("https://foo-bar.drfed.net/graphql");
    assert.equal(response.status, 404);
    assert.deepEqual(controlCalls, []);
    assert.equal(federationCalls.length, 1);
  });

  it("serves the control surface on the root origin", async () => {
    const { fetch, federationCalls, controlCalls } = handler();
    const response = await fetch("https://drfed.net/graphql");
    assert.equal(response.status, 200);
    assert.deepEqual(controlCalls, ["https://drfed.net/graphql"]);
    assert.deepEqual(federationCalls, []);
  });

  it("serves the control surface on an unrelated authority", async () => {
    // The frontend reaches the backend by its listening address, which names
    // no instance; that has to keep working.
    const { fetch, controlCalls } = handler();
    assert.equal((await fetch("http://127.0.0.1:8888/graphql")).status, 200);
    assert.equal((await fetch("http://localhost:3000/graphql")).status, 200);
    assert.equal(controlCalls.length, 2);
  });

  it("answers 421 below an instance subdomain", async () => {
    const { fetch, federationCalls, controlCalls } = handler();
    const response = await fetch("https://a.b.drfed.net/");
    assert.equal(response.status, 421);
    assert.deepEqual(federationCalls, []);
    assert.deepEqual(controlCalls, []);
  });

  it("refuses a request whose URL disagrees with its Host header", async () => {
    // The srvx adapter substitutes the literal `_invalid_` for a `Host` it
    // cannot parse, which would otherwise classify as the control surface and
    // answer GraphQL to a request that named a tenant.
    const { fetch, federationCalls, controlCalls } = handler();
    const response = await fetch("http://_invalid_/graphql", {
      headers: { host: "foo-bar.drfed.net." },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(controlCalls, []);
    assert.deepEqual(federationCalls, []);
  });

  it("refuses a request URL that cannot be parsed", async () => {
    // The srvx adapter validates `Host` against a structural pattern and
    // builds the request URL by concatenation, so hosts that `URL` rejects
    // still reach the handler.  Parsing one used to throw, and with no rejection handler
    // anywhere above, a single unauthenticated request ended the process.
    const { handle, federationCalls, controlCalls } = handler();
    // Both fail the WHATWG IPv4 host parser, which is spec-defined rather
    // than a property of whichever ICU the runtime was built with.
    const hosts = ["1.2.3.4.5", "999.1.1.1"];
    const results = await Promise.all(
      hosts.map(async (host) => {
        assert.equal(URL.canParse(`http://${host}/`), false, host);
        const response = await handle(fakeRequest(`http://${host}/`, host));
        return { host, status: response.status };
      }),
    );
    for (const { host, status } of results) {
      assert.equal(status, 400, host);
    }
    assert.deepEqual(controlCalls, []);
    assert.deepEqual(federationCalls, []);
  });

  it("accepts a Host that merely spells the authority differently", async () => {
    // A reverse proxy may forward a `Host` that writes out the default port,
    // and the check must not fire on that.
    const { fetch } = handler();
    const control = await fetch("https://drfed.net/graphql", {
      headers: { host: "drfed.net:443" },
    });
    assert.equal(control.status, 200);
    // A root-zone dot is likewise only a spelling, and the check tolerates it
    // here.  Note this shape does not actually reach the handler in
    // production: srvx's own host pattern rejects a trailing dot and
    // substitutes `_invalid_`, so such a request is answered 400 above.  The
    // tolerance still matters for adapters that do pass it through.
    const tenant = await fetch("https://foo-bar.drfed.net/users/x", {
      headers: { host: "foo-bar.drfed.net." },
    });
    assert.equal(tenant.status, 404);
  });

  it("never asks the database what exists", async () => {
    // An unclaimed subdomain still routes to ActivityPub, where the
    // dispatchers resolve to nothing.  That is what keeps routing free of a
    // per-request lookup.
    const { fetch, federationCalls } = handler();
    assert.equal((await fetch("https://nobody.drfed.net/users/x")).status, 404);
    assert.deepEqual(federationCalls, ["https://nobody.drfed.net/users/x"]);
  });
});

describe("findStrandedInstances()", () => {
  it("reports only local instances outside the root origin", async () => {
    const client = new PGlite();
    try {
      await migrate({ credentials: { driver: "pglite", client } });
      const db = drizzle({ client, relations, schema });
      const rows = [
        // Reachable under the configured root origin.
        { host: "here.drfed.net", slug: "here", local: true },
        // Left behind by a root origin change.
        { host: "there.drfed.org", slug: "there", local: true },
        // Also stranded: an instance occupies exactly one label.
        { host: "deep.nested.drfed.net", slug: "deep", local: true },
        // Remote instances are nobody's business here.
        { host: "remote.example.com", slug: "remote", local: false },
        // Not a URL at all: the WHATWG IPv4 parser rejects it.  Reporting
        // such a row must not throw, because startup waits on this scan and
        // one bad row would otherwise keep the deployment from coming back
        // up.  The slug and the host disagree here, which is the point: only
        // the stored host is consulted.
        { host: "999.1.1.1", slug: "unparseable", local: true },
      ];
      const expires = Temporal.Now.instant().add({ hours: 24 });
      const seeded = rows.map(({ host, slug, local }) => ({
        host,
        localId: local ? uuid() : null,
        slug,
      }));
      await db
        .insert(schema.localInstances)
        .values(
          seeded
            .filter(({ localId }) => localId != null)
            .map(({ localId, slug }) => ({ id: localId!, slug, expires })),
        );
      await db
        .insert(schema.instances)
        .values(
          seeded.map(({ host, localId }) => ({ id: uuid(), localId, host })),
        );

      const stranded = await findStrandedInstances(db, rootOrigin);
      assert.deepEqual([...stranded].sort(), [
        "999.1.1.1",
        "deep.nested.drfed.net",
        "there.drfed.org",
      ]);
      assert.ok(!stranded.includes("here.drfed.net"));
      // It only reports; nothing is rewritten.
      const after = await db.select().from(schema.instances);
      assert.deepEqual(
        after.map(({ host }) => host).sort(),
        rows.map(({ host }) => host).sort(),
      );
      await warnAboutStrandedInstances(db, rootOrigin);
    } finally {
      await client.close();
    }
  });
});

it("records inbox requests only on the instance surface", async () => {
  const client = new PGlite();
  try {
    await migrate({ credentials: { driver: "pglite", client } });
    const db = drizzle({ client, relations, schema });
    const localId = uuid();
    await db.insert(schema.localInstances).values({
      id: localId,
      slug: "logs",
      expires: Temporal.Now.instant().add({ hours: 24 }),
    });
    await db
      .insert(schema.instances)
      .values({ id: localId, localId, host: "logs.drfed.net" });
    const kv = new MemoryKvStore();
    const federation = await createFederation(db, { kv });
    const fetch = createFetchHandler({
      rootOrigin,
      federation: createInboundRecorder({
        db,
        federation,
        rootOrigin,
        ingressMetadata: getIngressMetadata,
      }),
      serveControlSurface: () => new Response("control"),
    });
    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Create",
      actor: "https://remote.example/alice",
    });
    assert.equal(
      (
        await fetch(
          new Request("http://logs.drfed.net/inbox", {
            method: "POST",
            body,
            headers: { "x-forwarded-host": "PRIVATE_PROXY_FIXTURE" },
          }),
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(
          new Request("https://drfed.net/inbox", { method: "POST", body }),
        )
      ).status,
      200,
    );
    const rows = await db.query.activityDeliveries.findMany();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.instanceId, localId);
    assert.equal(rows[0]?.status, "unverified");
    assert.equal(rows[0]?.requestUrl, "http://logs.drfed.net/inbox");
    assert.ok(
      rows[0]?.headers?.some(
        ([name, value]) =>
          name === "x-forwarded-host" && value === "PRIVATE_PROXY_FIXTURE",
      ),
    );
  } finally {
    await client.close();
  }
});

it("logs federation failures without secrets and continues serving", async () => {
  const records: LogRecord[] = [];
  await withConfig(
    {
      sinks: { capture: (record) => records.push(record) },
      loggers: [{ category: ["drfed", "serving"], sinks: ["capture"] }],
    },
    async () => {
      let broken = true;
      const fetch = createFetchHandler({
        rootOrigin,
        federation: {
          fetch() {
            if (broken) {
              const error = new Error("PRIVATE_SECRET", {
                cause: { privateKey: "PRIVATE_CAUSE" },
              });
              error.name = "PRIVATE_NAME";
              throw error;
            }
            return Promise.resolve(new Response("ok"));
          },
        },
        serveControlSurface: () => new Response("graphql"),
      });
      // Check the two request paths sequentially.
      // oxlint-disable no-await-in-loop
      for (const method of ["GET", "POST"]) {
        const response = await fetch(
          new Request(
            "https://demo.drfed.net/users/x/inbox?token=PRIVATE_QUERY",
            { method },
          ),
        );
        assert.equal(response.status, 500);
        assert.equal(await response.text(), "Internal server error");
      }
      broken = false;
      assert.equal(
        (await fetch(new Request("https://demo.drfed.net/users/x"))).status,
        200,
      );
      assert.equal(records.length, 2);
      for (const [index, record] of records.entries()) {
        assert.equal(record.level, "error");
        assert.deepEqual(record.category, ["drfed", "serving"]);
        assert.deepEqual(record.properties, {
          method: ["GET", "POST"][index],
          path: "/users/x/inbox",
          errorType: "Error",
        });
      }
      assert.ok(!JSON.stringify(records).includes("PRIVATE_"));
    },
  );
});

it("composes only the exact GraphQL path and never falls back from federation", async () => {
  const calls: string[] = [];
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("stream"));
        controller.close();
      },
    }),
  );
  const graphql = (request: Request) => {
    calls.push(`graphql:${new URL(request.url).pathname}`);
    return response;
  };
  const web = (request: Request) => {
    calls.push(`web:${new URL(request.url).pathname}`);
    return new Response("web");
  };
  const control = createControlSurface({ graphql, web });
  const router = createFetchHandler({
    rootOrigin,
    federation: {
      fetch(request, options) {
        return Promise.resolve(options.onNotFound(request));
      },
    },
    serveControlSurface: control,
  });
  assert.equal(
    await router(new Request("https://drfed.net/graphql?query=test")),
    response,
  );
  assert.equal(response.bodyUsed, false);
  assert.equal(
    await (await router(new Request("https://drfed.net/graphql/"))).text(),
    "web",
  );
  assert.equal(
    (await router(new Request("https://demo.drfed.net/about"))).status,
    404,
  );
  assert.deepEqual(calls, ["graphql:/graphql", "web:/graphql/"]);
  const backend = createControlSurface({ graphql });
  assert.equal((await backend(new Request("https://drfed.net/"))).status, 404);
  assert.equal(
    (await backend(new Request("https://drfed.net/graphql/"))).status,
    404,
  );
  assert.equal(
    await backend(new Request("https://drfed.net/graphql")),
    response,
  );
});

it("restores the instance public scheme while preserving signed headers, body and cancellation", async () => {
  const abort = new AbortController();
  let received: Request | undefined;
  const router = createFetchHandler({
    rootOrigin,
    federation: {
      fetch(request) {
        received = request;
        return Promise.resolve(new Response("instance"));
      },
    },
    serveControlSurface: () => new Response("control"),
  });
  const request = new Request("http://demo.drfed.net/inbox?delivery=1", {
    method: "POST",
    headers: {
      host: "demo.drfed.net",
      signature: "signed fixture",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
    },
    body: "original signed body",
    signal: abort.signal,
  });
  assert.equal((await router(request)).status, 200);
  assert.ok(received);
  assert.equal(received.url, "https://demo.drfed.net/inbox?delivery=1");
  assert.equal(received.headers.get("host"), "demo.drfed.net");
  assert.equal(received.headers.get("signature"), "signed fixture");
  assert.equal(received.headers.get("x-forwarded-host"), "evil.example");
  assert.equal(received.headers.get("x-forwarded-proto"), "http");
  assert.equal(getIngressMetadata(received)?.url, request.url);
  assert.equal(
    getIngressMetadata(received)?.headers.get("x-forwarded-host"),
    "evil.example",
  );
  assert.equal(await received.text(), "original signed body");
  abort.abort();
  assert.equal(received.signal.aborted, true);
});

it("verifies an RFC 9421 target URI after TLS termination scheme restoration", async () => {
  const pair = await generateCryptoKeyPair();
  const keyId = new URL("https://remote.example/actor#key");
  const key = new CryptographicKey({
    id: keyId,
    owner: new URL("https://remote.example/actor"),
    publicKey: pair.publicKey,
  });
  const keyCache = {
    get() {
      return Promise.resolve(key);
    },
    set() {
      // Failed verification may refresh a cached key; this is an offline fixture.
      return Promise.resolve();
    },
  };
  const signed = await signRequest(
    new Request("https://demo.drfed.net/inbox?delivery=1", {
      method: "POST",
      headers: {
        host: "demo.drfed.net",
        "content-type": "application/activity+json",
      },
      body: JSON.stringify({ type: "Create" }),
    }),
    pair.privateKey,
    keyId,
    { spec: "rfc9421" },
  );
  const verifyOptions = {
    spec: "rfc9421" as const,
    keyCache,
    documentLoader: () =>
      Promise.reject(new Error("Offline signature fixture.")),
  };
  assert.ok(
    await verifyRequest(signed.clone(), verifyOptions),
    "The original public ActivityPub request verifies.",
  );
  const incoming = new Request("http://demo.drfed.net/inbox?delivery=1", {
    method: signed.method,
    headers: signed.headers,
    body: await signed.text(),
  });
  assert.equal(await verifyRequest(incoming.clone(), verifyOptions), null);
  let verified: Awaited<ReturnType<typeof verifyRequest>> = null;
  const routing = createFetchHandler({
    rootOrigin,
    federation: {
      async fetch(request) {
        verified = await verifyRequest(request, verifyOptions);
        return new Response("verified");
      },
    },
    serveControlSurface: () => new Response("wrong surface", { status: 500 }),
  });
  assert.equal(await (await routing(incoming)).text(), "verified");
  assert.ok(verified);
});
