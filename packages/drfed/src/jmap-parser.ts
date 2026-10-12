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

import { message } from "@optique/core/message";
import { option } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";

import {
  type createConfigurationBindings,
  configurationSettings as settings,
} from "./configuration.ts";
import { suggestedPath } from "./valueparser.ts";

/** JMAP value options also used by pure metadata argument handling. */
export const jmapValueOptionNames = {
  jmapSessionUrl: ["--jmap-session-url"],
  jmapBearerToken: ["--jmap-bearer-token"],
  jmapBearerTokenFile: ["--jmap-bearer-token-file"],
  jmapUser: ["--jmap-user"],
  jmapPassword: ["--jmap-password"],
  jmapPasswordFile: ["--jmap-password-file"],
  jmapAccountId: ["--jmap-account-id"],
  jmapIdentityId: ["--jmap-identity-id"],
  jmapBaseUrl: ["--jmap-base-url"],
  jmapTimeout: ["--jmap-timeout"],
  jmapSessionCacheTtl: ["--jmap-session-cache-ttl"],
} as const;

/** Source-tagged fields; provider validation and file reads happen later.
 * @returns Fields for composition into the common mail parser.
 */
export function createJmapFields(
  bindings: ReturnType<typeof createConfigurationBindings>,
) {
  return {
    jmapSessionUrl: bindings.bind(
      option(
        ...jmapValueOptionNames.jmapSessionUrl,
        string({ metavar: "VALUE" }),
        { description: message`JMAP session discovery URL.` },
      ),
      settings.jmapSessionUrl,
      string(),
      String,
    ),
    jmapBearerToken: bindings.bind(
      option(
        ...jmapValueOptionNames.jmapBearerToken,
        string({ metavar: "VALUE" }),
        { description: message`JMAP bearer token.` },
      ),
      settings.jmapBearerToken,
      string(),
      String,
    ),
    jmapBearerTokenFile: bindings.bind(
      option(...jmapValueOptionNames.jmapBearerTokenFile, suggestedPath(), {
        description: message`File containing the JMAP bearer token.`,
      }),
      settings.jmapBearerTokenFile,
      string(),
      String,
    ),
    jmapUser: bindings.bind(
      option(...jmapValueOptionNames.jmapUser, string({ metavar: "VALUE" }), {
        description: message`JMAP basic authentication username.`,
      }),
      settings.jmapUser,
      string(),
      String,
    ),
    jmapPassword: bindings.bind(
      option(
        ...jmapValueOptionNames.jmapPassword,
        string({ metavar: "VALUE" }),
        { description: message`JMAP basic authentication password.` },
      ),
      settings.jmapPassword,
      string(),
      String,
    ),
    jmapPasswordFile: bindings.bind(
      option(...jmapValueOptionNames.jmapPasswordFile, suggestedPath(), {
        description: message`File containing the JMAP password.`,
      }),
      settings.jmapPasswordFile,
      string(),
      String,
    ),
    jmapAccountId: bindings.bind(
      option(
        ...jmapValueOptionNames.jmapAccountId,
        string({ metavar: "VALUE" }),
        {
          description: message`JMAP account ID; automatically discovered when absent.`,
        },
      ),
      settings.jmapAccountId,
      string(),
      String,
    ),
    jmapIdentityId: bindings.bind(
      option(
        ...jmapValueOptionNames.jmapIdentityId,
        string({ metavar: "VALUE" }),
        {
          description: message`JMAP sender identity ID; automatically discovered when absent.`,
        },
      ),
      settings.jmapIdentityId,
      string(),
      String,
    ),
    jmapBaseUrl: bindings.bind(
      option(
        ...jmapValueOptionNames.jmapBaseUrl,
        string({ metavar: "VALUE" }),
        {
          description: message`JMAP base origin for rewriting discovered endpoints.`,
        },
      ),
      settings.jmapBaseUrl,
      string(),
      String,
    ),
    jmapTimeout: bindings.bind(
      option(
        ...jmapValueOptionNames.jmapTimeout,
        string({ metavar: "VALUE" }),
        { description: message`JMAP HTTP request timeout in milliseconds.` },
      ),
      settings.jmapTimeout,
      string(),
      String,
    ),
    jmapSessionCacheTtl: bindings.bind(
      option(
        ...jmapValueOptionNames.jmapSessionCacheTtl,
        string({ metavar: "VALUE" }),
        { description: message`JMAP session cache lifetime in milliseconds.` },
      ),
      settings.jmapSessionCacheTtl,
      string(),
      String,
    ),
  };
}
