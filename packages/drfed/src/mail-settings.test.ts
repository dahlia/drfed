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
import { resolve } from "node:path";
import { it } from "node:test";

import { createConfigurationBindings } from "@drfed/drfed/configuration";
import { createMailParser } from "@drfed/drfed/mail-parser";
import { prepareMail } from "@drfed/drfed/mail-runtime";
import { resolveMailSettings } from "@drfed/drfed/mail-settings";
import { suggest } from "@optique/core/parser";
import { run } from "@optique/run";

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

it("defaults to log-only without logging message contents", async () => {
  const settings = resolveMailSettings(await parsed());
  assert.deepEqual(settings.mail, { transport: "logtape", logContent: false });
  assert.equal(settings.diagnostic["mail.log_content"]?.value, false);
  assert.deepEqual(
    resolveMailSettings(await parsed(["--mail-log-content"])).mail,
    { transport: "logtape", logContent: true },
  );
});

it("switches providers before validating foreign settings and reading files", async () => {
  const raw = await parsed(
    [
      "--mail-transport",
      "logtape",
      "--smtp-tls=invalid",
      "--smtp-auth-method=invalid",
      "--ses-auth=invalid",
      "--mailgun-region=invalid",
    ],
    {
      DRFED_SMTP_URL: "invalid SECRET",
      DRFED_SMTP_PASSWORD_FILE: "PRIVATE_MISSING",
      DRFED_SMTP_PORT: "invalid",
    },
  );
  const resolved = resolveMailSettings(raw);
  assert.equal(resolved.mail.transport, "logtape");
  assert.ok(
    resolved.ignored.some((item) => item.field === "mail.smtp.password_file"),
  );
  assert.doesNotMatch(
    JSON.stringify(resolved.diagnostic),
    /SECRET|PRIVATE_MISSING/u,
  );
  await prepareMail(resolved.mail);
  assert.throws(
    () =>
      resolveMailSettings({
        ...raw,
        smtpUrl: { source: "cli", value: "smtp://localhost" },
      }),
    /same source/u,
  );
});

it("suggests static mail choices through configuration bindings without reading environment settings", () => {
  const parser = createMailParser(
    createConfigurationBindings({
      env: () => {
        throw new Error("Completion must not read environment settings.");
      },
    }),
  );
  const cases: readonly [string, readonly string[]][] = [
    [
      "--mail-transport",
      [
        "logtape",
        "smtp",
        "jmap",
        "lettermint",
        "maileroo",
        "mailtrap",
        "mailgun",
        "plunk",
        "resend",
        "sendgrid",
        "ses",
      ],
    ],
    ["--smtp-tls", ["direct", "starttls-required", "opportunistic"]],
    ["--smtp-auth-method", ["plain", "login", "xoauth2", "oauthbearer"]],
    ["--ses-auth", ["credentials", "session"]],
    ["--mailgun-region", ["us", "eu"]],
  ];
  for (const [option, expected] of cases) {
    const values = Array.from(suggest(parser, [option, ""]))
      .filter((item) => item.kind === "literal")
      .map((item) => item.text);
    assert.deepEqual(values, expected, option);
  }
  assert.deepEqual(
    Array.from(suggest(parser, ["--mail-transport", "re"]))
      .filter((item) => item.kind === "literal")
      .map((item) => item.text),
    ["resend"],
  );
});

it("inherits SMTP URL host and replaces lower credentials without decoding them", async () => {
  const raw = await parsed(["--smtp-password-file", "selected-secret"], {
    DRFED_SMTP_URL: "smtp://operator:INVALID%ZZ@localhost:2525",
  });
  const resolved = resolveMailSettings(raw, "/work");
  assert.equal(resolved.mail.transport, "smtp");
  if (resolved.mail.transport !== "smtp") throw new Error();
  assert.equal(resolved.mail.connection.host, "localhost");
  assert.equal(resolved.mail.connection.port, 2525);
  assert.equal(resolved.mail.connection.requireTls, true);
  assert.deepEqual(resolved.mail.authentication?.secret, {
    type: "file",
    path: resolve("/work/selected-secret"),
  });
  assert.deepEqual(resolved.diagnostic["mail.smtp.password_file"], {
    value: "<redacted>",
    source: "cli",
  });
  assert.equal(resolved.diagnostic["mail.smtp.password"], undefined);
  assert.doesNotMatch(
    JSON.stringify(resolved.diagnostic),
    /INVALID|selected-secret/u,
  );
});

