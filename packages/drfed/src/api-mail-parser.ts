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

import { or } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import { map } from "@optique/core/modifiers";
import { flag, option } from "@optique/core/primitives";
import { integer, string } from "@optique/core/valueparser";

import {
  type createConfigurationBindings,
  configurationSettings as settings,
} from "./configuration.ts";
import { suggestedPath, suggestedString } from "./valueparser.ts";

/** API service options included in pure metadata argument arity. */
export const apiMailValueOptionNames = {
  mailApiKey: ["--mail-api-key"],
  mailApiKeyFile: ["--mail-api-key-file"],
  plunkApiKey: ["--plunk-api-key"],
  plunkApiKeyFile: ["--plunk-api-key-file"],
  plunkBaseUrl: ["--plunk-base-url"],
  plunkTimeout: ["--plunk-timeout"],
  resendApiKey: ["--resend-api-key"],
  resendApiKeyFile: ["--resend-api-key-file"],
  resendBaseUrl: ["--resend-base-url"],
  resendTimeout: ["--resend-timeout"],
  resendRetries: ["--resend-retries"],
  sesAuth: ["--ses-auth"],
  sesAccessKeyId: ["--ses-access-key-id"],
  sesAccessKeyIdFile: ["--ses-access-key-id-file"],
  sesSecretAccessKey: ["--ses-secret-access-key"],
  sesSecretAccessKeyFile: ["--ses-secret-access-key-file"],
  sesSessionToken: ["--ses-session-token"],
  sesSessionTokenFile: ["--ses-session-token-file"],
  sesRegion: ["--ses-region"],
  sesTimeout: ["--ses-timeout"],
  sendgridApiKey: ["--sendgrid-api-key"],
  sendgridApiKeyFile: ["--sendgrid-api-key-file"],
  sendgridBaseUrl: ["--sendgrid-base-url"],
  sendgridTimeout: ["--sendgrid-timeout"],
  mailgunApiKey: ["--mailgun-api-key"],
  mailgunApiKeyFile: ["--mailgun-api-key-file"],
  mailgunDomain: ["--mailgun-domain"],
  mailgunRegion: ["--mailgun-region"],
  mailgunBaseUrl: ["--mailgun-base-url"],
  mailgunTimeout: ["--mailgun-timeout"],
  mailtrapApiToken: ["--mailtrap-api-token"],
  mailtrapApiTokenFile: ["--mailtrap-api-token-file"],
  mailtrapInboxId: ["--mailtrap-inbox-id"],
  mailtrapSendBaseUrl: ["--mailtrap-send-base-url"],
  mailtrapSandboxBaseUrl: ["--mailtrap-sandbox-base-url"],
  mailtrapTimeout: ["--mailtrap-timeout"],
  mailerooApiKey: ["--maileroo-api-key"],
  mailerooApiKeyFile: ["--maileroo-api-key-file"],
  mailerooBaseUrl: ["--maileroo-base-url"],
  mailerooTimeout: ["--maileroo-timeout"],
  lettermintApiToken: ["--lettermint-api-token"],
  lettermintApiTokenFile: ["--lettermint-api-token-file"],
  lettermintBaseUrl: ["--lettermint-base-url"],
  lettermintRoute: ["--lettermint-route"],
  lettermintTimeout: ["--lettermint-timeout"],
  lettermintRetries: ["--lettermint-retries"],
} as const;

/** Source-tagged API fields; only the selected service is validated.
 * @returns Fields for composition into the common mail parser.
 */
