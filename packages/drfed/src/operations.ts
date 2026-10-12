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

/** Track asynchronous work so shutdown can refuse new work and await existing work. */
export class OperationRegistry {
  readonly #abort = new AbortController();
  readonly #active = new Set<Promise<unknown>>();

  /**
   * A shared cancellation signal for operations owned by this registry.
   * @returns The cancellation signal shared by registered operations.
   */
  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  /**
   * Register before invoking an operation, including operations that reject.
   * @returns The operation's result; the caller remains responsible for errors.
   */
  run<T>(operation: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
    if (this.signal.aborted) return Promise.reject(this.signal.reason);
    return this.track((signal) => {
      signal.throwIfAborted();
      return operation(signal);
    });
  }

  /**
   * Track a continuation of work already admitted by the runtime.
   * The caller must prevent new requests and stop background producers before
   * draining. Continuations remain allowed so accepted requests can finish.
   * @returns The continuation's result; the caller remains responsible for errors.
   */
  track<T>(operation: (signal: AbortSignal) => T | Promise<T>): Promise<T> {
    // Register first so reentrant shutdown cannot miss the operation.
    // oxlint-disable-next-line promise/prefer-await-to-then
    const task = Promise.resolve().then(() => operation(this.signal));
    this.#active.add(task);
    const forget = () => {
      this.#active.delete(task);
    };
    // Both handlers resolve; tracking must not create an unhandled rejection.
    // oxlint-disable-next-line promise/prefer-await-to-then
    void task.then(forget, forget);
    return task;
  }

  /** Refuse new work and signal existing operations to stop. */
  abort(): void {
    this.#abort.abort();
  }

  /**
   * Abort and await all registered work, even if an operation rejected.
   * @returns Completion after every active operation has settled.
   */
  async drain(): Promise<void> {
    this.abort();
    // Existing requests may register their next resolver while draining.
    // oxlint-disable-next-line no-unmodified-loop-condition
    while (this.#active.size > 0) {
      // oxlint-disable-next-line no-await-in-loop
      await Promise.allSettled([...this.#active]);
    }
  }
}
