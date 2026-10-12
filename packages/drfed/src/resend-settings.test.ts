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
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { createConfigurationBindings } from "@drfed/drfed/configuration";
import { createMailParser } from "@drfed/drfed/mail-parser";
import { createMailRuntime, prepareMail } from "@drfed/drfed/mail-runtime";
import { resolveMailSettings } from "@drfed/drfed/mail-settings";
import { run } from "@optique/run";
import { createMessage } from "@upyo/core";

async function parsed(
  extra: readonly string[] = [],
  env: Record<string, string> = {},
  defaults = true,
) {
  const bindings = createConfigurationBindings({ env: (name) => env[name] });
  return await run(createMailParser(bindings), {
    args: [
      ...(defaults
        ? ["--mail-transport", "resend", "--mail-api-key", "TOKEN"]
        : []),
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
it("selects Resend credentials without reading unused providers", async () => {
  const raw = await parsed([], {
    DRFED_PLUNK_API_KEY_FILE: "MISSING",
    DRFED_LETTERMINT_BASE_URL: "INVALID",
    DRFED_SMTP_PORT: "INVALID",
  });
  const resolved = resolveMailSettings(raw);
  assert.equal(resolved.mail.transport, "resend");
  assert.equal(resolved.diagnostic["mail.api_key"]?.value, "<redacted>");
  assert.doesNotMatch(JSON.stringify(resolved.diagnostic), /TOKEN|MISSING/u);
  if (resolved.mail.transport !== "resend") throw new Error();
  assert.equal(resolved.mail.connection.baseUrl, "https://api.resend.com");
  assert.equal(resolved.mail.connection.retries, 3);
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        resendApiKey: { value: "other", source: "cli" },
      }),
    /Conflicting mail API credential/u,
  );
  const file = resolveMailSettings({
    ...raw,
    mailApiKey: undefined,
    resendApiKeyFile: { value: "PRIVATE_MISSING", source: "cli" },
  });
  await assert.rejects(
    prepareMail(file.mail),
    (e) => e instanceof Error && !e.message.includes("PRIVATE_MISSING"),
  );
});
it("validates Resend endpoint paths and bounded timeout", async () => {
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
          resendBaseUrl: { value, source: "cli" },
        }),
      /Invalid resend API endpoint/u,
    );
  }
  const good = resolveMailSettings({
    ...raw,
    resendBaseUrl: {
      value: "https://mail.example/custom/v2/",
      source: "cli",
    },
  });
  if (good.mail.transport !== "resend") throw new Error();
  assert.equal(good.mail.connection.baseUrl, "https://mail.example/custom/v2");
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        resendTimeout: { value: "0", source: "cli" },
      }),
    /Invalid Resend delivery timeout/u,
  );
});
async function fixture(
  t: TestContext,
  mode: "success" | "fail" | "stall" | "retry" | "auth",
  timeout = 30000,
  retries = 0,
) {
  const requests: {
    path: string | undefined;
    key: string | string[] | undefined;
    idempotencyKey: string | string[] | undefined;
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
          idempotencyKey: request.headers["idempotency-key"],
          body: JSON.parse(Buffer.concat(chunks).toString()) as Record<
            string,
            unknown
          >,
        });
        response.setHeader("Content-Type", "application/json");
        const failed =
          mode === "fail" ||
          mode === "auth" ||
          (mode === "retry" && requests.length === 1);
        response.writeHead(mode === "auth" ? 401 : failed ? 503 : 200);
        if (mode === "stall") {
          response.flushHeaders();
          started.resolve();
          return;
        }
        response.end(
          JSON.stringify(
            !failed ? { id: "fixture" } : { message: "PRIVATE_PROVIDER_ERROR" },
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
      "--resend-base-url",
      `http://127.0.0.1:${address.port}/api/v2`,
      "--resend-timeout",
      String(timeout),
      "--resend-retries",
      String(retries),
    ]),
  );
  const runtime = createMailRuntime(await prepareMail(settings.mail));
  t.after(() => runtime.close());
  return { runtime, requests, started: started.promise };
}
it("sends Resend API key and preserves API path without automatic replay", async (t) => {
  const ok = await fixture(t, "success");
  const receipt = await ok.runtime.transport.send(message());
  assert.equal(receipt.successful, true);
  assert.equal(ok.requests[0]?.path, "/api/v2/emails");
  assert.equal(ok.requests[0]?.key, "Bearer TOKEN");
  assert.match(String(ok.requests[0]?.idempotencyKey), /^[0-9a-f-]{36}$/u);
  assert.equal(ok.requests[0]?.body.subject, "Fixture");
  assert.equal(ok.requests[0]?.body.text, "PRIVATE_LOGIN_CODE");
  const fail = await fixture(t, "fail");
  assert.equal(
    (await fail.runtime.transport.send(message())).successful,
    false,
  );
  assert.equal(fail.requests.length, 1);
  const auth = await fixture(t, "auth", 30000, 3);
  assert.equal(
    (await auth.runtime.transport.send(message())).successful,
    false,
  );
  assert.equal(auth.requests.length, 1);
});
it(
  "bounds Resend response bodies and drains shutdown",
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
    const rejection = assert.rejects(send, /Resend transport is closed/u);
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

it("reuses one Resend idempotency key during a bounded retry", async (t) => {
  const retry = await fixture(t, "retry", 30000, 1);
  const receipt = await retry.runtime.transport.send({
    ...message(),
    idempotencyKey: "FIXTURE_EXPLICIT",
  });
  assert.equal(receipt.successful, true);
  assert.equal(retry.requests.length, 2);
  assert.equal(typeof retry.requests[0]?.idempotencyKey, "string");
  assert.equal(retry.requests[0]?.idempotencyKey, "FIXTURE_EXPLICIT");
  assert.equal(
    retry.requests[0]?.idempotencyKey,
    retry.requests[1]?.idempotencyKey,
  );
});

it("validates Resend retry limits from environment and ignores inactive fields", async () => {
  const raw = await parsed(
    [],
    {
      DRFED_MAIL_TRANSPORT: "resend",
      DRFED_RESEND_API_KEY: "TOKEN",
      DRFED_RESEND_RETRIES: "2",
      DRFED_RESEND_TIMEOUT: "1234",
    },
    false,
  );
  const resolved = resolveMailSettings(raw);
  assert.equal(resolved.mail.transport, "resend");
  if (resolved.mail.transport !== "resend") throw new Error();
  assert.equal(resolved.mail.connection.retries, 2);
  assert.equal(resolved.mail.connection.timeout, 1234);
  assert.equal(resolved.diagnostic["mail.resend.api_key"]?.value, "<redacted>");
  for (const value of ["-1", "11", "1.5", "INVALID"]) {
    assert.throws(
      () =>
        resolveMailSettings({
          ...raw,
          resendRetries: { value, source: "env" },
        }),
      /Invalid Resend retries/u,
    );
  }
  assert.equal(
    resolveMailSettings(
      await parsed(
        ["--mail-transport", "logtape"],
        {
          DRFED_RESEND_RETRIES: "INVALID",
          DRFED_RESEND_API_KEY_FILE: "PRIVATE_MISSING",
        },
        false,
      ),
    ).mail.transport,
    "logtape",
  );
});

for (const mode of ["deadline", "cancel", "close"] as const) {
  it(`interrupts Resend backoff on ${mode}`, { timeout: 15000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const originalTimeout = globalThis.setTimeout;
    const backoffStarted = Promise.withResolvers<void>();
    t.mock.method(
      globalThis,
      "setTimeout",
      (callback: () => void, milliseconds?: number) => {
        const timer = originalTimeout(callback, milliseconds);
        if (milliseconds === 1000) backoffStarted.resolve();
        return timer;
      },
    );
    const server = await fixture(
      t,
      "fail",
      mode === "deadline" ? 200 : 30000,
      3,
    );
    const controller = new AbortController();
    const sending = server.runtime.transport.send(message(), {
      signal: controller.signal,
    });
    let settled = false;
    const result =
      mode === "deadline"
        ? sending
        : assert.rejects(
            sending,
            mode === "cancel"
              ? (error) => error === "cancelled"
              : /Resend transport is closed/u,
          );
    // oxlint-disable-next-line promise/prefer-await-to-then
    const observed = result.then((value) => {
      settled = true;
      return value;
    });
    await backoffStarted.promise;
    let closing: Promise<void> | undefined;
    if (mode === "deadline") t.mock.timers.tick(200);
    else if (mode === "cancel") controller.abort("cancelled");
    else closing = server.runtime.close();
    await yieldToEventLoop();
    const settledBeforeBackoff = settled;
    // Drain a regressed uncancellable timer before reporting the assertion.
    t.mock.timers.tick(1000);
    await observed;
    await closing;
    if (mode === "deadline") {
      const receipt = await sending;
      assert.equal(receipt.successful, false);
      assert.equal(receipt.successful ? undefined : receipt.retryable, false);
    }
    assert.equal(settledBeforeBackoff, true);
    assert.equal(server.requests.length, 1);
    t.mock.restoreAll();
    t.mock.timers.reset();
  });
}
