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

it("selects JMAP by session URL and ignores inactive provider meaning", async () => {
  const resolved = resolveMailSettings(
    await parsed(
      [
        "--jmap-session-url",
        "https://mail.example/jmap",
        "--jmap-bearer-token",
        "TOKEN",
      ],
      {
        DRFED_SMTP_PORT: "INVALID",
        DRFED_SMTP_PASSWORD_FILE: "MISSING",
        DRFED_MAIL_LOG_CONTENT: "INVALID",
      },
    ),
  );
  assert.equal(resolved.mail.transport, "jmap");
  assert.equal(
    resolved.diagnostic["mail.jmap.bearer_token"]?.value,
    "<redacted>",
  );
  assert.equal(resolved.diagnostic["mail.jmap.timeout_ms"]?.value, 30000);
  assert.ok(
    resolved.ignored.some((item) => item.field === "mail.smtp.password_file"),
  );
  assert.doesNotMatch(JSON.stringify(resolved.diagnostic), /TOKEN|MISSING/u);
  assert.ok(!("mail.smtp.password_file" in resolved.diagnostic));
  const inactive = resolveMailSettings(
    await parsed(["--mail-transport", "logtape"], {
      DRFED_JMAP_SESSION_URL: "INVALID",
      DRFED_JMAP_BEARER_TOKEN_FILE: "MISSING",
    }),
  );
  assert.equal(inactive.mail.transport, "logtape");
  assert.ok(
    inactive.ignored.some(
      (item) => item.field === "mail.jmap.bearer_token_file",
    ),
  );
});

it("resolves authentication variants before opening only the selected credential", async () => {
  const raw = await parsed(["--jmap-bearer-token", "TOKEN"], {
    DRFED_JMAP_SESSION_URL: "https://mail.example/jmap",
    DRFED_JMAP_USER: "user",
    DRFED_JMAP_PASSWORD_FILE: "MISSING",
  });
  const prepared = await prepareMail(resolveMailSettings(raw).mail);
  assert.equal(prepared.transport, "jmap");
  if (prepared.transport !== "jmap") throw new Error();
  assert.equal(prepared.connection.bearerToken, "TOKEN");
  assert.equal(prepared.connection.basicAuth, undefined);
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        jmapPassword: { value: "PASSWORD", source: "cli" },
      }),
    /variants/u,
  );
  const missing = resolveMailSettings({
    ...raw,
    jmapBearerToken: undefined,
    jmapBearerTokenFile: { value: "PRIVATE_MISSING_FILE", source: "cli" },
  });
  await assert.rejects(
    prepareMail(missing.mail),
    (error) =>
      error instanceof Error && !error.message.includes("PRIVATE_MISSING_FILE"),
  );
});

it("rejects unsafe endpoints and invalid numeric limits without leaking input", async () => {
  const raw = await parsed([
    "--jmap-session-url",
    "https://mail.example/jmap",
    "--jmap-bearer-token",
    "TOKEN",
  ]);
  for (const value of [
    "http://mail.example/jmap",
    "https://SECRET@mail.example/jmap",
    "https://mail.example/jmap#fragment",
  ]) {
    assert.throws(
      () =>
        resolveMailSettings({
          ...raw,
          jmapSessionUrl: { value, source: "cli" },
        }),
      /Invalid JMAP session URL/u,
    );
  }
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        jmapTimeout: { value: "0", source: "cli" },
      }),
    /Invalid JMAP timeout/u,
  );
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        jmapBaseUrl: { value: "https://mail.example/path", source: "cli" },
      }),
    /Invalid JMAP base URL/u,
  );
});