it("rejects same-source URL component duplicates and literal/file conflicts", async () => {
  for (const args of [
    ["--smtp-url", "smtp://localhost", "--smtp-host", "localhost"],
    [
      "--smtp-url",
      "smtp://operator:SECRET@localhost",
      "--smtp-password-file",
      "SECRET_FILE",
    ],
    [
      "--smtp-host",
      "localhost",
      "--smtp-user",
      "operator",
      "--smtp-password",
      "SECRET",
      "--smtp-password-file",
      "SECRET_FILE",
    ],
  ]) {
    // oxlint-disable-next-line no-await-in-loop
    const raw = await parsed(args);
    assert.throws(() => resolveMailSettings(raw), /same source|Conflicting/u);
  }
});

it("maps explicit SMTP TLS, authentication and resource limits", async () => {
  const resolved = resolveMailSettings(
    await parsed([
      "--smtp-host",
      "LOCALHOST",
      "--smtp-tls",
      "direct",
      "--smtp-user",
      "operator",
      "--smtp-password",
      "SECRET",
      "--smtp-auth-method",
      "login",
      "--smtp-connection-timeout",
      "1500",
      "--smtp-socket-timeout",
      "2000",
      "--smtp-pool-size",
      "2",
    ]),
  );
  const prepared = await prepareMail(resolved.mail);
  assert.equal(prepared.transport, "smtp");
  if (prepared.transport !== "smtp") throw new Error();
  assert.deepEqual(prepared.connection.auth, {
    user: "operator",
    pass: "SECRET",
    method: "login",
  });
  assert.equal(prepared.connection.host, "localhost");
  assert.equal(prepared.connection.port, 465);
  assert.equal(prepared.connection.secure, true);
  assert.equal(prepared.connection.connectionTimeout, 1500);
  assert.equal(prepared.connection.socketTimeout, 2000);
  assert.equal(prepared.connection.poolSize, 2);
  assert.doesNotMatch(JSON.stringify(resolved.diagnostic), /SECRET/u);
});

it("supports static SMTP OAuth and rejects plaintext authentication policies", async () => {
  const resolved = resolveMailSettings(
    await parsed([
      "--smtp-host",
      "localhost",
      "--smtp-user",
      "operator",
      "--smtp-access-token",
      "TOKEN",
      "--smtp-auth-method",
      "oauthbearer",
    ]),
  );
  const prepared = await prepareMail(resolved.mail);
  assert.equal(prepared.transport, "smtp");
  if (prepared.transport !== "smtp") throw new Error();
  assert.deepEqual(prepared.connection.auth, {
    user: "operator",
    accessToken: "TOKEN",
    method: "oauthbearer",
  });
  assert.equal(prepared.connection.requireTls, true);
  for (const tls of ["opportunistic", "invalid"]) {
    // oxlint-disable-next-line no-await-in-loop
    const raw = await parsed([
      "--smtp-host",
      "localhost",
      "--smtp-user",
      "operator",
      "--smtp-password",
      "SECRET",
      "--smtp-tls",
      tls,
    ]);
    assert.throws(() => resolveMailSettings(raw), /SMTP/u);
  }
});

it("applies TLS authentication policy only to the winning URL component", async () => {
  const resolved = resolveMailSettings(
    await parsed(["--smtp-url", "smtp://user:pass@localhost"], {
      DRFED_SMTP_TLS: "direct",
    }),
  );
  assert.equal(resolved.mail.transport, "smtp");
  if (resolved.mail.transport !== "smtp") throw new Error();
  assert.equal(resolved.mail.connection.requireTls, true);
  assert.equal(resolved.mail.connection.secure, false);
});

it("retains a password-only URL and permits a higher-source username", async () => {
  const missingUser = await parsed(["--smtp-url", "smtp://:pass@localhost"]);
  assert.throws(() => resolveMailSettings(missingUser), /requires a username/u);
  const resolved = resolveMailSettings(
    await parsed(["--smtp-user", "user"], {
      DRFED_SMTP_URL: "smtp://:pass@localhost",
    }),
  );
  const prepared = await prepareMail(resolved.mail);
  assert.equal(prepared.transport, "smtp");
  if (prepared.transport !== "smtp") throw new Error();
  assert.deepEqual(prepared.connection.auth, {
    user: "user",
    pass: "pass",
    method: "plain",
  });
});

it("discards lower password representation conflicts before selecting a file", async () => {
  const resolved = resolveMailSettings(
    await parsed(["--smtp-password-file", "selected"], {
      DRFED_SMTP_URL: "smtp://user:pass@localhost",
      DRFED_SMTP_PASSWORD: "other",
    }),
    "/work",
  );
  assert.equal(resolved.mail.transport, "smtp");
  if (resolved.mail.transport !== "smtp") throw new Error();
  assert.deepEqual(resolved.mail.authentication?.secret, {
    type: "file",
    path: resolve("/work/selected"),
  });
});

