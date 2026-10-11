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

import { createBoundedTransport } from "@drfed/drfed/bounded-mail-runtime";
import { createConfigurationBindings } from "@drfed/drfed/configuration";
import { createMailParser } from "@drfed/drfed/mail-parser";
import { createMailRuntime, prepareMail } from "@drfed/drfed/mail-runtime";
import { resolveMailSettings } from "@drfed/drfed/mail-settings";
import { run } from "@optique/run";
import { type Transport, createMessage } from "@upyo/core";

async function parsed(
  args: readonly string[] = [],
  env: Record<string, string> = {},
) {
  const bindings = createConfigurationBindings({ env: (name) => env[name] });
  return await run(createMailParser(bindings), {
    args,
    contexts: bindings.contexts,
    contextOptions: { load: () => undefined },
    colors: false,
    stderr: () => undefined,
    onExit(code): never {
      throw new Error(`CLI exit ${code}`);
    },
  });
}
const selected = (extra: readonly string[] = []) => [
  "--mail-transport",
  "lettermint",
  "--mail-api-key",
  "TOKEN",
  ...extra,
];
const message = () =>
  createMessage({
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "Fixture",
    content: { text: "PRIVATE_LOGIN_CODE" },
  });

it("resolves shared API credentials and validates only the selected transport", async () => {
  const raw = await parsed(selected(), {
    DRFED_LETTERMINT_API_TOKEN_FILE: "PRIVATE_MISSING",
    DRFED_SMTP_PORT: "INVALID",
    DRFED_JMAP_SESSION_URL: "INVALID",
    DRFED_MAIL_LOG_CONTENT: "INVALID",
  });
  const settings = resolveMailSettings(raw);
  assert.equal(settings.mail.transport, "lettermint");
  assert.equal(settings.diagnostic["mail.api_key"]?.value, "<redacted>");
  assert.ok(!("mail.lettermint.api_token_file" in settings.diagnostic));
  assert.ok(
    settings.ignored.some(
      (item) => item.field === "mail.lettermint.api_token_file",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(settings.diagnostic),
    /TOKEN|PRIVATE_MISSING/u,
  );
  assert.equal((await prepareMail(settings.mail)).transport, "lettermint");
  const inactive = resolveMailSettings(
    await parsed(["--mail-transport", "logtape"], {
      DRFED_MAIL_API_KEY_FILE: "MISSING",
      DRFED_LETTERMINT_BASE_URL: "INVALID",
    }),
  );
  assert.equal(inactive.mail.transport, "logtape");
  assert.ok(
    inactive.ignored.some((item) => item.field === "mail.api_key_file"),
  );
});

it("rejects same-source API credential representations but discards lower conflicts", async () => {
  const raw = await parsed(selected());
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        lettermintApiTokenFile: { value: "MISSING", source: "cli" },
      }),
    /Conflicting mail API credential/u,
  );
  const corrected = resolveMailSettings(
    {
      ...raw,
      mailApiKey: { value: "lower", source: "env" },
      lettermintApiToken: { value: "other", source: "env" },
      mailApiKeyFile: { value: "selected", source: "cli" },
    },
    "/work",
  );
  assert.equal(corrected.mail.transport, "lettermint");
  if (corrected.mail.transport !== "lettermint") throw new Error();
  assert.deepEqual(corrected.mail.credential, {
    type: "file",
    path: "/work/selected",
  });
  await assert.rejects(
    prepareMail(corrected.mail),
    (error) =>
      error instanceof Error && !error.message.includes("/work/selected"),
  );
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        mailApiKey: { value: "PRIVATE\nTOKEN", source: "cli" },
      }),
    /Invalid mail API credential/u,
  );
});

it("rejects invalid Lettermint endpoints, route values and resource limits", async () => {
  const raw = await parsed(selected());
  for (const value of [
    "http://external.example",
    "https://SECRET@mail.example",
    "https://mail.example/path",
    "https://mail.example?query",
  ]) {
    assert.throws(
      () =>
        resolveMailSettings({
          ...raw,
          lettermintBaseUrl: { value, source: "cli" },
        }),
      /Invalid Lettermint base origin/u,
    );
  }
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        lettermintRetries: { value: "11", source: "cli" },
      }),
    /Invalid Lettermint retries/u,
  );
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        lettermintTimeout: { value: "0", source: "cli" },
      }),
    /Invalid Lettermint delivery timeout/u,
  );
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        lettermintRoute: { value: "", source: "cli" },
      }),
    /Invalid Lettermint route/u,
  );
});

