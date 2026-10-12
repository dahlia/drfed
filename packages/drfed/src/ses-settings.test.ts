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
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  defaults = true,
) {
  const bindings = createConfigurationBindings({ env: (name) => env[name] });
  return await run(createMailParser(bindings), {
    args: [
      ...(defaults
        ? [
            "--mail-transport",
            "ses",
            "--ses-access-key-id",
            "ACCESS",
            "--ses-secret-access-key",
            "SECRET",
          ]
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

it("selects SES credentials and ignores unrelated providers", async () => {
  const raw = await parsed([], {
    DRFED_MAIL_API_KEY_FILE: "PRIVATE_MISSING",
    DRFED_SMTP_PORT: "INVALID",
  });
  const selected = resolveMailSettings(raw);
  assert.equal(selected.mail.transport, "ses");
  if (selected.mail.transport !== "ses") throw new Error();
  assert.equal(selected.mail.connection.region, "us-east-1");
  assert.equal(selected.mail.connection.retries, 0);
  assert.equal(selected.mail.authentication.type, "credentials");
  assert.equal(
    selected.diagnostic["mail.ses.access_key_id"]?.value,
    "<redacted>",
  );
  assert.equal(
    selected.diagnostic["mail.ses.secret_access_key"]?.value,
    "<redacted>",
  );
  assert.doesNotMatch(
    JSON.stringify(selected.diagnostic),
    /ACCESS|SECRET|PRIVATE_MISSING/u,
  );
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        sesSecretAccessKeyFile: { value: "MISSING", source: "cli" },
      }),
    /Conflicting/u,
  );
  const inactive = resolveMailSettings(
    await parsed(
      ["--mail-transport", "logtape"],
      {
        DRFED_SES_AUTH: "INVALID",
        DRFED_SES_TIMEOUT: "INVALID",
        DRFED_SES_SECRET_ACCESS_KEY_FILE: "MISSING",
      },
      false,
    ),
  );
  assert.equal(inactive.mail.transport, "logtape");
});

it("selects SES session mode by source and leaves unused tokens unopened", async () => {
  const raw = await parsed();
  const session = resolveMailSettings({
    ...raw,
    sesAuth: { value: "credentials", source: "config" },
    sesSessionToken: { value: "SESSION", source: "env" },
  });
  assert.equal(session.mail.transport, "ses");
  if (session.mail.transport !== "ses") throw new Error();
  assert.equal(session.mail.authentication.type, "session");
  const standard = resolveMailSettings({
    ...raw,
    sesAuth: { value: "credentials", source: "cli" },
    sesSessionTokenFile: { value: "PRIVATE_MISSING", source: "env" },
  });
  assert.equal((await prepareMail(standard.mail)).transport, "ses");
  assert.ok(
    standard.ignored.some(
      (item) => item.field === "mail.ses.session_token_file",
    ),
  );
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        sesAuth: { value: "session", source: "cli" },
      }),
    /SES requires a session token/u,
  );
});

it("validates SES region, timeout and credential envelopes", async () => {
  const raw = await parsed();
  for (const value of [
    "",
    "cn-north-1",
    "us-iso-east-1",
    "eu-isoe-west-1",
    "eu-west-1.evil",
    "us-east-1/path",
    "https://example.com",
    "us-east-1%00",
  ]) {
    assert.throws(
      () =>
        resolveMailSettings({ ...raw, sesRegion: { value, source: "cli" } }),
      /SES region/u,
    );
  }
  for (const value of ["0", "-1", "1.5", "2147483648", "INVALID"]) {
    assert.throws(
      () =>
        resolveMailSettings({ ...raw, sesTimeout: { value, source: "env" } }),
      /SES delivery timeout/u,
    );
  }
  for (const value of ["", "HAS SPACE", "LINE\nBREAK", "雪"]) {
    assert.throws(
      () =>
        resolveMailSettings({
          ...raw,
          sesSecretAccessKey: { value, source: "cli" },
        }),
      /Invalid SES secret access key/u,
    );
  }
  const valid = resolveMailSettings({
    ...raw,
    sesRegion: { value: "us-gov-west-1", source: "cli" },
  });
  assert.equal(valid.mail.transport, "ses");
});

it("prepares only winning SES secret files before construction", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "drfed-ses-secrets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, "key");
  await writeFile(key, "SECRET\r\n");
  const raw = await parsed([], {}, false);
  const selected = resolveMailSettings(
    {
      ...raw,
      mailTransport: { value: "ses", source: "cli" },
      sesAccessKeyId: { value: "ACCESS", source: "cli" },
      sesSecretAccessKey: { value: "LOWER", source: "config" },
      sesSecretAccessKeyFile: { value: key, source: "cli" },
    },
    directory,
  );
  const prepared = await prepareMail(selected.mail);
  assert.equal(prepared.transport, "ses");
  if (prepared.transport !== "ses") throw new Error();
  assert.equal(prepared.connection.authentication.secretAccessKey, "SECRET");
  await writeFile(key, "SECRET ");
  await assert.rejects(
    prepareMail(selected.mail),
    /Invalid SES secret access key/u,
  );
});

