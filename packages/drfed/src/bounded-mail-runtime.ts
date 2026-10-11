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

import {
  type Message,
  type Receipt,
  type Transport,
  type TransportOptions,
  createFailedReceipt,
} from "@upyo/core";

/** Bound an owned HTTP mail transport through response-body parsing.
 * @returns A transport owning its active sends and idempotent disposal.
 */
export function createBoundedTransport<T extends string>(
  sdk: Transport<T>,
  timeout: number,
  label: string,
): Transport<T> & AsyncDisposable {
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<Receipt<T>>>();
  let closing: Promise<void> | undefined;
  function send(message: Message, options?: TransportOptions) {
    if (closing !== undefined) {
      return Promise.reject(new Error(`${label} transport is closed.`));
    }
    const controller = new AbortController();
    const signal =
      options?.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const timer = setTimeout(
      () =>
        controller.abort(
          new DOMException(`${label} delivery timed out.`, "TimeoutError"),
        ),
      timeout,
    );
    timer.unref();
    controllers.add(controller);
    const work = (async () => {
      try {
        const receipt = await sdk.send(message, { signal });
        options?.signal?.throwIfAborted();
        controller.signal.throwIfAborted();
        return receipt;
      } catch (error) {
        options?.signal?.throwIfAborted();
        if (
          controller.signal.aborted &&
          controller.signal.reason instanceof DOMException &&
          controller.signal.reason.name === "TimeoutError"
        ) {
          return createFailedReceipt(`${label} delivery timed out.`, {
            provider: sdk.id,
            category: "timeout",
            retryable: false,
          });
        }
        throw error;
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
      }
    })();
    pending.add(work);
    const settled = () => {
      pending.delete(work);
    };
    // Both handlers settle normally; no detached rejection is created.
    // oxlint-disable-next-line promise/prefer-await-to-then
    void work.then(settled, settled);
    return work;
  }
  return {
    id: sdk.id,
    send,
    async *sendMany(
      messages: Iterable<Message> | AsyncIterable<Message>,
      options?: TransportOptions,
    ) {
      for await (const message of messages) yield await send(message, options);
    },
    [Symbol.asyncDispose]() {
      // Memoize before abort callbacks can reenter disposal.
      // oxlint-disable-next-line promise/prefer-await-to-then
      return (closing ??= Promise.resolve().then(async () => {
        for (const controller of controllers) {
          controller.abort(new Error(`${label} transport is closed.`));
        }
        await Promise.allSettled(pending);
        const disposable = sdk as Transport<T> & Partial<AsyncDisposable>;
        try {
          await disposable[Symbol.asyncDispose]?.();
        } catch {
          throw new Error("Mail transport cleanup failed.");
        }
        return undefined;
      }));
    },
  };
}
