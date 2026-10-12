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

import { type Transport } from "@upyo/core";
import { type SesConfig, SesTransport } from "@upyo/ses";

import { createBoundedTransport } from "./bounded-mail-runtime.ts";
import { readSecretSource } from "./secret-source.ts";
import { type SesMailSettings, validateSesCredential } from "./ses-settings.ts";

/** Prepared SES credentials, after all selected file reads have settled. */
export interface PreparedSesMail {
  readonly transport: "ses";
  readonly connection: SesConfig;
}

/** Read only selected SES credentials before database writes.
 * @returns Connection settings after selected credential reads settle.
 */
export async function prepareSesMail(
  settings: SesMailSettings,
  signal?: AbortSignal,
): Promise<PreparedSesMail> {
  const auth = settings.authentication;
  const reads = await Promise.allSettled([
    readSecretSource(auth.accessKeyId, "SES access key ID", signal),
    readSecretSource(auth.secretAccessKey, "SES secret access key", signal),
    auth.type === "session"
      ? readSecretSource(auth.sessionToken, "SES session token", signal)
      : undefined,
  ]);
  signal?.throwIfAborted();
  for (const result of reads) {
    if (result.status === "rejected") throw result.reason;
  }
  const values = reads.map((result) =>
    result.status === "fulfilled" ? result.value : undefined,
  );
  const accessKeyId = values[0]!;
  const secretAccessKey = values[1]!;
  validateSesCredential(accessKeyId, "access key ID");
  validateSesCredential(secretAccessKey, "secret access key");
  const credentials = { accessKeyId, secretAccessKey };
  const authentication =
    auth.type === "session"
      ? { type: "session" as const, ...credentials, sessionToken: values[2]! }
      : { type: "credentials" as const, ...credentials };
  if (authentication.type === "session") {
    validateSesCredential(authentication.sessionToken, "session token");
  }
  return {
    transport: "ses",
    connection: {
      ...settings.connection,
      authentication,
      retries: 0,
      validateSsl: true,
    },
  };
}

/** Bound SES delivery without replaying uncertain submissions.
 * @returns An owned transport with whole-send deadlines and draining cleanup.
 */
export function createSesTransport(
  config: SesConfig,
): Transport<"ses"> & AsyncDisposable {
  return createBoundedTransport(
    new SesTransport({ ...config, retries: 0, validateSsl: true }),
    config.timeout ?? 30000,
    "SES",
  );
}
