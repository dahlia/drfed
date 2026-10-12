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

/** Own cleanup callbacks independently of the resources a caller borrows. */
export class ResourceOwner {
  readonly #cleanups: (() => void | Promise<void>)[] = [];
  #closing: Promise<void> | undefined;

  /**
   * Register a resource immediately after acquisition.
   * @returns The same resource, with cleanup registered only when owned.
   */
  register<T>(
    resource: T,
    dispose: (resource: T) => void | Promise<void>,
    options: { readonly owned: boolean },
  ): T {
    if (this.#closing != null) {
      throw new Error("Cannot register resources during cleanup.");
    }
    if (options.owned) this.#cleanups.push(() => dispose(resource));
    return resource;
  }

  /**
   * Close owned resources in reverse acquisition order, attempting every cleanup.
   * @returns One shared completion promise; cleanup failures are aggregated.
   */
  close(): Promise<void> {
    // Defer callbacks until the shared promise is assigned, including reentrancy.
    // oxlint-disable-next-line promise/prefer-await-to-then
    return (this.#closing ??= Promise.resolve().then(async () => {
      const errors: unknown[] = [];
      for (const dispose of this.#cleanups.splice(0).reverse()) {
        try {
          // oxlint-disable-next-line no-await-in-loop
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, "Resource cleanup failed.");
      }
      return undefined;
    }));
  }
}
