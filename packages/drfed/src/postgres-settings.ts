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

function validateQueryParameters(url: URL): void {
  const allowed = new Set(["sslmode", "search_path", "application_name"]);
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.has(key) || seen.has(key) || value.includes("\0")) {
      throw new Error("Invalid or unsupported PostgreSQL connection URL.");
    }
    seen.add(key);
  }
}

/**
 * Resolve the same single-host connection and TLS policy for both database drivers.
 * Unsupported URL features are rejected without opening a connection.
 * @returns Normalized URLs and explicit runtime transport options.
 */
export function resolvePostgresConnection(url: URL) {
  const invalid = () =>
    new Error("Invalid or unsupported PostgreSQL connection URL.");
  try {
    validateQueryParameters(url);
    const host = decodeURIComponent(url.hostname).replace(/^\[|\]$/gu, "");
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      [host, user, database].some((value) => !value || value.includes("\0")) ||
      host.includes(",") ||
      host.includes("/") ||
      url.hash ||
      decodeURIComponent(url.password).includes("\0") ||
      url.port === "0"
    ) {
      throw invalid();
    }
    const mode = url.searchParams.get("sslmode") ?? "disable";
    if (mode !== "disable" && mode !== "verify-full") throw invalid();
    const searchPath = url.searchParams.get("search_path") ?? "public";
    const applicationName = url.searchParams.get("application_name") ?? "drfed";
    if (!searchPath.trim() || !applicationName.trim()) throw invalid();
    const runtime = new URL(url.href);
    runtime.port = url.port || "5432";
    runtime.searchParams.set("sslmode", mode);
    runtime.searchParams.set("search_path", searchPath);
    runtime.searchParams.set("application_name", applicationName);
    const escaped = searchPath.replace(
      /(?<character>[\\\s])/gu,
      "\\$<character>",
    );
    return {
      runtimeUrl: runtime.href,
      options: `-csearch_path=${escaped}`,
      applicationName,
      password: decodeURIComponent(url.password),
      host,
      database,
      user,
      port: Number(runtime.port),
      tls: mode === "verify-full",
    };
  } catch {
    throw invalid();
  }
}
