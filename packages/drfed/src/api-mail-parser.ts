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

/** API service options included in pure metadata argument arity. */
export const apiMailValueOptionNames = {
  mailApiKey: ["--mail-api-key"],
  mailApiKeyFile: ["--mail-api-key-file"],
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
      option(
        ...apiMailValueOptionNames.mailApiKeyFile,
        string({ metavar: "VALUE" }),
        {
          description: message`File containing the selected mail API service credential.`,
        },
      ),
      settings.mailApiKeyFile,
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
      option(
        ...apiMailValueOptionNames.mailgunApiKeyFile,
        string({ metavar: "VALUE" }),
        { description: message`File containing the Mailgun API key.` },
      ),
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
        string({ metavar: "VALUE" }),
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
      option(
        ...apiMailValueOptionNames.mailtrapApiTokenFile,
        string({ metavar: "VALUE" }),
        { description: message`File containing the Mailtrap API token.` },
      ),
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
      option(
        ...apiMailValueOptionNames.mailerooApiKeyFile,
        string({ metavar: "VALUE" }),
        { description: message`Maileroo File containing the API sending key.` },
      ),
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
            description: message`Maileroo Whole delivery timeout in milliseconds.`,
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
        string({ metavar: "VALUE" }),
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
