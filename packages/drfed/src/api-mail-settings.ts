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

import { isIP } from "node:net";
import { domainToASCII } from "node:url";

import { bool } from "@optique/env";
import type { LettermintConfig } from "@upyo/lettermint";
import type { MailerooConfig } from "@upyo/maileroo";
import type { MailgunConfig } from "@upyo/mailgun";
import type { MailtrapConfig } from "@upyo/mailtrap";
import type { PlunkConfig } from "@upyo/plunk";
import type { ResendConfig } from "@upyo/resend";
import type { SendGridConfig } from "@upyo/sendgrid";

import type { Sourced } from "./configuration.ts";
import type { RawMailOptions } from "./mail-parser.ts";
import { type SecretSource, resolveSecretSource } from "./secret-source.ts";

/** Selected API service configuration before secret files are opened. */
export type ApiMailSettings =
  | {
      readonly transport: "lettermint";
      readonly connection: Omit<
        LettermintConfig,
        "apiToken" | "headers" | "tag" | "metadata" | "settings"
      >;
      readonly credential: SecretSource;
    }
  | {
      readonly transport: "maileroo";
      readonly connection: Omit<
        MailerooConfig,
        "apiKey" | "headers" | "tracking" | "tags"
      >;
      readonly credential: SecretSource;
    }
  | {
      readonly transport: "mailtrap";
      readonly connection: Omit<
        MailtrapConfig,
        "apiToken" | "metadata" | "headers" | "defaultCategory" | "userAgent"
      >;
      readonly credential: SecretSource;
    }
  | {
      readonly transport: "mailgun";
      readonly connection: Omit<
        MailgunConfig,
        "apiKey" | "headers" | "tracking" | "clickTracking" | "openTracking"
      >;
      readonly credential: SecretSource;
    }
  | {
      readonly transport: "plunk";
      readonly connection: Omit<PlunkConfig, "apiKey" | "headers">;
      readonly credential: SecretSource;
    }
  | {
      readonly transport: "resend";
      readonly connection: Omit<ResendConfig, "apiKey" | "headers">;
      readonly credential: SecretSource;
    }
  | {
      readonly transport: "sendgrid";
      readonly connection: Omit<
        SendGridConfig,
        | "apiKey"
        | "headers"
        | "clickTracking"
        | "openTracking"
        | "subscriptionTracking"
        | "googleAnalytics"
      >;
      readonly credential: SecretSource;
    };

type Input = Sourced<string | undefined> | undefined;
const priority = { default: 0, config: 1, env: 2, cli: 3 } as const;
const rank = (input: Input) =>
  input?.value === undefined ? -1 : priority[input.source];

/** Validate API token/key contents without exposing them in errors. */
export function validateApiMailCredential(value: string) {
  if (value === "" || /[^\x21-\x7e]/u.test(value)) {
    throw new Error("Invalid mail API credential.");
  }
}

function credential(
  raw: RawMailOptions,
  cwd: string,
  provider: ApiMailSettings["transport"],
) {
  const names = {
    lettermint: ["lettermintApiToken", "lettermintApiTokenFile"],
    maileroo: ["mailerooApiKey", "mailerooApiKeyFile"],
    mailtrap: ["mailtrapApiToken", "mailtrapApiTokenFile"],
    sendgrid: ["sendgridApiKey", "sendgridApiKeyFile"],
    mailgun: ["mailgunApiKey", "mailgunApiKeyFile"],
    plunk: ["plunkApiKey", "plunkApiKeyFile"],
    resend: ["resendApiKey", "resendApiKeyFile"],
  } as const;
  const specific = names[provider].map(
    (name, index) => [name, raw[name], index === 1] as const,
  );
  const variants = [
    ["mailApiKey", raw.mailApiKey, false],
    ["mailApiKeyFile", raw.mailApiKeyFile, true],
    ...specific,
  ] as const;
  const highest = Math.max(...variants.map(([, input]) => rank(input)));
  if (highest < 0) throw new Error(`${provider} requires an API credential.`);
  const winners = variants.filter(([, input]) => rank(input) === highest);
  if (winners.length !== 1) {
    throw new Error(
      "Conflicting mail API credential variants at the same source.",
    );
  }
  const winner = winners[0]!;
  const secret = resolveSecretSource(
    winner[2] ? undefined : winner[1],
    winner[2] ? winner[1] : undefined,
    "mail API credential",
    cwd,
  );
  if (secret === undefined) throw new Error("Missing mail API credential.");
  if (secret.type === "literal") validateApiMailCredential(secret.value);
  const sources: Record<string, Input> = Object.fromEntries(
    variants.map(([name, input]) => [
      name,
      name === winner[0] ? input : undefined,
    ]),
  );
  return { secret, sources };
}