async function fixture(
  t: TestContext,
  mode: "success" | "reject" | "retry" | "stall" = "success",
) {
  const requests: {
    path: string | undefined;
    token: string | string[] | undefined;
    key: string | string[] | undefined;
    body: Record<string, unknown>;
  }[] = [];
  const arrivals = new Map<
    number,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  function waitForRequest(count: number) {
    if (requests.length >= count) return Promise.resolve();
    const arrived = Promise.withResolvers<void>();
    arrivals.set(count, arrived);
    return arrived.promise;
  }
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requests.push({
          path: request.url,
          token: request.headers["x-lettermint-token"],
          key: request.headers["idempotency-key"],
          body: JSON.parse(Buffer.concat(chunks).toString()) as Record<
            string,
            unknown
          >,
        });
        response.setHeader("Content-Type", "application/json");
        if (mode === "stall") {
          response.writeHead(200);
          response.flushHeaders();
          arrivals.get(requests.length)?.resolve();
          return;
        }
        if (mode === "reject" || (mode === "retry" && requests.length === 1)) {
          response.writeHead(mode === "reject" ? 401 : 503);
          response.end(JSON.stringify({ message: "PRIVATE_PROVIDER_ERROR" }));
          return;
        }
        response.end(
          JSON.stringify({ message_id: "fixture", status: "pending" }),
        );
      } catch (error) {
        response.destroy(error as Error);
      }
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error();
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    waitForRequest,
  };
}
async function runtime(
  t: TestContext,
  origin: string,
  extra: readonly string[] = [],
) {
  const value = createMailRuntime(
    await prepareMail(
      resolveMailSettings(
        await parsed(selected(["--lettermint-base-url", origin, ...extra])),
      ).mail,
    ),
  );
  t.after(() => value.close());
  return value;
}

it("delivers Lettermint API authentication, route and a generated idempotency key", async (t) => {
  const service = await fixture(t);
  const mail = await runtime(t, service.origin, [
    "--lettermint-route",
    "transactional",
    "--lettermint-retries",
    "0",
  ]);
  const receipt = await mail.transport.send(message());
  assert.equal(receipt.successful, true);
  const request = service.requests[0]!;
  assert.equal(request.path, "/v1/send");
  assert.equal(request.token, "TOKEN");
  assert.equal(request.body.route, "transactional");
  assert.equal(request.body.subject, "Fixture");
  assert.equal(typeof request.key, "string");
  if (typeof request.key !== "string") throw new Error();
  assert.ok(request.key.length > 0);
});

it(
  "retries transient Lettermint failures with the same idempotency key",
  { timeout: 5000 },
  async (t) => {
    const service = await fixture(t, "retry");
    const mail = await runtime(t, service.origin, [
      "--lettermint-retries",
      "1",
    ]);
    assert.equal((await mail.transport.send(message())).successful, true);
    assert.equal(service.requests.length, 2);
    assert.equal(service.requests[0]?.key, service.requests[1]?.key);
  },
);

it("returns a failed receipt without retrying permanent Lettermint rejection", async (t) => {
  const service = await fixture(t, "reject");
  const mail = await runtime(t, service.origin, ["--lettermint-retries", "2"]);
  assert.equal((await mail.transport.send(message())).successful, false);
  assert.equal(service.requests.length, 1);
});

it(
  "bounds Lettermint response bodies and drains cancellation and cleanup",
  { timeout: 3000 },
  async (t) => {
    const service = await fixture(t, "stall");
    const mail = await runtime(t, service.origin, [
      "--lettermint-timeout",
      "100",
      "--lettermint-retries",
      "0",
    ]);
    const receipt = await mail.transport.send(message());
    assert.equal(receipt.successful, false);
    if (receipt.successful) throw new Error();
    assert.equal(receipt.errors?.[0]?.category, "timeout");
    assert.equal(receipt.retryable, false);
    const caller = new AbortController();
    const pending = mail.transport.send(message(), { signal: caller.signal });
    await service.waitForRequest(2);
    caller.abort(new Error("Caller cancelled"));
    await assert.rejects(pending, /Caller cancelled/u);
    const active = mail.transport.send(message());
    const failed = assert.rejects(active, /Lettermint transport is closed/u);
    await service.waitForRequest(3);
    assert.equal(mail.close(), mail.close());
    await mail.close();
    await failed;
    await assert.rejects(
      mail.transport.send(message()),
      /Lettermint transport is closed/u,
    );
  },
);

it("disposes the underlying owned transport once and masks cleanup errors", async () => {
  let disposed = 0;
  const sdk: Transport<"fake"> & AsyncDisposable = {
    id: "fake",
    send() {
      return Promise.resolve({
        successful: true,
        messageId: "one",
        provider: "fake",
      });
    },
    async *sendMany() {
      yield { successful: true, messageId: "one", provider: "fake" };
    },
    [Symbol.asyncDispose]() {
      disposed += 1;
      return Promise.reject(new Error("PRIVATE_TOKEN"));
    },
  };
  const mail = createBoundedTransport(sdk, 1000, "Fixture");
  const first = mail[Symbol.asyncDispose]();
  assert.equal(first, mail[Symbol.asyncDispose]());
  await assert.rejects(
    async () => await first,
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Mail transport cleanup failed.",
  );
  assert.equal(disposed, 1);
});

it("preserves non-Error caller cancellation when the SDK resolves a failed receipt", async (t) => {
  const service = await fixture(t, "stall");
  const mail = await runtime(t, service.origin, ["--lettermint-retries", "0"]);
  const caller = new AbortController();
  const pending = mail.transport.send(message(), { signal: caller.signal });
  const rejected = assert.rejects(pending, (reason) => reason === "cancelled");
  await service.waitForRequest(1);
  caller.abort("cancelled");
  await rejected;
  await mail.close();
});