type Call = [
  string,
  { accountId: string; create?: Record<string, unknown> },
  string,
];
async function fixture(
  t: TestContext,
  mode: "normal" | "reject" | "stall" | "submission-error" = "normal",
) {
  const requests: { authorization: string | undefined; calls: Call[] }[] = [];
  const started = Promise.withResolvers<void>();
  let origin = "";
  const server = createServer((request, response) => {
    void (async () => {
      try {
        response.setHeader("Content-Type", "application/json");
        if (mode === "stall") {
          response.writeHead(200);
          response.flushHeaders();
          started.resolve();
          return;
        }
        if (mode === "reject") {
          response.writeHead(401);
          response.end("PRIVATE_PROVIDER_ERROR");
          return;
        }
        if (request.method === "GET") {
          requests.push({
            authorization: request.headers.authorization,
            calls: [],
          });
          response.end(
            JSON.stringify({
              capabilities: {
                "urn:ietf:params:jmap:core": {},
                "urn:ietf:params:jmap:mail": {},
                "urn:ietf:params:jmap:submission": {},
              },
              accounts: {
                auto: {
                  accountCapabilities: { "urn:ietf:params:jmap:mail": {} },
                  isReadOnly: false,
                },
              },
              primaryAccounts: { "urn:ietf:params:jmap:mail": "auto" },
              username: "operator",
              apiUrl: `${origin}/api`,
              downloadUrl: `${origin}/download`,
              uploadUrl: `${origin}/upload`,
              state: "one",
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          methodCalls: Call[];
        };
        requests.push({
          authorization: request.headers.authorization,
          calls: body.methodCalls,
        });
        if (
          mode === "submission-error" &&
          body.methodCalls.some((call) => call[0] === "EmailSubmission/set")
        ) {
          response.writeHead(503);
          response.end("Uncertain submission outcome");
          return;
        }
        const methodResponses = body.methodCalls.map(([name, args, id]) => [
          name,
          {
            accountId: args.accountId,
            ...(name === "Mailbox/get"
              ? { list: [{ id: "drafts", role: "drafts" }] }
              : name === "Identity/get"
                ? {
                    list: [
                      { id: "auto-identity", email: "sender@example.com" },
                    ],
                  }
                : {
                    created: {
                      [name === "Email/set" ? "draft" : "submission"]: {
                        id: "sent",
                      },
                    },
                  }),
          },
          id,
        ]);
        response.end(JSON.stringify({ methodResponses, sessionState: "one" }));
      } catch (error) {
        response.destroy(error as Error);
      }
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error();
  origin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
  return { origin, requests, started: started.promise };
}
const message = () =>
  createMessage({
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "Fixture",
    content: { text: "PRIVATE_LOGIN_CODE" },
  });

it("delivers through JMAP bearer discovery and honors automatic account/identity", async (t) => {
  const service = await fixture(t);
  const settings = resolveMailSettings(
    await parsed([
      "--jmap-session-url",
      `${service.origin}/session`,
      "--jmap-bearer-token",
      "TOKEN",
    ]),
  );
  const runtime = createMailRuntime(await prepareMail(settings.mail));
  t.after(() => runtime.close());
  const receipt = await runtime.transport.send(message());
  assert.equal(receipt.successful, true);
  assert.ok(
    service.requests.every(
      (request) => request.authorization === "Bearer TOKEN",
    ),
  );
  const submission = service.requests
    .flatMap((request) => request.calls)
    .find((call) => call[0] === "EmailSubmission/set");
  assert.equal(submission?.[1].accountId, "auto");
  assert.deepEqual(submission?.[1].create, {
    submission: { identityId: "auto-identity", emailId: "#draft" },
  });
  assert.equal(runtime.close(), runtime.close());
  await runtime.close();
});

it("delivers basic authentication with explicit account and identity IDs", async (t) => {
  const service = await fixture(t);
  const settings = resolveMailSettings(
    await parsed([
      "--jmap-session-url",
      `${service.origin}/session`,
      "--jmap-user",
      "operator",
      "--jmap-password",
      "password",
      "--jmap-account-id",
      "selected",
      "--jmap-identity-id",
      "identity",
    ]),
  );
  const runtime = createMailRuntime(await prepareMail(settings.mail));
  t.after(() => runtime.close());
  assert.equal((await runtime.transport.send(message())).successful, true);
  assert.ok(
    service.requests.every(
      (request) =>
        request.authorization ===
        `Basic ${Buffer.from("operator:password").toString("base64")}`,
    ),
  );
  const calls = service.requests.flatMap((request) => request.calls);
  assert.ok(calls.every((call) => call[1].accountId === "selected"));
  assert.ok(!calls.some((call) => call[0] === "Identity/get"));
  assert.deepEqual(
    calls.find((call) => call[0] === "EmailSubmission/set")?.[1].create,
    { submission: { identityId: "identity", emailId: "#draft" } },
  );
});

it("returns a failed receipt for a rejected JMAP session", async (t) => {
  const service = await fixture(t, "reject");
  const runtime = createMailRuntime(
    await prepareMail(
      resolveMailSettings(
        await parsed([
          "--jmap-session-url",
          `${service.origin}/session`,
          "--jmap-bearer-token",
          "TOKEN",
        ]),
      ).mail,
    ),
  );
  t.after(() => runtime.close());
  assert.equal((await runtime.transport.send(message())).successful, false);
});

it("cancels a stalled JMAP response body and permits owned shutdown", async (t) => {
  const service = await fixture(t, "stall");
  const runtime = createMailRuntime(
    await prepareMail(
      resolveMailSettings(
        await parsed([
          "--jmap-session-url",
          `${service.origin}/session`,
          "--jmap-bearer-token",
          "TOKEN",
        ]),
      ).mail,
    ),
  );
  t.after(() => runtime.close());
  const controller = new AbortController();
  const pending = runtime.transport.send(message(), {
    signal: controller.signal,
  });
  await service.started;
  controller.abort(new Error("Cancelled fixture"));
  await assert.rejects(pending, /Cancelled fixture/u);
  await runtime.close();
});

it("keeps foreign JMAP secrets out of SMTP diagnostics", async () => {
  const resolved = resolveMailSettings(
    await parsed(["--smtp-host", "localhost"], {
      DRFED_JMAP_BEARER_TOKEN: "FOREIGN_TOKEN",
      DRFED_JMAP_PASSWORD_FILE: "MISSING",
    }),
  );
  assert.equal(resolved.mail.transport, "smtp");
  assert.ok(!("mail.jmap.bearer_token" in resolved.diagnostic));
  assert.ok(!("mail.jmap.password_file" in resolved.diagnostic));
  assert.ok(
    resolved.ignored.some((item) => item.field === "mail.jmap.bearer_token"),
  );
});

it("does not replay a mail submission after a transient failure", async (t) => {
  const service = await fixture(t, "submission-error");
  const runtime = createMailRuntime(
    await prepareMail(
      resolveMailSettings(
        await parsed([
          "--jmap-session-url",
          `${service.origin}/session`,
          "--jmap-bearer-token",
          "TOKEN",
        ]),
      ).mail,
    ),
  );
  t.after(() => runtime.close());
  assert.equal((await runtime.transport.send(message())).successful, false);
  assert.equal(
    service.requests
      .flatMap((request) => request.calls)
      .filter((call) => call[0] === "EmailSubmission/set").length,
    1,
  );
});

it(
  "enforces the whole delivery timeout through stalled response bodies",
  { timeout: 2000 },
  async (t) => {
    const service = await fixture(t, "stall");
    const runtime = createMailRuntime(
      await prepareMail(
        resolveMailSettings(
          await parsed([
            "--jmap-session-url",
            `${service.origin}/session`,
            "--jmap-bearer-token",
            "TOKEN",
            "--jmap-timeout",
            "100",
          ]),
        ).mail,
      ),
    );
    t.after(() => runtime.close());
    const receipt = await runtime.transport.send(message());
    assert.equal(receipt.successful, false);
    if (receipt.successful) throw new Error();
    assert.equal(receipt.errors?.[0]?.category, "timeout");
    assert.equal(receipt.retryable, false);
    await runtime.close();
  },
);

it("closes and drains an active JMAP send and rejects later sends", async (t) => {
  const service = await fixture(t, "stall");
  const runtime = createMailRuntime(
    await prepareMail(
      resolveMailSettings(
        await parsed([
          "--jmap-session-url",
          `${service.origin}/session`,
          "--jmap-bearer-token",
          "TOKEN",
        ]),
      ).mail,
    ),
  );
  t.after(() => runtime.close());
  const pending = runtime.transport.send(message());
  const failed = assert.rejects(pending, /JMAP transport is closed/u);
  await service.started;
  assert.equal(runtime.close(), runtime.close());
  await runtime.close();
  await failed;
  await assert.rejects(
    runtime.transport.send(message()),
    /JMAP transport is closed/u,
  );
});