interface Sent {
  readonly url: string;
  readonly headers: Headers;
  readonly body: string;
}
async function fixture(
  t: TestContext,
  mode: "success" | "fail" | "stall",
  timeout = 30000,
  session = false,
) {
  const arrivals = Promise.withResolvers<void>();
  const requests: Sent[] = [];
  const server = createServer((request, response) => {
    request.resume();
    response.writeHead(mode === "fail" ? 503 : 200, {
      "Content-Type": "application/json",
    });
    if (mode === "stall") {
      response.flushHeaders();
      arrivals.resolve();
      return;
    }
    response.end(
      JSON.stringify(
        mode === "fail"
          ? { message: "PRIVATE_PROVIDER_ERROR" }
          : { MessageId: "fixture" },
      ),
    );
    arrivals.resolve();
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
  const nativeFetch = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      assert.equal(
        url,
        "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails",
      );
      requests.push({
        url,
        headers: new Headers(init?.headers),
        body: String(init?.body),
      });
      return await nativeFetch(
        `http://127.0.0.1:${address.port}/v2/email/outbound-emails`,
        init,
      );
    },
  );
  const selected = resolveMailSettings(
    await parsed([
      "--ses-region",
      "eu-west-1",
      "--ses-timeout",
      String(timeout),
      ...(session
        ? ["--ses-auth", "session", "--ses-session-token", "SESSION"]
        : []),
    ]),
  );
  const runtime = createMailRuntime(await prepareMail(selected.mail));
  t.after(() => runtime.close());
  return { runtime, requests, started: arrivals.promise };
}

function verifySignature(sent: Sent, session: boolean) {
  const date = sent.headers.get("X-Amz-Date");
  assert.ok(date);
  assert.match(date, /^\d{8}T\d{6}Z$/u);
  const signed = `host;x-amz-date${session ? ";x-amz-security-token" : ""}`;
  const canonicalHeaders = `host:email.eu-west-1.amazonaws.com\nx-amz-date:${date}\n${
    session ? "x-amz-security-token:SESSION\n" : ""
  }`;
  const hash = (value: string) =>
    createHash("sha256").update(value).digest("hex");
  const canonical = `POST\n/v2/email/outbound-emails\n\n${canonicalHeaders}\n${signed}\n${hash(sent.body)}`;
  const scope = `${date.slice(0, 8)}/eu-west-1/ses/aws4_request`;
  const data = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${hash(canonical)}`;
  const hmac = (key: string | Buffer, value: string) =>
    createHmac("sha256", key).update(value).digest();
  const key = hmac(
    hmac(hmac(hmac("AWS4SECRET", date.slice(0, 8)), "eu-west-1"), "ses"),
    "aws4_request",
  );
  const signature = createHmac("sha256", key).update(data).digest("hex");
  assert.equal(
    sent.headers.get("Authorization"),
    `AWS4-HMAC-SHA256 Credential=ACCESS/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  );
  assert.equal(
    sent.headers.get("X-Amz-Security-Token"),
    session ? "SESSION" : null,
  );
}
for (const session of [false, true]) {
  it(`signs SES ${session ? "session" : "standard"} requests with SigV4`, async (t) => {
    const sdk = await fixture(t, "success", 30000, session);
    const receipt = await sdk.runtime.transport.send(message());
    assert.equal(receipt.successful, true);
    assert.equal(sdk.requests.length, 1);
    const sent = sdk.requests[0];
    assert.ok(sent);
    verifySignature(sent, session);
    const body = JSON.parse(sent.body);
    assert.equal(body.FromEmailAddress, "sender@example.com");
    assert.deepEqual(body.Destination.ToAddresses, ["recipient@example.com"]);
    assert.equal(body.Content.Simple.Subject.Data, "Fixture");
    assert.equal(body.Content.Simple.Body.Text.Data, "PRIVATE_LOGIN_CODE");
  });
}
it("does not replay uncertain SES submissions", async (t) => {
  const sdk = await fixture(t, "fail");
  assert.equal((await sdk.runtime.transport.send(message())).successful, false);
  assert.equal(sdk.requests.length, 1);
});
it(
  "bounds SES body reads and preserves cancellation and shutdown",
  { timeout: 15000 },
  async (t) => {
    const originalFetch = globalThis.fetch;
    const reading = Promise.withResolvers<void>();
    t.mock.method(
      globalThis,
      "fetch",
      async (...args: Parameters<typeof fetch>) => {
        const response = await originalFetch(...args);
        const originalRead = response.text.bind(response);
        t.mock.method(response, "text", () => {
          const result = originalRead();
          reading.resolve();
          return result;
        });
        return response;
      },
    );
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const sdk = await fixture(t, "stall", 100);
    const sending = sdk.runtime.transport.send(message());
    await reading.promise;
    t.mock.timers.tick(100);
    assert.equal((await sending).successful, false);
    t.mock.timers.reset();
    t.mock.restoreAll();
  },
);
for (const mode of ["cancel", "close"] as const) {
  it(`drains SES ${mode} cancellation`, { timeout: 15000 }, async (t) => {
    const sdk = await fixture(t, "stall");
    const controller = new AbortController();
    const sending = sdk.runtime.transport.send(message(), {
      signal: controller.signal,
    });
    const rejected = assert.rejects(
      sending,
      mode === "cancel"
        ? (error) => error === "cancelled"
        : /SES transport is closed/u,
    );
    await sdk.started;
    if (mode === "cancel") controller.abort("cancelled");
    else {
      const first = sdk.runtime.close();
      assert.equal(first, sdk.runtime.close());
      await first;
    }
    await rejected;
    await sdk.runtime.close();
    await assert.rejects(sdk.runtime.transport.send(message()), /closed/u);
  });
}
