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

import { object, or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { map } from "@optique/core/modifiers";
import type { InferValue } from "@optique/core/parser";
import { flag, option } from "@optique/core/primitives";
import { integer, string } from "@optique/core/valueparser";

import {
  apiMailValueOptionNames,
  createApiMailFields,
} from "./api-mail-parser.ts";
import {
  type createConfigurationBindings,
  configurationSettings as settings,
} from "./configuration.ts";
import { createJmapFields, jmapValueOptionNames } from "./jmap-parser.ts";
import { suggestedString } from "./valueparser.ts";

/** Mail value-option spellings shared by parsing and metadata arity. */
export const mailValueOptionNames = {
  ...apiMailValueOptionNames,
  ...jmapValueOptionNames,
  mailTransport: ["--mail-transport"],
  smtpUrl: ["--smtp-url", "-s"],
  smtpHost: ["--smtp-host"],
  smtpPort: ["--smtp-port"],
  smtpTls: ["--smtp-tls"],
  smtpUser: ["--smtp-user"],
  smtpPassword: ["--smtp-password"],
  smtpPasswordFile: ["--smtp-password-file"],
  smtpAuthMethod: ["--smtp-auth-method"],
  smtpAccessToken: ["--smtp-access-token"],
  smtpAccessTokenFile: ["--smtp-access-token-file"],
  smtpConnectionTimeout: ["--smtp-connection-timeout"],
  smtpSocketTimeout: ["--smtp-socket-timeout"],
  smtpPoolSize: ["--smtp-pool-size"],
  smtpLocalName: ["--smtp-local-name"],
  smtpCaFile: ["--smtp-ca-file"],
  smtpCertFile: ["--smtp-cert-file"],
  smtpKeyFile: ["--smtp-key-file"],
} as const;

/** Create source-aware mail options without transport construction or file reads.
 * @returns The common mail parser projection.
 */
export function createMailParser(
  bindings: ReturnType<typeof createConfigurationBindings>,
) {
  const { bind } = bindings;
  const identity = (value: string) => value;
  return object("Mail delivery options", {
    ...createApiMailFields(bindings),
    ...createJmapFields(bindings),
    mailTransport: bind(
      option(
        ...mailValueOptionNames.mailTransport,
        suggestedString(
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
          "TRANSPORT",
        ),
        {
          description: message`Select logtape, smtp, jmap, lettermint, maileroo, mailtrap, mailgun, plunk, resend, sendgrid or ses. SMTP host/URL and JMAP session URL select their provider.`,
        },
      ),
      settings.mailTransport,
      string(),
      identity,
    ),
    smtpUrl: bind(
      option(...mailValueOptionNames.smtpUrl, string({ metavar: "URL" }), {
        description: message`SMTP URL. Separate fields at a higher source override its components.`,
      }),
      settings.smtpUrl,
      string(),
      identity,
    ),
    mailLogContent: bind(
      map(
        or(
          flag("--mail-log-content", {
            description: message`Include subject and body in log-only mail output. Login codes become visible in the log.`,
          }),
          map(
            flag("--no-mail-log-content", {
              description: message`Exclude mail subject and body from logs. This is the default.`,
            }),
            () => false,
          ),
        ),
        String,
      ),
      settings.mailLogContent,
      string(),
      String,
      "false",
    ),
    smtpHost: bind(
      option(...mailValueOptionNames.smtpHost, string({ metavar: "VALUE" }), {
        description: message`SMTP server hostname.`,
      }),
      settings.smtpHost,
      string(),
      identity,
    ),
    smtpPort: bind(
      map(
        option(
          ...mailValueOptionNames.smtpPort,
          integer({ min: 1, max: 65535 }),
          { description: message`SMTP server port.` },
        ),
        String,
      ),
      settings.smtpPort,
      string(),
      String,
    ),
    smtpTls: bind(
      option(
        ...mailValueOptionNames.smtpTls,
        suggestedString(["direct", "starttls-required", "opportunistic"]),
        {
          description: message`SMTP TLS mode: direct, starttls-required or opportunistic.`,
        },
      ),
      settings.smtpTls,
      string(),
      identity,
    ),
    smtpUser: bind(
      option(...mailValueOptionNames.smtpUser, string({ metavar: "VALUE" }), {
        description: message`SMTP authentication username.`,
      }),
      settings.smtpUser,
      string(),
      identity,
    ),
    smtpPassword: bind(
      option(
        ...mailValueOptionNames.smtpPassword,
        string({ metavar: "VALUE" }),
        { description: message`SMTP authentication password.` },
      ),
      settings.smtpPassword,
      string(),
      identity,
    ),
    smtpPasswordFile: bind(
      option(
        ...mailValueOptionNames.smtpPasswordFile,
        string({ metavar: "VALUE" }),
        { description: message`File containing the SMTP password.` },
      ),
      settings.smtpPasswordFile,
      string(),
      identity,
    ),
    smtpAuthMethod: bind(
      option(
        ...mailValueOptionNames.smtpAuthMethod,
        suggestedString(["plain", "login", "xoauth2", "oauthbearer"]),
        { description: message`SMTP authentication method.` },
      ),
      settings.smtpAuthMethod,
      string(),
      identity,
    ),
    smtpAccessToken: bind(
      option(
        ...mailValueOptionNames.smtpAccessToken,
        string({ metavar: "VALUE" }),
        { description: message`Static SMTP OAuth access token.` },
      ),
      settings.smtpAccessToken,
      string(),
      identity,
    ),
    smtpAccessTokenFile: bind(
      option(
        ...mailValueOptionNames.smtpAccessTokenFile,
        string({ metavar: "VALUE" }),
        { description: message`File containing the SMTP OAuth access token.` },
      ),
      settings.smtpAccessTokenFile,
      string(),
      identity,
    ),
    smtpConnectionTimeout: bind(
      map(
        option(
          ...mailValueOptionNames.smtpConnectionTimeout,
          integer({ min: 1, max: 2147483647 }),
          { description: message`SMTP connection timeout in milliseconds.` },
        ),
        String,
      ),
      settings.smtpConnectionTimeout,
      string(),
      String,
    ),
    smtpSocketTimeout: bind(
      map(
        option(
          ...mailValueOptionNames.smtpSocketTimeout,
          integer({ min: 1, max: 2147483647 }),
          { description: message`SMTP socket timeout in milliseconds.` },
        ),
        String,
      ),
      settings.smtpSocketTimeout,
      string(),
      String,
    ),
    smtpPoolSize: bind(
      map(
        option(
          ...mailValueOptionNames.smtpPoolSize,
          integer({ min: 1, max: 2147483647 }),
          { description: message`Maximum owned SMTP connections.` },
        ),
        String,
      ),
      settings.smtpPoolSize,
      string(),
      String,
    ),
    smtpLocalName: bind(
      option(
        ...mailValueOptionNames.smtpLocalName,
        string({ metavar: "VALUE" }),
        { description: message`Local name for SMTP EHLO.` },
      ),
      settings.smtpLocalName,
      string(),
      identity,
    ),
    smtpCaFile: bind(
      option(...mailValueOptionNames.smtpCaFile, string({ metavar: "VALUE" }), {
        description: message`File containing additional SMTP certificate authorities.`,
      }),
      settings.smtpCaFile,
      string(),
      identity,
    ),
    smtpCertFile: bind(
      option(
        ...mailValueOptionNames.smtpCertFile,
        string({ metavar: "VALUE" }),
        { description: message`File containing the SMTP client certificate.` },
      ),
      settings.smtpCertFile,
      string(),
      identity,
    ),
    smtpKeyFile: bind(
      option(
        ...mailValueOptionNames.smtpKeyFile,
        string({ metavar: "VALUE" }),
        { description: message`File containing the SMTP client private key.` },
      ),
      settings.smtpKeyFile,
      string(),
      identity,
    ),
  });
}

/** Parsed mail options retain source tags until variant selection. */
export type RawMailOptions = InferValue<ReturnType<typeof createMailParser>>;
