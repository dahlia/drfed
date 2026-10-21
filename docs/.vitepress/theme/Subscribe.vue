<!--
DrFed: A web-based platform for developing and debugging ActivityPub apps
Copyright (C) 2026 DrFed team

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
-->

<script setup lang="ts">
import { openSubscriptionConfirmation } from "./buttondown.ts";
</script>

<template>
  <section id="subscribe" class="DrFedSubscribe">
    <div class="container">
      <div class="panel">
        <span class="eyebrow">Updates</span>
        <h2 class="title">Follow DrFed’s progress.</h2>
        <p class="lede">
          DrFed is still in development. Subscribe to hear about releases, early
          access, and progress along the way.
        </p>

        <form
          class="bd-form"
          action="https://buttondown.com/api/emails/embed-subscribe/drfed"
          method="post"
          target="popupwindow"
          @submit="openSubscriptionConfirmation"
        >
          <label class="visually-hidden" for="bd-email">Email address</label>
          <input
            id="bd-email"
            type="email"
            name="email"
            placeholder="you@example.com"
            autocomplete="email"
            required
          />
          <input type="hidden" name="embed" value="1" />
          <button type="submit">Subscribe</button>
        </form>

        <p class="fineprint">
          Occasional updates only; unsubscribe anytime. You can also follow
          <a href="https://hackers.pub/@drfed" rel="me"
            ><span class="handle">@drfed@hackers.pub</span></a
          >
          on the fediverse.
        </p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.DrFedSubscribe {
  margin-top: 48px;
  padding: 0 24px;
}

@media (min-width: 640px) {
  .DrFedSubscribe {
    padding: 0 48px;
  }
}

@media (min-width: 960px) {
  .DrFedSubscribe {
    margin-top: 64px;
    padding: 0 64px;
  }
}

.container {
  margin: 0 auto;
  max-width: 1152px;
}

.panel {
  border: 1px solid var(--vp-c-border);
  border-radius: 14px;
  padding: clamp(32px, 24px + 4vw, 64px) clamp(20px, 12px + 4vw, 64px);
  text-align: center;
  background: var(--vp-c-bg-soft);
}

.eyebrow {
  display: block;
  color: var(--vp-c-brand-1);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.title {
  margin-top: 12px;
  color: var(--vp-c-text-1);
  font-family: var(--drfed-font-serif);
  font-size: clamp(28px, 3.5vw, 36px);
  font-weight: 400;
  letter-spacing: -0.025em;
  line-height: 1.2;
}

.lede {
  margin: 16px auto 0;
  max-width: 34rem;
  color: var(--vp-c-text-2);
  line-height: 1.7;
}

.bd-form {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 12px;
  margin-top: 32px;
}

.bd-form input[type="email"] {
  flex: 1 1 18rem;
  max-width: 24rem;
  border: 1px solid var(--vp-c-border);
  border-radius: 999px;
  padding: 0.75em 1.1em;
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  font-size: 16px;
  transition:
    border-color 0.25s,
    box-shadow 0.25s;
}

.bd-form input[type="email"]::placeholder {
  color: var(--vp-c-text-3);
}

.bd-form input[type="email"]:focus {
  outline: none;
  border-color: var(--vp-c-brand-1);
  box-shadow: 0 0 0 3px var(--vp-c-brand-soft);
}

.bd-form button {
  flex: 0 0 auto;
  border: 1px solid var(--vp-button-brand-border);
  border-radius: 999px;
  padding: 0.75em 1.8em;
  background: var(--vp-button-brand-bg);
  color: var(--vp-button-brand-text);
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition:
    color 0.25s,
    background-color 0.25s;
}

.bd-form button:hover {
  background: var(--vp-button-brand-hover-bg);
  color: var(--vp-button-brand-hover-text);
}

.bd-form button:active {
  background: var(--vp-button-brand-active-bg);
  color: var(--vp-button-brand-active-text);
}

.bd-form button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}

.fineprint {
  margin-top: 24px;
  color: var(--vp-c-text-2);
  font-size: 14px;
}

.fineprint a {
  color: var(--vp-c-brand-1);
  font-weight: 500;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.fineprint a:hover {
  color: var(--vp-c-brand-2);
}

.handle {
  font-family: var(--vp-font-family-mono);
  font-size: 0.92em;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

@media (max-width: 32rem) {
  .bd-form input[type="email"],
  .bd-form button {
    flex-basis: 100%;
    max-width: none;
  }
}
</style>
