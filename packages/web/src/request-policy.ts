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

/** Validate authority and cookie-bearing server functions before body parsing.
 * @returns A request with its public URL restored, or an early rejection.
 */
export function prepareWebRequest(
  request: Request,
  publicOrigin: string,
): Request | Response {
  const origin = new URL(publicOrigin);
  let validated: URL | Response;
  try {
    validated = validateAuthority(request, origin);
  } catch {
    return new Response("Invalid request authority.", { status: 400 });
  }
  if (validated instanceof Response) return validated;
  const incoming = validated;
  let serverFunction: boolean;
  try {
    serverFunction = isServerFunctionPath(incoming.pathname, origin);
  } catch {
    return new Response("Invalid request path.", { status: 400 });
  }
  // SolidStart dispatches every pathname beginning with this prefix.
  if (serverFunction) {
    if (request.method !== "POST") {
      return new Response("Method not allowed.", {
        status: 405,
        headers: { allow: "POST" },
      });
    }
    if (!sameOriginSource(request.headers, origin)) {
      return new Response("Forbidden server function request.", {
        status: 403,
      });
    }
  }
  const target = new URL(incoming.href);
  target.protocol = origin.protocol;
  target.host = origin.host;
  const headers = new Headers(request.headers);
  headers.set("host", origin.host);
  for (const name of [
    "forwarded",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-forwarded-port",
    "x-forwarded-for",
  ]) {
    headers.delete(name);
  }
  const init: RequestInit & { duplex: "half" } = {
    method: request.method,
    headers,
    signal: request.signal,
    duplex: "half",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  return new Request(target, init);
}

function validateAuthority(request: Request, origin: URL): URL | Response {
  const incoming = new URL(request.url);
  if (
    !["http:", "https:"].includes(incoming.protocol) ||
    incoming.username ||
    incoming.password
  ) {
    throw new TypeError("Invalid request URL.");
  }
  const host = request.headers.get("host");
  if (
    host !== null &&
    authority(host, incoming.protocol) !==
      authority(incoming.host, incoming.protocol)
  ) {
    throw new TypeError("Inconsistent request authority.");
  }
  if (
    authority(host ?? incoming.host, origin.protocol) !==
    authority(origin.host, origin.protocol)
  ) {
    return new Response("Misdirected request.", { status: 421 });
  }
  return incoming;
}

function isServerFunctionPath(value: string, origin: URL): boolean {
  let path = value;
  let serverFunction = path.startsWith("/_server");
  for (let depth = 0; depth < 5; depth += 1) {
    const decoded = decodeURIComponent(path).replaceAll("\\", "/");
    if (decoded === path) break;
    path = decoded;
    serverFunction ||= path.startsWith("/_server");
    if (depth === 4) throw new TypeError("Ambiguous encoded path.");
  }
  return (
    serverFunction ||
    new URL(`/${path.replace(/^\/+/u, "")}`, origin).pathname.startsWith(
      "/_server",
    )
  );
}

function sameOriginSource(headers: Headers, origin: URL): boolean {
  const source = headers.get("origin");
  try {
    if (source === null) {
      const referer = headers.get("referer");
      if (referer === null) return false;
      const candidate = new URL(referer);
      return (
        candidate.origin === origin.origin &&
        !candidate.username &&
        !candidate.password
      );
    }
    const candidate = new URL(source);
    return (
      candidate.origin === origin.origin &&
      candidate.href === `${candidate.origin}/` &&
      !candidate.username &&
      !candidate.password
    );
  } catch {
    return false;
  }
}

function authority(value: string, protocol: string): string {
  if (value === "" || /[\s/\\?#@,%]/u.test(value)) {
    throw new TypeError("Invalid authority.");
  }
  const url = new URL(`${protocol}//${value}/`);
  if (url.username || url.password || url.pathname !== "/" || !url.hostname) {
    throw new TypeError("Invalid authority.");
  }
  url.hostname = url.hostname.replace(/\.$/u, "");
  return url.host;
}
