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
import { once } from "node:events";
import { createServer } from "node:http";
import { type TestContext, it } from "node:test";

import { createConfigurationBindings } from "@drfed/drfed/configuration";
import { createMailParser } from "@drfed/drfed/mail-parser";
import { createMailRuntime, prepareMail } from "@drfed/drfed/mail-runtime";
import { resolveMailSettings } from "@drfed/drfed/mail-settings";
import { run } from "@optique/run";
import { createMessage } from "@upyo/core";

async function parsed(
  extra: readonly string[] = [],
  env: Record<string, string> = {},
) {
  const bindings = createConfigurationBindings({ env: (name) => env[name] });
  return await run(createMailParser(bindings), {
    args: [
      "--mail-transport",
      "mailgun",
      "--mailgun-domain",
      "mg.example.com",
      "--mail-api-key",
      "TOKEN",
      ...extra,
    ],
    contexts: bindings.contexts,
    contextOptions: { load: () => undefined },
    colors: false,
    stderr: () => undefined,
    onExit(code): never {
      throw new Error(`CLI exit ${code}`);
    },
  });
}
const message = () =>
  createMessage({
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "Fixture",
    content: { text: "PRIVATE_LOGIN_CODE" },
  });
it("selects Mailgun credentials without reading unused providers", async () => {
  const raw = await parsed([], {
    DRFED_MAILGUN_API_KEY_FILE: "MISSING",
    DRFED_LETTERMINT_BASE_URL: "INVALID",
    DRFED_SMTP_PORT: "INVALID",
  });
  const resolved = resolveMailSettings(raw);
  assert.equal(resolved.mail.transport, "mailgun");
  assert.equal(resolved.diagnostic["mail.api_key"]?.value, "<redacted>");
  assert.doesNotMatch(JSON.stringify(resolved.diagnostic), /TOKEN|MISSING/u);
  if (resolved.mail.transport !== "mailgun") throw new Error();
  assert.equal(resolved.mail.connection.baseUrl, "https://api.mailgun.net/v3");
  assert.equal(resolved.mail.connection.retries, 0);
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        mailgunApiKey: { value: "other", source: "cli" },
      }),
    /Conflicting mail API credential/u,
  );
  const file = resolveMailSettings({
    ...raw,
    mailApiKey: undefined,
    mailgunApiKeyFile: { value: "PRIVATE_MISSING", source: "cli" },
  });
  await assert.rejects(
    prepareMail(file.mail),
    (e) => e instanceof Error && !e.message.includes("PRIVATE_MISSING"),
  );
});
it("validates Mailgun endpoint paths and bounded timeout", async () => {
  const raw = await parsed();
  for (const value of [
    "http://external.example/api",
    "https://SECRET@mail.example/api",
    "https://mail.example/api?secret",
    "https://mail.example/api#secret",
    "https://mail.example/api?",
    "https://mail.example/api#",
  ]) {
    assert.throws(
      () =>
        resolveMailSettings({
          ...raw,
          mailgunBaseUrl: { value, source: "cli" },
        }),
      /Invalid mailgun API endpoint/u,
    );
  }
  const good = resolveMailSettings({
    ...raw,
    mailgunBaseUrl: {
      value: "https://mail.example/custom/v2/",
      source: "cli",
    },
  });
  if (good.mail.transport !== "mailgun") throw new Error();
  assert.equal(good.mail.connection.baseUrl, "https://mail.example/custom/v2");
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        mailgunTimeout: { value: "0", source: "cli" },
      }),
    /Invalid Mailgun delivery timeout/u,
  );
});
async function fixture(
  t: TestContext,
  mode: "success" | "fail" | "stall",
  timeout = 30000,
) {
  const requests: {
    path: string | undefined;
    key: string | string[] | undefined;
    body: Record<string, unknown>;
  }[] = [];
  const started = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push({
          path: request.url,
          key: request.headers["authorization"],
          body: Object.fromEntries(
            await new Request("http://fixture", {
              method: "POST",
              headers: {
                "Content-Type": String(request.headers["content-type"]),
              },
              body: Buffer.concat(chunks),
            }).formData(),
          ),
        });
        response.setHeader("Content-Type", "application/json");
        response.writeHead(mode === "fail" ? 503 : 200);
        if (mode === "stall") {
          response.flushHeaders();
          started.resolve();
          return;
        }
        response.end(
          JSON.stringify(
            mode === "success"
              ? {
                  success: true,
                  id: "<fixture@example.com>",
                  message: "Queued",
                }
              : { success: false, message: "PRIVATE_PROVIDER_ERROR" },
          ),
        );
        started.resolve();
      } catch (error) {
        response.destroy(error as Error);
      }
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const settings = resolveMailSettings(
    await parsed([
      "--mailgun-base-url",
      `http://127.0.0.1:${address.port}/api/v2`,
      "--mailgun-timeout",
      String(timeout),
    ]),
  );
  const runtime = createMailRuntime(await prepareMail(settings.mail));
  t.after(() => runtime.close());
  return { runtime, requests, started: started.promise };
}
it("sends Mailgun API key and preserves API path without automatic replay", async (t) => {
  const ok = await fixture(t, "success");
  const receipt = await ok.runtime.transport.send(message());
  assert.equal(receipt.successful, true);
  assert.equal(ok.requests[0]?.path, "/api/v2/mg.example.com/messages");
  assert.equal(ok.requests[0]?.key, `Basic ${btoa("api:TOKEN")}`);
  assert.equal(ok.requests[0]?.body.subject, "Fixture");
  for (const name of ["o:tracking", "o:tracking-clicks", "o:tracking-opens"]) {
    assert.equal(ok.requests[0]?.body[name], "no");
  }
  const fail = await fixture(t, "fail");
  assert.equal(
    (await fail.runtime.transport.send(message())).successful,
    false,
  );
  assert.equal(fail.requests.length, 1);
});
it(
  "bounds Mailgun response bodies and drains shutdown",
  { timeout: 15000 },
  async (t) => {
    const originalFetch = globalThis.fetch;
    const bodyStarted = Promise.withResolvers<void>();
    t.mock.method(
      globalThis,
      "fetch",
      async (...args: Parameters<typeof fetch>) => {
        const response = await originalFetch(...args);
        const originalRead = response.text.bind(response);
        t.mock.method(response, "text", () => {
          const reading = originalRead();
          bodyStarted.resolve();
          return reading;
        });
        return response;
      },
    );
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const timed = await fixture(t, "stall", 100);
    const delivery = timed.runtime.transport.send(message());
    await bodyStarted.promise;
    t.mock.timers.tick(100);
    const receipt = await delivery;
    t.mock.timers.reset();
    t.mock.restoreAll();
    assert.equal(receipt.successful, false);
    const closing = await fixture(t, "stall");
    const send = closing.runtime.transport.send(message());
    const rejection = assert.rejects(send, /Mailgun transport is closed/u);
    await closing.started;
    const first = closing.runtime.close();
    assert.equal(first, closing.runtime.close());
    await first;
    await rejection;
    await assert.rejects(closing.runtime.transport.send(message()), /closed/u);
    const cancelled = await fixture(t, "stall");
    const controller = new AbortController();
    const pending = cancelled.runtime.transport.send(message(), {
      signal: controller.signal,
    });
    const cancelledCheck = assert.rejects(pending, (e) => e === "cancelled");
    await cancelled.started;
    controller.abort("cancelled");
    await cancelledCheck;
  },
);

it("normalizes Mailgun DNS domains and chooses region endpoints", async () => {
  const raw = await parsed();
  for (const value of [
    "",
    "../other",
    "mg.example.com/path",
    "user@mg.example.com",
    "mg.example.com?x",
    "127.0.0.1",
    "bad_domain.example",
    ["a".repeat(64), "example"].join("."),
    "mg.example.com:443",
  ]) {
    assert.throws(
      () =>
        resolveMailSettings({
          ...raw,
          mailgunDomain: { value, source: "cli" },
        }),
      /Invalid Mailgun sending domain/u,
    );
  }
  const eu = resolveMailSettings({
    ...raw,
    mailgunRegion: { value: "eu", source: "cli" },
    mailgunDomain: { value: "MÜNCHEN.Example.", source: "cli" },
  });
  if (eu.mail.transport !== "mailgun") throw new Error();
  assert.equal(eu.mail.connection.domain, "xn--mnchen-3ya.example");
  assert.equal(eu.mail.connection.baseUrl, "https://api.eu.mailgun.net/v3");
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        mailgunRegion: { value: "other", source: "cli" },
      }),
    /Invalid Mailgun region/u,
  );
});
