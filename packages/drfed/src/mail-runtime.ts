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

import { X509Certificate, createPrivateKey } from "node:crypto";
import { createSecureContext, getCACertificates } from "node:tls";

import { getLogger } from "@logtape/logtape";
import type { Transport } from "@upyo/core";
import type { JmapConfig } from "@upyo/jmap";
import { type LettermintConfig, LettermintTransport } from "@upyo/lettermint";
import { LogTapeTransport } from "@upyo/logtape";
import { type MailerooConfig, MailerooTransport } from "@upyo/maileroo";
import { type MailgunConfig, MailgunTransport } from "@upyo/mailgun";
import { type MailtrapConfig, MailtrapTransport } from "@upyo/mailtrap";
import { type PlunkConfig, PlunkTransport } from "@upyo/plunk";
import { type ResendConfig } from "@upyo/resend";
import {
  type SmtpConfig,
  type SmtpTlsOptions,
  SmtpTransport,
} from "@upyo/smtp";

import {
  type ApiMailSettings,
  validateApiMailCredential,
} from "./api-mail-settings.ts";
import { createBoundedTransport } from "./bounded-mail-runtime.ts";
import { createJmapTransport } from "./jmap-runtime.ts";
import { validateJmapCredential } from "./jmap-settings.ts";
import {
  type MailAuthentication,
  type MailSettings,
  validateSmtpOAuth,
  validateSmtpPassword,
} from "./mail-settings.ts";
import { createResendTransport } from "./resend-runtime.ts";
import { readSecretSource } from "./secret-source.ts";

/** Mail settings with operational credential reads completed before DB writes. */
export type PreparedMail =
  | { readonly transport: "plunk"; readonly connection: PlunkConfig }
  | { readonly transport: "resend"; readonly connection: ResendConfig }
  | { readonly transport: "mailgun"; readonly connection: MailgunConfig }
  | { readonly transport: "mailtrap"; readonly connection: MailtrapConfig }
  | { readonly transport: "maileroo"; readonly connection: MailerooConfig }
  | { readonly transport: "lettermint"; readonly connection: LettermintConfig }
  | { readonly transport: "jmap"; readonly connection: JmapConfig }
  | { readonly transport: "logtape"; readonly logContent: boolean }
  | { readonly transport: "smtp"; readonly connection: SmtpConfig };

function validateCredential(
  authentication: MailAuthentication | undefined,
  credential: string | undefined,
) {
  if (authentication === undefined || credential === undefined) return;
  if (authentication.type === "password") {
    validateSmtpPassword(authentication.user, credential);
  } else {
    validateSmtpOAuth(authentication.user, credential);
  }
}

