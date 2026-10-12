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

import type { JmapConfig } from "@upyo/jmap";

import type { Sourced } from "./configuration.ts";
import type { RawMailOptions } from "./mail-parser.ts";
import { type SecretSource, resolveSecretSource } from "./secret-source.ts";

/** JMAP connection with selected but unopened credential files. */
export interface JmapSettings {
  readonly transport: "jmap";
  readonly connection: Omit<
    JmapConfig,
    "bearerToken" | "basicAuth" | "headers"
  >;
  readonly authentication: {
    readonly type: "bearer" | "basic";
    readonly secret: SecretSource;
    readonly user?: string;
  };
}

type Input = Sourced<string | undefined> | undefined;
const priorities = { default: 0, config: 1, env: 2, cli: 3 } as const;
const rank = (input: Input) =>
  input?.value === undefined ? -1 : priorities[input.source];

function endpoint(input: Input, field: string, required = false) {
  if (input?.value === undefined && !required) return undefined;
  try {
    const value = new URL(input?.value ?? "");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(value.hostname);
    if (
      (value.protocol !== "https:" && !(value.protocol === "http:" && local)) ||
      value.username !== "" ||
      value.password !== "" ||
      value.hash !== ""
    ) {
      throw new Error();
    }
    if (
      field === "base URL" &&
      (value.pathname !== "/" || value.search !== "")
    ) {
      throw new Error();
    }
    return field === "base URL" ? value.origin : value.href;
  } catch {
    throw new Error(
      `Invalid JMAP ${field}; use HTTPS or local loopback HTTP without credentials.`,
    );
  }
}

function number(
  input: Input,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
) {
  if (input?.value === undefined) return fallback;
  const value = Number(input.value);
  if (
    !/^\d+$/u.test(input.value) ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`Invalid JMAP ${field}.`);
  }
  return value;
}

/** Validate credentials without including their contents in error messages. */
export function validateJmapCredential(
  type: "bearer" | "basic",
  credential: string,
  user?: string,
) {
  if (type === "bearer") {
    if (credential === "" || /[^\x21-\x7e]/u.test(credential)) {
      throw new Error("Invalid JMAP bearer authentication.");
    }
  } else if (
    user === undefined ||
    user === "" ||
    user.includes(":") ||
    /[^\x20-\x7e]/u.test(user) ||
    /[^\x20-\x7e]/u.test(credential)
  ) {
    throw new Error(
      "Invalid JMAP basic authentication; the pinned SDK requires printable ASCII credentials.",
    );
  }
}

function authentication(raw: RawMailOptions, cwd: string) {
  const bearerRank = Math.max(
    rank(raw.jmapBearerToken),
    rank(raw.jmapBearerTokenFile),
  );
  const passwordRank = Math.max(
    rank(raw.jmapPassword),
    rank(raw.jmapPasswordFile),
  );
  if (bearerRank < 0 && passwordRank < 0) {
    throw new Error("JMAP requires a bearer token or basic authentication.");
  }
  if (bearerRank === passwordRank) {
    throw new Error(
      "JMAP authentication variants at the same source disagree.",
    );
  }
  const bearer = bearerRank > passwordRank;
  const secret = resolveSecretSource(
    bearer ? raw.jmapBearerToken : raw.jmapPassword,
    bearer ? raw.jmapBearerTokenFile : raw.jmapPasswordFile,
    "JMAP authentication",
    cwd,
  );
  if (secret === undefined) throw new Error("Missing JMAP credential.");
  const user = bearer ? undefined : raw.jmapUser?.value;
  if (!bearer && (user === undefined || user === "")) {
    throw new Error("JMAP basic authentication requires a username.");
  }
  if (!bearer) validateJmapCredential("basic", "", user);
  if (secret.type === "literal") {
    validateJmapCredential(bearer ? "bearer" : "basic", secret.value, user);
  }
  return {
    type: bearer ? ("bearer" as const) : ("basic" as const),
    secret,
    ...(user === undefined ? {} : { user }),
  };
}

function authenticationSources(
  raw: RawMailOptions,
  auth: JmapSettings["authentication"],
) {
  const literal = auth.secret.type === "literal";
  return {
    jmapUser: auth.type === "basic" ? raw.jmapUser : undefined,
    jmapBearerToken:
      auth.type === "bearer" && literal ? raw.jmapBearerToken : undefined,
    jmapBearerTokenFile:
      auth.type === "bearer" && !literal ? raw.jmapBearerTokenFile : undefined,
    jmapPassword:
      auth.type === "basic" && literal ? raw.jmapPassword : undefined,
    jmapPasswordFile:
      auth.type === "basic" && !literal ? raw.jmapPasswordFile : undefined,
  };
}

/** Resolve only the selected JMAP branch, retaining safe source metadata.
 * @returns Provider settings and safe diagnostic values/source tags.
 */
export function resolveJmapSettings(raw: RawMailOptions, cwd: string) {
  const auth = authentication(raw, cwd);
  for (const input of [raw.jmapAccountId, raw.jmapIdentityId]) {
    if (
      input?.value === "" ||
      (input?.value !== undefined && /\p{Cc}/u.test(input.value))
    ) {
      throw new Error("Invalid JMAP account or identity ID.");
    }
  }
  const baseUrl = endpoint(raw.jmapBaseUrl, "base URL");
  const connection = {
    sessionUrl: endpoint(raw.jmapSessionUrl, "session URL", true)!,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(raw.jmapAccountId?.value === undefined
      ? {}
      : { accountId: raw.jmapAccountId.value }),
    ...(raw.jmapIdentityId?.value === undefined
      ? {}
      : { identityId: raw.jmapIdentityId.value }),
    timeout: number(raw.jmapTimeout, 30_000, 1, 2_147_483_647, "timeout"),
    retries: 0,
    sessionCacheTtl: number(
      raw.jmapSessionCacheTtl,
      300_000,
      1,
      2_147_483_647,
      "session cache lifetime",
    ),
  };
  const values = {
    jmapSessionUrl: connection.sessionUrl,
    jmapBaseUrl: connection.baseUrl,
    jmapAccountId: connection.accountId,
    jmapIdentityId: connection.identityId,
    jmapTimeout: connection.timeout,
    jmapSessionCacheTtl: connection.sessionCacheTtl,
  };
  const sources = authenticationSources(raw, auth);
  const mail: JmapSettings = {
    transport: "jmap",
    connection,
    authentication: auth,
  };
  return { mail, values, sources };
}
