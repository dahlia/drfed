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

import { randomUUID } from "node:crypto";

import type { Transport } from "@upyo/core";
import { type ResendConfig, ResendTransport } from "@upyo/resend";
import { RetryTransport } from "@upyo/retry";

import { createBoundedTransport } from "./bounded-mail-runtime.ts";

/** Keep one submission key across cancellable Resend retries.
 * @returns An owned transport with whole-delivery deadlines and draining cleanup.
 */
export function createResendTransport(
  config: ResendConfig,
): Transport<"resend"> & AsyncDisposable {
  const retries = new RetryTransport(
    new ResendTransport({ ...config, retries: 0, validateSsl: true }),
    {
      maxAttempts: (config.retries ?? 3) + 1,
      jitter: "none",
      backoff: { maxDelayMilliseconds: 10000 },
    },
  );
  const keyed: Transport<"resend"> & AsyncDisposable = {
    id: retries.id,
    send(message, options) {
      return retries.send(
        { ...message, idempotencyKey: message.idempotencyKey ?? randomUUID() },
        options,
      );
    },
    async *sendMany(messages, options) {
      for await (const message of messages) {
        yield await keyed.send(message, options);
      }
    },
    async [Symbol.asyncDispose]() {
      await retries[Symbol.asyncDispose]();
    },
  };
  return createBoundedTransport(keyed, config.timeout ?? 30000, "Resend");
}
