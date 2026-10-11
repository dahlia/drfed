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

import type { LettermintConfig } from "@upyo/lettermint";

import type { Sourced } from "./configuration.ts";
import type { RawMailOptions } from "./mail-parser.ts";
import { type SecretSource, resolveSecretSource } from "./secret-source.ts";

/** Selected API service configuration before secret files are opened. */
export interface ApiMailSettings {
  readonly transport: "lettermint";
  readonly connection: Omit<
    LettermintConfig,
    "apiToken" | "headers" | "tag" | "metadata" | "settings"
  >;
  readonly credential: SecretSource;
}

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

function credential(raw: RawMailOptions, cwd: string) {
  const variants = [
    ["mailApiKey", raw.mailApiKey, false],
    ["mailApiKeyFile", raw.mailApiKeyFile, true],
    ["lettermintApiToken", raw.lettermintApiToken, false],
    ["lettermintApiTokenFile", raw.lettermintApiTokenFile, true],
  ] as const;
  const highest = Math.max(...variants.map(([, input]) => rank(input)));
  if (highest < 0) throw new Error("Lettermint requires an API credential.");
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

function endpoint(input: Input) {
  if (input?.value === undefined) return "https://api.lettermint.co";
  try {
    const value = new URL(input.value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(value.hostname);
    if (
      (value.protocol !== "https:" && !(value.protocol === "http:" && local)) ||
      value.username !== "" ||
      value.password !== "" ||
      value.pathname !== "/" ||
      value.search !== "" ||
      value.hash !== ""
    ) {
      throw new Error();
    }
    return value.origin;
  } catch {
    throw new Error(
      "Invalid Lettermint base origin; use HTTPS or local loopback HTTP without credentials.",
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
    throw new Error(`Invalid Lettermint ${field}.`);
  }
  return value;
}

/** Resolve only the selected API service; credentials remain unopened.
 * @returns Prepared meaning, safe diagnostic values and effective source tags.
 */
export function resolveApiMailSettings(raw: RawMailOptions, cwd: string) {
  const auth = credential(raw, cwd);
  if (
    raw.lettermintRoute?.value === "" ||
    (raw.lettermintRoute?.value !== undefined &&
      /\p{Cc}/u.test(raw.lettermintRoute.value))
  ) {
    throw new Error("Invalid Lettermint route.");
  }
  const connection = {
    baseUrl: endpoint(raw.lettermintBaseUrl),
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
