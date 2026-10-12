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

import type { SmtpConfig } from "@upyo/smtp";

/**
 * Normalize an SMTP URL without opening a connection or exposing credentials.
 * Authentication on smtp: requires STARTTLS; smtps: uses implicit TLS.
 * @returns Explicit Upyo settings with certificate verification enabled.
 */
export function resolveSmtpConnection(value: URL): SmtpConfig {
  if (
    !["smtp:", "smtps:"].includes(value.protocol) ||
    value.hostname === "" ||
    (value.pathname !== "" && value.pathname !== "/") ||
    value.search !== "" ||
    value.hash !== ""
  ) {
    throw new Error("Invalid SMTP connection URL.");
  }
  try {
    const host = new URL(`http://${value.host}`).hostname;
    const user = decodeURIComponent(value.username);
    const pass = decodeURIComponent(value.password);
    if (
      (pass !== "" && user === "") ||
      /[^\x20-\x7e]/u.test(user) ||
      /[^\x20-\x7e]/u.test(pass)
    ) {
      throw new Error();
    }
    const port =
      value.port === ""
        ? value.protocol === "smtps:"
          ? 465
          : 587
        : Number(value.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    const secure = value.protocol === "smtps:";
    return {
      host: host.startsWith("[") ? host.slice(1, -1) : host,
      port,
      secure,
      requireTls: !secure && user !== "",
      ...(user === "" ? {} : { auth: { user, pass } }),
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
    };
  } catch {
    throw new Error("Invalid SMTP connection URL.");
  }
}
