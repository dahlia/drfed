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

import type { SesConfig } from "@upyo/ses";

import type { Sourced } from "./configuration.ts";
import type { RawMailOptions } from "./mail-parser.ts";
import { type SecretSource, resolveSecretSource } from "./secret-source.ts";

type Input = Sourced<string | undefined> | undefined;
const priority = { default: 0, config: 1, env: 2, cli: 3 } as const;
const rank = (input: Input) =>
  input?.value === undefined ? -1 : priority[input.source];

/** SES connection settings before selected credential files are opened. */
export interface SesMailSettings {
  readonly transport: "ses";
  readonly connection: Omit<
    SesConfig,
    "authentication" | "headers" | "defaultTags" | "batchSize"
  >;
  readonly authentication: {
    readonly accessKeyId: SecretSource;
    readonly secretAccessKey: SecretSource;
  } & (
    | { readonly type: "credentials" }
    | { readonly type: "session"; readonly sessionToken: SecretSource }
  );
}

/** Validate credential bytes without including them in diagnostic errors. */
export function validateSesCredential(
  value: string,
  kind: "access key ID" | "secret access key" | "session token",
) {
  if (
    value === "" ||
    /[^\x21-\x7e]/u.test(value) ||
    (kind === "access key ID" && !/^[A-Za-z0-9]{1,128}$/u.test(value))
  ) {
    throw new Error(`Invalid SES ${kind}.`);
  }
}

function secret(
  literal: Input,
  file: Input,
  kind: Parameters<typeof validateSesCredential>[1],
  cwd: string,
) {
  const resolved = resolveSecretSource(literal, file, `SES ${kind}`, cwd);
  if (resolved === undefined) throw new Error(`SES requires a ${kind}.`);
  if (resolved.type === "literal") validateSesCredential(resolved.value, kind);
  return resolved;
}

function authenticationMode(raw: RawMailOptions): {
  type: "credentials" | "session";
  source: Input;
} {
  const token =
    rank(raw.sesSessionToken) >= rank(raw.sesSessionTokenFile)
      ? raw.sesSessionToken
      : raw.sesSessionTokenFile;
  if (rank(token) > rank(raw.sesAuth)) {
    return { type: "session" as const, source: token };
  }
  const type = raw.sesAuth?.value ?? "credentials";
  if (type !== "credentials" && type !== "session") {
    throw new Error("Invalid SES authentication mode.");
  }
  return { type, source: raw.sesAuth };
}

/** Resolve the selected SES branch without resource acquisition.
 * @returns Prepared meaning, effective source tags and redacted diagnostics.
 */
export function resolveSesSettings(raw: RawMailOptions, cwd: string) {
  const mode = authenticationMode(raw);
  const accessKeyId = secret(
    raw.sesAccessKeyId,
    raw.sesAccessKeyIdFile,
    "access key ID",
    cwd,
  );
  const secretAccessKey = secret(
    raw.sesSecretAccessKey,
    raw.sesSecretAccessKeyFile,
    "secret access key",
    cwd,
  );
  const sessionToken =
    mode.type === "session"
      ? secret(
          raw.sesSessionToken,
          raw.sesSessionTokenFile,
          "session token",
          cwd,
        )
      : undefined;
  const region = raw.sesRegion?.value ?? "us-east-1";
  if (
    region.length > 63 ||
    !/^[a-z]{2}(?:-[a-z]+)+-[1-9]\d*$/u.test(region) ||
    /^(?:cn-|us-iso|eu-isoe-)/u.test(region)
  ) {
    throw new Error("Invalid or unsupported SES region.");
  }
  const timeout = Number(raw.sesTimeout?.value ?? "30000");
  if (
    !/^\d+$/u.test(raw.sesTimeout?.value ?? "30000") ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 2147483647
  ) {
    throw new Error("Invalid SES delivery timeout.");
  }
  const mail: SesMailSettings = {
    transport: "ses",
    connection: { region, timeout, retries: 0, validateSsl: true },
    authentication:
      mode.type === "session"
        ? {
            type: mode.type,
            accessKeyId,
            secretAccessKey,
            sessionToken: sessionToken!,
          }
        : { type: mode.type, accessKeyId, secretAccessKey },
  };
  const selected = (literal: Input, file: Input) =>
    rank(literal) >= rank(file) ? [literal, undefined] : [undefined, file];
  const access = selected(raw.sesAccessKeyId, raw.sesAccessKeyIdFile);
  const secretKey = selected(
    raw.sesSecretAccessKey,
    raw.sesSecretAccessKeyFile,
  );
  const token =
    mode.type === "session"
      ? selected(raw.sesSessionToken, raw.sesSessionTokenFile)
      : [undefined, undefined];
  return {
    mail,
    sources: {
      sesAuth: mode.source,
      sesAccessKeyId: access[0],
      sesAccessKeyIdFile: access[1],
      sesSecretAccessKey: secretKey[0],
      sesSecretAccessKeyFile: secretKey[1],
      sesSessionToken: token[0],
      sesSessionTokenFile: token[1],
    },
    values: { sesAuth: mode.type, sesRegion: region, sesTimeout: timeout },
  };
}