function validatedTls(
  ca: string | undefined,
  cert: string | undefined,
  key: string | undefined,
): SmtpTlsOptions {
  const tls: SmtpTlsOptions = {
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    ...(ca === undefined ? {} : { ca: [...getCACertificates("default"), ca] }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
  };
  try {
    if (ca !== undefined) new X509Certificate(ca).toString();
    if (cert !== undefined) new X509Certificate(cert).toString();
    if (key !== undefined) createPrivateKey(key);
    createSecureContext(tls);
  } catch {
    throw new Error("Invalid SMTP TLS settings.");
  }
  return tls;
}

async function prepareApiMail(
  settings: ApiMailSettings,
  signal?: AbortSignal,
): Promise<Extract<PreparedMail, { transport: ApiMailSettings["transport"] }>> {
  const credential = await readSecretSource(
    settings.credential,
    "mail API credential",
    signal,
  );
  validateApiMailCredential(credential);
  signal?.throwIfAborted();
  if (settings.transport === "plunk") {
    return {
      transport: settings.transport,
      connection: {
        ...settings.connection,
        apiKey: credential,
        retries: 0,
        validateSsl: true,
      },
    };
  }
  if (settings.transport === "resend") {
    return {
      transport: settings.transport,
      connection: {
        ...settings.connection,
        apiKey: credential,
        validateSsl: true,
      },
    };
  }
  if (settings.transport === "mailgun") {
    return {
      transport: settings.transport,
      connection: {
        ...settings.connection,
        apiKey: credential,
        retries: 0,
        validateSsl: true,
        tracking: false,
        clickTracking: false,
        openTracking: false,
      },
    };
  }
  if (settings.transport === "maileroo") {
    return {
      transport: settings.transport,
      connection: { ...settings.connection, apiKey: credential, retries: 0 },
    };
  }
  if (settings.transport === "mailtrap") {
    return {
      transport: settings.transport,
      connection: {
        ...settings.connection,
        apiToken: credential,
        retries: 0,
        validateSsl: true,
      },
    };
  }
  return {
    transport: settings.transport,
    connection: { ...settings.connection, apiToken: credential },
  };
}

function isApiMailSettings(
  settings: MailSettings,
): settings is ApiMailSettings {
  return [
    "lettermint",
    "maileroo",
    "mailtrap",
    "mailgun",
    "plunk",
    "resend",
  ].includes(settings.transport);
}

/** Resolve selected files without creating a transport or changing the database.
 * @returns Prepared provider configuration, with opaque credential errors.
 */
export async function prepareMail(
  settings: MailSettings,
  signal?: AbortSignal,
): Promise<PreparedMail> {
  signal?.throwIfAborted();
  if (settings.transport === "logtape") return settings;
  if (isApiMailSettings(settings)) {
    return await prepareApiMail(settings, signal);
  }
  if (settings.transport === "jmap") {
    const { authentication } = settings;
    const credential = await readSecretSource(
      authentication.secret,
      "JMAP authentication",
      signal,
    );
    validateJmapCredential(
      authentication.type,
      credential,
      authentication.user,
    );
    signal?.throwIfAborted();
    return {
      transport: "jmap",
      connection: {
        ...settings.connection,
        ...(authentication.type === "bearer"
          ? { bearerToken: credential }
          : {
              basicAuth: {
                username: authentication.user!,
                password: credential,
              },
            }),
      },
    };
  }
  const { authentication } = settings;
  const credential =
    authentication === undefined
      ? undefined
      : await readSecretSource(
          authentication.secret,
          "SMTP authentication",
          signal,
        );
  validateCredential(authentication, credential);
  const files = await Promise.allSettled([
    settings.files.ca === undefined
      ? undefined
      : readSecretSource(
          settings.files.ca,
          "SMTP certificate authorities",
          signal,
        ),
    settings.files.cert === undefined
      ? undefined
      : readSecretSource(
          settings.files.cert,
          "SMTP client certificate",
          signal,
        ),
    settings.files.key === undefined
      ? undefined
      : readSecretSource(settings.files.key, "SMTP client key", signal),
  ]);
  signal?.throwIfAborted();
  const rejected = files.find((file) => file.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  const [ca, cert, key] = files.map((file) =>
    file.status === "fulfilled" ? file.value : undefined,
  );
  return {
    transport: "smtp",
    connection: {
      ...settings.connection,
      tls: validatedTls(ca, cert, key),
      ...(authentication === undefined || credential === undefined
        ? {}
        : {
            auth:
              authentication.type === "password"
                ? {
                    user: authentication.user,
                    pass: credential,
                    method: authentication.method,
                  }
                : {
                    user: authentication.user,
                    accessToken: credential,
                    method: authentication.method,
                  },
          }),
    },
  };
}

/** A facade-owned transport with one memoized cleanup. */
export interface MailRuntime {
  readonly transport: Transport;
  close(): Promise<void>;
}

/** Construct a transport after selected configuration has been prepared.
 * @returns An owned transport and idempotent asynchronous cleanup.
 */
export function createMailRuntime(settings: PreparedMail): MailRuntime {
  const transport =
    settings.transport === "resend"
      ? createResendTransport(settings.connection)
      : settings.transport === "plunk"
        ? createBoundedTransport(
            new PlunkTransport({
              ...settings.connection,
              retries: 0,
              validateSsl: true,
            }),
            settings.connection.timeout ?? 30000,
            "Plunk",
          )
        : settings.transport === "mailgun"
          ? createBoundedTransport(
              new MailgunTransport({
                ...settings.connection,
                retries: 0,
                validateSsl: true,
                tracking: false,
                clickTracking: false,
                openTracking: false,
              }),
              settings.connection.timeout ?? 30000,
              "Mailgun",
            )
          : settings.transport === "mailtrap"
            ? createBoundedTransport(
                new MailtrapTransport({
                  ...settings.connection,
                  retries: 0,
                  validateSsl: true,
                }),
                settings.connection.timeout ?? 30000,
                "Mailtrap",
              )
            : settings.transport === "maileroo"
              ? createBoundedTransport(
                  new MailerooTransport({ ...settings.connection, retries: 0 }),
                  settings.connection.timeout ?? 30000,
                  "Maileroo",
                )
              : settings.transport === "lettermint"
                ? createBoundedTransport(
                    new LettermintTransport(settings.connection),
                    settings.connection.timeout ?? 30_000,
                    "Lettermint",
                  )
                : settings.transport === "jmap"
                  ? createJmapTransport(settings.connection)
                  : settings.transport === "smtp"
                    ? new SmtpTransport(settings.connection)
                    : new LogTapeTransport({
                        ...(settings.logContent
                          ? { recordMessage: "inline" as const }
                          : {}),
                      });
  if (settings.transport === "logtape") {
    getLogger(["drfed", "mail"]).warning(
      "Mail delivery is disabled. Select a delivery transport; use --mail-log-content only to inspect login codes in development logs.",
    );
  }
  let closing: Promise<void> | undefined;
  return {
    transport,
    close() {
      // Assign before cleanup starts, including callbacks that reenter close().
      // oxlint-disable-next-line promise/prefer-await-to-then
      return (closing ??= Promise.resolve().then(async () => {
        try {
          if (Symbol.asyncDispose in transport) {
            await transport[Symbol.asyncDispose]();
          }
        } catch {
          throw new Error("Mail transport cleanup failed.");
        }
        return undefined;
      }));
    },
  };
}