function endpoint(
  input: Input,
  provider: ApiMailSettings["transport"],
  fallback?: string,
) {
  if (input?.value === undefined) {
    return (
      fallback ??
      (provider === "lettermint"
        ? "https://api.lettermint.co"
        : "https://smtp.maileroo.com/api/v2")
    );
  }
  try {
    const value = new URL(input.value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(value.hostname);
    if (
      (value.protocol !== "https:" && !(value.protocol === "http:" && local)) ||
      value.username !== "" ||
      value.password !== "" ||
      (provider === "lettermint" && value.pathname !== "/") ||
      /[?#]/u.test(value.href)
    ) {
      throw new Error();
    }
    return provider === "lettermint"
      ? value.origin
      : value.href.replace(/\/+$/u, "");
  } catch {
    throw new Error(
      provider === "lettermint"
        ? "Invalid Lettermint base origin; use HTTPS or local loopback HTTP without credentials."
        : `Invalid ${provider} API endpoint; use HTTPS or local loopback HTTP without credentials, query or fragment.`,
    );
  }
}

function number(
  input: Input,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
  provider: ApiMailSettings["transport"] = "lettermint",
) {
  if (input?.value === undefined) return fallback;
  const value = Number(input.value);
  if (
    !/^\d+$/u.test(input.value) ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `Invalid ${provider === "sendgrid" ? "SendGrid" : provider[0]!.toUpperCase() + provider.slice(1)} ${field}.`,
    );
  }
  return value;
}

function mailtrapSettings(
  raw: RawMailOptions,
  auth: ReturnType<typeof credential>,
) {
  const provider = "mailtrap" as const;
  const parsed = bool().parse(raw.mailtrapSandbox?.value ?? "false");
  if (!parsed.success) throw new Error("Invalid Mailtrap sandbox setting.");
  const sandbox = parsed.value;
  const id = raw.mailtrapInboxId?.value;
  if (
    sandbox &&
    (id === undefined ||
      !/^[1-9]\d*$/u.test(id) ||
      !Number.isSafeInteger(Number(id)))
  ) {
    throw new Error("Mailtrap sandbox requires a positive decimal inbox ID.");
  }
  const active = sandbox ? "mailtrapSandboxBaseUrl" : "mailtrapSendBaseUrl";
  const inactive = sandbox ? "mailtrapSendBaseUrl" : "mailtrapSandboxBaseUrl";
  const url = endpoint(
    raw[active],
    provider,
    sandbox
      ? "https://sandbox.api.mailtrap.io"
      : "https://send.api.mailtrap.io",
  );
  const connection = {
    sandbox,
    ...(sandbox ? { inboxId: id!, sandboxBaseUrl: url } : { sendBaseUrl: url }),
    timeout: number(
      raw.mailtrapTimeout,
      30000,
      1,
      2147483647,
      "delivery timeout",
      provider,
    ),
    retries: 0,
    validateSsl: true,
  };
  const mail: ApiMailSettings = {
    transport: provider,
    connection,
    credential: auth.secret,
  };
  return {
    mail,
    sources: {
      ...auth.sources,
      [inactive]: undefined,
      ...(sandbox ? {} : { mailtrapInboxId: undefined }),
    },
    values: {
      mailtrapSandbox: sandbox,
      [active]: url,
      mailtrapTimeout: connection.timeout,
      ...(sandbox ? { mailtrapInboxId: id } : {}),
    },
  };
}

function mailgunDomain(input: Input) {
  const original = input?.value;
  if (
    original === undefined ||
    original === "" ||
    /[\\/:@?#%\s]/u.test(original)
  ) {
    throw new Error("Invalid Mailgun sending domain.");
  }
  const value = domainToASCII(original).toLowerCase().replace(/\.$/u, "");
  if (
    value.length > 253 ||
    isIP(value) !== 0 ||
    !value
      .split(".")
      .every(
        (label) =>
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  ) {
    throw new Error("Invalid Mailgun sending domain.");
  }
  return value;
}
function mailgunSettings(
  raw: RawMailOptions,
  auth: ReturnType<typeof credential>,
) {
  const region = raw.mailgunRegion?.value ?? "us";
  if (region !== "us" && region !== "eu") {
    throw new Error("Invalid Mailgun region; use us or eu.");
  }
  const connection: Omit<MailgunConfig, "apiKey"> = {
    domain: mailgunDomain(raw.mailgunDomain),
    region,
    baseUrl: endpoint(
      raw.mailgunBaseUrl,
      "mailgun",
      region === "eu"
        ? "https://api.eu.mailgun.net/v3"
        : "https://api.mailgun.net/v3",
    ),
    timeout: number(
      raw.mailgunTimeout,
      30000,
      1,
      2147483647,
      "delivery timeout",
      "mailgun",
    ),
    retries: 0,
    validateSsl: true,
    tracking: false,
    clickTracking: false,
    openTracking: false,
  };
  const mail: ApiMailSettings = {
    transport: "mailgun",
    connection,
    credential: auth.secret,
  };
  return {
    mail,
    sources: auth.sources,
    values: {
      mailgunDomain: connection.domain,
      mailgunRegion: region,
      mailgunBaseUrl: connection.baseUrl,
      mailgunTimeout: connection.timeout,
    },
  };
}

function plunkSettings(
  raw: RawMailOptions,
  auth: ReturnType<typeof credential>,
) {
  const connection = {
    baseUrl: endpoint(
      raw.plunkBaseUrl,
      "plunk",
      "https://next-api.useplunk.com",
    ),
    timeout: number(
      raw.plunkTimeout,
      30000,
      1,
      2147483647,
      "delivery timeout",
      "plunk",
    ),
    retries: 0,
    validateSsl: true,
  };
  const mail: ApiMailSettings = {
    transport: "plunk",
    connection,
    credential: auth.secret,
  };
  return {
    mail,
    sources: auth.sources,
    values: {
      plunkBaseUrl: connection.baseUrl,
      plunkTimeout: connection.timeout,
    },
  };
}

function resendSettings(
  raw: RawMailOptions,
  auth: ReturnType<typeof credential>,
) {
  const connection = {
    baseUrl: endpoint(raw.resendBaseUrl, "resend", "https://api.resend.com"),
    timeout: number(
      raw.resendTimeout,
      30000,
      1,
      2147483647,
      "delivery timeout",
      "resend",
    ),
    retries: number(raw.resendRetries, 3, 0, 10, "retries", "resend"),
    validateSsl: true,
  };
  const mail: ApiMailSettings = {
    transport: "resend",
    connection,
    credential: auth.secret,
  };
  return {
    mail,
    sources: auth.sources,
    values: {
      resendBaseUrl: connection.baseUrl,
      resendTimeout: connection.timeout,
      resendRetries: connection.retries,
    },
  };
}

function sendgridSettings(
  raw: RawMailOptions,
  auth: ReturnType<typeof credential>,
) {
  const connection = {
    baseUrl: endpoint(
      raw.sendgridBaseUrl,
      "sendgrid",
      "https://api.sendgrid.com/v3",
    ),
    timeout: number(
      raw.sendgridTimeout,
      30000,
      1,
      2147483647,
      "delivery timeout",
      "sendgrid",
    ),
    retries: 0,
    validateSsl: true,
    clickTracking: false,
    openTracking: false,
    subscriptionTracking: false,
    googleAnalytics: false,
  };
  const mail: ApiMailSettings = {
    transport: "sendgrid",
    connection,
    credential: auth.secret,
  };
  return {
    mail,
    sources: auth.sources,
    values: {
      sendgridBaseUrl: connection.baseUrl,
      sendgridTimeout: connection.timeout,
    },
  };
}

/** Resolve only the selected API service; credentials remain unopened.
 * @returns Prepared meaning, safe diagnostic values and effective source tags.
 */
export function resolveApiMailSettings(
  raw: RawMailOptions,
  cwd: string,
  provider: ApiMailSettings["transport"] = "lettermint",
) {
  const auth = credential(raw, cwd, provider);
  if (provider === "plunk") return plunkSettings(raw, auth);
  if (provider === "resend") return resendSettings(raw, auth);
  if (provider === "sendgrid") return sendgridSettings(raw, auth);
  if (provider === "mailgun") return mailgunSettings(raw, auth);
  if (provider === "mailtrap") return mailtrapSettings(raw, auth);
  if (provider === "maileroo") {
    const connection = {
      baseUrl: endpoint(raw.mailerooBaseUrl, provider),
      timeout: number(
        raw.mailerooTimeout,
        30000,
        1,
        2147483647,
        "delivery timeout",
        provider,
      ),
      retries: 0,
    };
    const mail: ApiMailSettings = {
      transport: provider,
      connection,
      credential: auth.secret,
    };
    return {
      mail,
      sources: auth.sources,
      values: {
        mailerooBaseUrl: connection.baseUrl,
        mailerooTimeout: connection.timeout,
      },
    };
  }
  if (
    raw.lettermintRoute?.value === "" ||
    (raw.lettermintRoute?.value !== undefined &&
      /\p{Cc}/u.test(raw.lettermintRoute.value))
  ) {
    throw new Error("Invalid Lettermint route.");
  }
  const connection = {
    baseUrl: endpoint(raw.lettermintBaseUrl, provider),
    timeout: number(
      raw.lettermintTimeout,
      30_000,
      1,
      2_147_483_647,
      "delivery timeout",
    ),
    retries: number(raw.lettermintRetries, 3, 0, 10, "retries"),
    ...(raw.lettermintRoute?.value === undefined
      ? {}
      : { route: raw.lettermintRoute.value }),
  };
  const mail: ApiMailSettings = {
    transport: "lettermint",
    connection,
    credential: auth.secret,
  };
  return {
    mail,
    sources: auth.sources,
    values: {
      lettermintBaseUrl: connection.baseUrl,
      lettermintTimeout: connection.timeout,
      lettermintRetries: connection.retries,
      lettermintRoute: connection.route,
    },
  };
}