it("rejects password methods advertised by types but unsupported by the pinned SDK", async () => {
  const raw = await parsed([
    "--smtp-host",
    "localhost",
    "--smtp-user",
    "user",
    "--smtp-password",
    "pass",
    "--smtp-auth-method",
    "cram-md5",
  ]);
  assert.throws(
    () => resolveMailSettings(raw),
    /Invalid SMTP authentication method/u,
  );
});

it("validates URI components only after applying higher-source overrides", async () => {
  const raw = await parsed(["--smtp-port", "587"], {
    DRFED_SMTP_URL: "smtp://localhost:0",
  });
  const resolved = resolveMailSettings(raw);
  assert.equal(resolved.mail.transport, "smtp");
  if (resolved.mail.transport !== "smtp") throw new Error();
  assert.equal(resolved.mail.connection.port, 587);
  assert.deepEqual(resolved.diagnostic["mail.smtp.port"], {
    value: 587,
    source: "cli",
  });
  const uncorrected = await parsed([], {
    DRFED_SMTP_URL: "smtp://localhost:0",
  });
  assert.throws(
    () => resolveMailSettings(uncorrected),
    /Invalid SMTP host or port/u,
  );
});

it("defers oversized decimal URI port validation until the effective source is selected", async () => {
  const corrected = resolveMailSettings(
    await parsed(["--smtp-port", "587"], {
      DRFED_SMTP_URL: "smtp://user:pass@[::1]:65536",
    }),
  );
  assert.equal(corrected.mail.transport, "smtp");
  if (corrected.mail.transport !== "smtp") throw new Error();
  assert.equal(corrected.mail.connection.host, "::1");
  assert.equal(corrected.mail.connection.port, 587);
  const uncorrected = await parsed([], {
    DRFED_SMTP_URL: "smtp://localhost:65536",
  });
  assert.throws(
    () => resolveMailSettings(uncorrected),
    /Invalid SMTP host or port/u,
  );
});

it("rejects malformed authorities even when a valid final port is present", async () => {
  for (const value of ["smtp://host:25:26", "smtp://user:pass@host:25:26"]) {
    // oxlint-disable-next-line no-await-in-loop
    const raw = await parsed(["--smtp-url", value]);
    assert.throws(
      () => resolveMailSettings(raw),
      /Invalid SMTP connection URL/u,
    );
  }
});

it("uses a username-only URL with separately supplied credentials", async () => {
  const base = await parsed();
  const url = { value: "smtp://operator@localhost", source: "config" as const };
  const password = resolveMailSettings(
    {
      ...base,
      smtpUrl: url,
      smtpPasswordFile: { value: "password", source: "config" },
    },
    "/work",
  );
  assert.equal(password.mail.transport, "smtp");
  if (password.mail.transport !== "smtp") throw new Error();
  assert.deepEqual(password.mail.authentication?.secret, {
    type: "file",
    path: resolve("/work/password"),
  });
  const token = resolveMailSettings(
    {
      ...base,
      smtpUrl: url,
      smtpAccessTokenFile: { value: "token", source: "config" },
    },
    "/work",
  );
  assert.equal(token.mail.transport, "smtp");
  if (token.mail.transport !== "smtp") throw new Error();
  assert.equal(token.mail.authentication?.method, "xoauth2");
  assert.throws(
    () => resolveMailSettings({ ...base, smtpUrl: url }),
    /requires a password or access token/u,
  );
});

it("reports a discarded lower authentication method in diagnostics", async () => {
  const resolved = resolveMailSettings(
    await parsed(["--smtp-url", "smtp://user:pass@localhost"], {
      DRFED_SMTP_AUTH_METHOD: "xoauth2",
    }),
  );
  assert.deepEqual(resolved.diagnostic["mail.smtp.auth_method"], {
    value: "plain",
    source: "default",
  });
  assert.ok(
    resolved.ignored.some(
      (item) => item.field === "mail.smtp.auth_method" && item.source === "env",
    ),
  );
});

it("rejects long malformed SMTP URLs without ambiguous authority splitting", async () => {
  const malformed = await Promise.all(
    ["/\nx", "?query", "#fragment", "/path"].map((suffix) =>
      parsed(["--smtp-url", `smtp://${"a".repeat(32_768)}${suffix}`]),
    ),
  );
  for (const raw of malformed) {
    assert.throws(
      () => resolveMailSettings(raw),
      /Invalid SMTP connection URL/u,
    );
  }
  const raw = await parsed(["--smtp-url", "SMTPS://[::1]:465/"]);
  const resolved = resolveMailSettings(raw);
  assert.equal(resolved.mail.transport, "smtp");
  if (resolved.mail.transport !== "smtp") throw new Error();
  assert.equal(resolved.mail.connection.host, "::1");
  assert.equal(resolved.mail.connection.port, 465);
});