export function createApiMailFields(
  bindings: ReturnType<typeof createConfigurationBindings>,
) {
  return {
    mailApiKey: bindings.bind(
      option(
        ...apiMailValueOptionNames.mailApiKey,
        string({ metavar: "VALUE" }),
        {
          description: message`API service credential for the selected mail transport.`,
        },
      ),
      settings.mailApiKey,
      string(),
      String,
    ),
    mailApiKeyFile: bindings.bind(
      option(...apiMailValueOptionNames.mailApiKeyFile, suggestedPath(), {
        description: message`File containing the selected mail API service credential.`,
      }),
      settings.mailApiKeyFile,
      string(),
      String,
    ),
    plunkApiKey: bindings.bind(
      option(
        ...apiMailValueOptionNames.plunkApiKey,
        string({ metavar: "VALUE" }),
        { description: message`Plunk sending API key.` },
      ),
      settings.plunkApiKey,
      string(),
      String,
    ),
    plunkApiKeyFile: bindings.bind(
      option(...apiMailValueOptionNames.plunkApiKeyFile, suggestedPath(), {
        description: message`File containing the Plunk API key.`,
      }),
      settings.plunkApiKeyFile,
      string(),
      String,
    ),
    plunkBaseUrl: bindings.bind(
      option(
        ...apiMailValueOptionNames.plunkBaseUrl,
        string({ metavar: "VALUE" }),
        {
          description: message`Plunk API base URL including a self-hosted path.`,
        },
      ),
      settings.plunkBaseUrl,
      string(),
      String,
    ),
    plunkTimeout: bindings.bind(
      map(
        option(
          ...apiMailValueOptionNames.plunkTimeout,
          integer({ min: 1, max: 2147483647 }),
          {
            description: message`Whole Plunk delivery timeout in milliseconds.`,
          },
        ),
        String,
      ),
      settings.plunkTimeout,
      string(),
      String,
    ),
    resendApiKey: bindings.bind(
      option(
        ...apiMailValueOptionNames.resendApiKey,
        string({ metavar: "VALUE" }),
        { description: message`Resend sending API key.` },
      ),
      settings.resendApiKey,
      string(),
      String,
    ),
    resendApiKeyFile: bindings.bind(
      option(...apiMailValueOptionNames.resendApiKeyFile, suggestedPath(), {
        description: message`File containing the Resend API key.`,
      }),
      settings.resendApiKeyFile,
      string(),
      String,
    ),
    resendBaseUrl: bindings.bind(
      option(
        ...apiMailValueOptionNames.resendBaseUrl,
        string({ metavar: "VALUE" }),
        { description: message`Resend API base URL including an API path.` },
      ),
      settings.resendBaseUrl,
      string(),
      String,
    ),
    resendTimeout: bindings.bind(
      map(
        option(
          ...apiMailValueOptionNames.resendTimeout,
          integer({ min: 1, max: 2147483647 }),
          {
            description: message`Whole Resend delivery timeout in milliseconds.`,
          },
        ),
        String,
      ),
      settings.resendTimeout,
      string(),
      String,
    ),
    resendRetries: bindings.bind(
      map(
        option(
          ...apiMailValueOptionNames.resendRetries,
          integer({ min: 0, max: 10 }),
          {
            description: message`Resend retries using one idempotency key (0 through 10).`,
          },
        ),
        String,
      ),
      settings.resendRetries,
      string(),
      String,
    ),
    sesAuth: bindings.bind(
      option(
        ...apiMailValueOptionNames.sesAuth,
        suggestedString(["credentials", "session"]),
        {
          description: message`SES authentication mode (credentials or session).`,
        },
      ),
      settings.sesAuth,
      string(),
      String,
    ),
    sesAccessKeyId: bindings.bind(
      option(
        ...apiMailValueOptionNames.sesAccessKeyId,
        string({ metavar: "VALUE" }),
        { description: message`SES access key ID.` },
      ),
      settings.sesAccessKeyId,
      string(),
      String,
    ),
    sesAccessKeyIdFile: bindings.bind(
      option(...apiMailValueOptionNames.sesAccessKeyIdFile, suggestedPath(), {
        description: message`File containing the SES access key ID.`,
      }),
      settings.sesAccessKeyIdFile,
      string(),
      String,
    ),
    sesSecretAccessKey: bindings.bind(
      option(
        ...apiMailValueOptionNames.sesSecretAccessKey,
        string({ metavar: "VALUE" }),
        { description: message`SES secret access key.` },
      ),
      settings.sesSecretAccessKey,
      string(),
      String,
    ),
    sesSecretAccessKeyFile: bindings.bind(
      option(
        ...apiMailValueOptionNames.sesSecretAccessKeyFile,
        suggestedPath(),
        { description: message`File containing the SES secret access key.` },
      ),
      settings.sesSecretAccessKeyFile,
      string(),
      String,
    ),
    sesSessionToken: bindings.bind(
      option(
        ...apiMailValueOptionNames.sesSessionToken,
        string({ metavar: "VALUE" }),
        { description: message`SES temporary session token.` },
      ),
      settings.sesSessionToken,
      string(),
      String,
    ),
    sesSessionTokenFile: bindings.bind(
      option(...apiMailValueOptionNames.sesSessionTokenFile, suggestedPath(), {
        description: message`File containing the SES session token.`,
      }),
      settings.sesSessionTokenFile,
      string(),
      String,
    ),
    sesRegion: bindings.bind(
      option(
        ...apiMailValueOptionNames.sesRegion,
        string({ metavar: "VALUE" }),
        { description: message`SES AWS region.` },
      ),
      settings.sesRegion,
      string(),
      String,
    ),
    sesTimeout: bindings.bind(
      map(
        option(
          ...apiMailValueOptionNames.sesTimeout,
          integer({ min: 1, max: 2147483647 }),
          { description: message`Whole SES delivery timeout in milliseconds.` },
        ),
        String,
      ),
      settings.sesTimeout,
      string(),
      String,
    ),
    sendgridApiKey: bindings.bind(
      option(
        ...apiMailValueOptionNames.sendgridApiKey,
        string({ metavar: "VALUE" }),
        { description: message`SendGrid sending API key.` },
      ),
      settings.sendgridApiKey,
      string(),
      String,
    ),
    sendgridApiKeyFile: bindings.bind(
      option(...apiMailValueOptionNames.sendgridApiKeyFile, suggestedPath(), {
        description: message`File containing the SendGrid API key.`,
      }),
      settings.sendgridApiKeyFile,
      string(),
      String,
    ),
    sendgridBaseUrl: bindings.bind(
      option(
        ...apiMailValueOptionNames.sendgridBaseUrl,
        string({ metavar: "VALUE" }),
        { description: message`SendGrid API base URL including an API path.` },
      ),
      settings.sendgridBaseUrl,
      string(),
      String,
    ),
    sendgridTimeout: bindings.bind(
      map(
        option(
          ...apiMailValueOptionNames.sendgridTimeout,
          integer({ min: 1, max: 2147483647 }),
          {
            description: message`Whole SendGrid delivery timeout in milliseconds.`,
          },
        ),
        String,
      ),
      settings.sendgridTimeout,
      string(),
      String,
    ),
    mailgunApiKey: bindings.bind(
      option(
        ...apiMailValueOptionNames.mailgunApiKey,
        string({ metavar: "VALUE" }),
        { description: message`Mailgun sending API key.` },
      ),
      settings.mailgunApiKey,
      string(),
      String,
    ),
    mailgunApiKeyFile: bindings.bind(
      option(...apiMailValueOptionNames.mailgunApiKeyFile, suggestedPath(), {
        description: message`File containing the Mailgun API key.`,
      }),
      settings.mailgunApiKeyFile,
      string(),
      String,
    ),
    mailgunDomain: bindings.bind(
      option(
        ...apiMailValueOptionNames.mailgunDomain,
        string({ metavar: "VALUE" }),
        { description: message`Verified Mailgun sending domain.` },
      ),
      settings.mailgunDomain,
      string(),
      String,
    ),
    mailgunRegion: bindings.bind(
      option(
        ...apiMailValueOptionNames.mailgunRegion,
        suggestedString(["us", "eu"]),
        { description: message`Mailgun API region (us or eu).` },
      ),
      settings.mailgunRegion,
      string(),
      String,
    ),
    mailgunBaseUrl: bindings.bind(
      option(
        ...apiMailValueOptionNames.mailgunBaseUrl,
        string({ metavar: "VALUE" }),
        { description: message`Mailgun API base URL including its path.` },
      ),
      settings.mailgunBaseUrl,
      string(),
      String,
    ),
    mailgunTimeout: bindings.bind(
      map(
        option(
          ...apiMailValueOptionNames.mailgunTimeout,
          integer({ min: 1, max: 2147483647 }),
          {
            description: message`Whole Mailgun delivery timeout in milliseconds.`,
          },
        ),
        String,
      ),
      settings.mailgunTimeout,
      string(),
      String,
    ),
    mailtrapApiToken: bindings.bind(
      option(
        ...apiMailValueOptionNames.mailtrapApiToken,
        string({ metavar: "VALUE" }),
        { description: message`Mailtrap sending API token.` },
      ),
      settings.mailtrapApiToken,
      string(),
      String,
    ),
    mailtrapApiTokenFile: bindings.bind(
      option(...apiMailValueOptionNames.mailtrapApiTokenFile, suggestedPath(), {
        description: message`File containing the Mailtrap API token.`,
      }),
      settings.mailtrapApiTokenFile,
      string(),
      String,
    ),
    mailtrapSandbox: bindings.bind(
      map(
        or(
          flag("--mailtrap-sandbox", {
            description: message`Capture mail in a test inbox.`,
          }),
          map(
            flag("--no-mailtrap-sandbox", {
              description: message`Use the production sending API.`,
            }),
            () => false,
          ),
        ),
        String,
      ),
      settings.mailtrapSandbox,
      string(),
      String,
      "false",
    ),
    mailtrapInboxId: bindings.bind(
      option(
        ...apiMailValueOptionNames.mailtrapInboxId,
        string({ metavar: "VALUE" }),
        { description: message`Mailtrap sandbox inbox ID.` },
      ),
      settings.mailtrapInboxId,
      string(),
      String,
    ),
    mailtrapSendBaseUrl: bindings.bind(
      option(
        ...apiMailValueOptionNames.mailtrapSendBaseUrl,
        string({ metavar: "VALUE" }),
        { description: message`Mailtrap sending API base URL.` },
      ),
      settings.mailtrapSendBaseUrl,
      string(),
      String,
    ),
    mailtrapSandboxBaseUrl: bindings.bind(
      option(
        ...apiMailValueOptionNames.mailtrapSandboxBaseUrl,
        string({ metavar: "VALUE" }),
        { description: message`Mailtrap sandbox API base URL.` },
      ),
      settings.mailtrapSandboxBaseUrl,
      string(),
      String,
    ),
    mailtrapTimeout: bindings.bind(
      map(
        option(
          ...apiMailValueOptionNames.mailtrapTimeout,
          integer({ min: 1, max: 2147483647 }),
          {
            description: message`Whole Mailtrap delivery timeout in milliseconds.`,
          },
        ),
        String,
      ),
      settings.mailtrapTimeout,
      string(),
      String,
    ),
    mailerooApiKey: bindings.bind(
      option(
        ...apiMailValueOptionNames.mailerooApiKey,
        string({ metavar: "VALUE" }),
        { description: message`Maileroo API sending key.` },
      ),
      settings.mailerooApiKey,
      string(),
      String,
    ),
    mailerooApiKeyFile: bindings.bind(
      option(...apiMailValueOptionNames.mailerooApiKeyFile, suggestedPath(), {
        description: message`File containing the Maileroo API sending key.`,
      }),
      settings.mailerooApiKeyFile,
      string(),
      String,
    ),
    mailerooBaseUrl: bindings.bind(
      option(
        ...apiMailValueOptionNames.mailerooBaseUrl,
        string({ metavar: "VALUE" }),
        { description: message`Maileroo API base URL including its path.` },
      ),
      settings.mailerooBaseUrl,
      string(),
      String,
    ),
    mailerooTimeout: bindings.bind(
      map(
        option(
          ...apiMailValueOptionNames.mailerooTimeout,
          integer({ min: 1, max: 2147483647 }),
          {
            description: message`Whole Maileroo delivery timeout in milliseconds.`,
          },
        ),
        String,
      ),
      settings.mailerooTimeout,
      string(),
      String,
    ),
    lettermintApiToken: bindings.bind(
      option(
        ...apiMailValueOptionNames.lettermintApiToken,
        string({ metavar: "VALUE" }),
        { description: message`Lettermint sending API token.` },
      ),
      settings.lettermintApiToken,
      string(),
      String,
    ),
    lettermintApiTokenFile: bindings.bind(
      option(
        ...apiMailValueOptionNames.lettermintApiTokenFile,
        suggestedPath(),
        { description: message`File containing the Lettermint API token.` },
      ),
      settings.lettermintApiTokenFile,
      string(),
      String,
    ),
    lettermintBaseUrl: bindings.bind(
      option(
        ...apiMailValueOptionNames.lettermintBaseUrl,
        string({ metavar: "VALUE" }),
        { description: message`Lettermint API base origin.` },
      ),
      settings.lettermintBaseUrl,
      string(),
      String,
    ),
    lettermintRoute: bindings.bind(
      option(
        ...apiMailValueOptionNames.lettermintRoute,
        string({ metavar: "VALUE" }),
        { description: message`Lettermint delivery route.` },
      ),
      settings.lettermintRoute,
      string(),
      String,
    ),
    lettermintTimeout: bindings.bind(
      map(
        option(
          ...apiMailValueOptionNames.lettermintTimeout,
          integer({ min: 1, max: 2147483647 }),
          {
            description: message`Whole Lettermint delivery timeout in milliseconds.`,
          },
        ),
        String,
      ),
      settings.lettermintTimeout,
      string(),
      String,
    ),
    lettermintRetries: bindings.bind(
      map(
        option(
          ...apiMailValueOptionNames.lettermintRetries,
          integer({ min: 0, max: 10 }),
          {
            description: message`Lettermint API retries using one idempotency key (0 through 10).`,
          },
        ),
        String,
      ),
      settings.lettermintRetries,
      string(),
      String,
    ),
  };
}
