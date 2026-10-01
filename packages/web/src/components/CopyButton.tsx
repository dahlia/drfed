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

import { Show, createSignal, onCleanup } from "solid-js";

import styles from "~/styles/buttons.module.css";

/**
 * Copy a value to the clipboard and announce the result.
 * @returns A copy button with accessible feedback.
 */
export function CopyButton(props: { value: string; label: string }) {
  const [message, setMessage] = createSignal("");
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  let request = 0;
  const feedbackDuration = 2000;
  onCleanup(() => {
    request += 1;
    clearTimeout(resetTimer);
  });
  async function copy() {
    request += 1;
    const currentRequest = request;
    clearTimeout(resetTimer);
    setMessage("");
    try {
      await navigator.clipboard.writeText(props.value);
      if (currentRequest !== request) return;
      setMessage("Copied.");
      resetTimer = setTimeout(() => setMessage(""), feedbackDuration);
    } catch {
      if (currentRequest !== request) return;
      setMessage("Could not copy. Select and copy the text manually.");
    }
  }
  return (
    <span class={styles.copyControl}>
      <button
        type="button"
        onClick={() => {
          void copy();
        }}
        aria-label={`Copy ${props.label}`}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <Show
            when={message() === "Copied."}
            fallback={
              <>
                <rect x="8" y="8" width="12" height="12" rx="2" />
                <path d="M16 8V4H4v12h4" />
              </>
            }
          >
            <path d="m5 12 4 4L19 6" />
          </Show>
        </svg>
      </button>
      <output
        class={
          !message() || message() === "Copied." ? styles.srOnly : undefined
        }
      >
        {message()}
      </output>
    </span>
  );
}
