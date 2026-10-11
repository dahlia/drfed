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

import path from "node:path";
import { pathToFileURL } from "node:url";

import { type Plugin, loadEnv } from "vite";

import type {
  WebRuntimeOptions,
  installDevelopmentWebBinding,
  prepareWebRequest,
} from "./src/bridge.ts";

/** Set up the external binding before Vite handles any SSR requests.
 * @returns The development-only bootstrap plugin.
 */
export function developmentBridge(): Plugin {
  return {
    name: "drfed-development-bridge",
    apply: "serve",
    async configureServer(server) {
      const moduleUrl = pathToFileURL(
        path.resolve(server.config.root, "dist/bridge.mjs"),
      ).href;
      const bridge: unknown = await import(moduleUrl);
      if (!isBridge(bridge)) {
        throw new Error("Missing development bridge.");
      }
      const env = loadEnv(server.config.mode, server.config.envDir, "DRFED_");
      const publicOrigin = new URL(
        env.DRFED_PUBLIC_ORIGIN ?? "http://localhost:3000",
      );
      const backendOrigin = new URL(
        env.DRFED_BACKEND_URL ?? "http://drfed.localhost:8888",
      );
      const options: WebRuntimeOptions = {
        publicOrigin,
        graphqlFetch(request): Response | Promise<Response> {
          const init: RequestInit & { duplex: "half" } = {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: request.signal,
            duplex: "half",
          };
          return fetch(new Request(new URL("/graphql", backendOrigin), init));
        },
      };
      const owner = bridge.installDevelopmentWebBinding(options);
      server.middlewares.use((request, response, next) => {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined) {
              headers.set(
                name,
                Array.isArray(value) ? value.join(", ") : value,
              );
            }
          }
          const incoming = new Request(
            new URL(request.url ?? "/", `http://${headers.get("host") ?? ""}`),
            { method: request.method ?? "GET", headers },
          );
          const prepared = bridge.prepareWebRequest(incoming);
          if (prepared instanceof Response) {
            response.statusCode = prepared.status;
            for (const [name, value] of prepared.headers) {
              response.setHeader(name, value);
            }
            response.end(prepared.statusText);
            return;
          }
        } catch {
          response.statusCode = 400;
          response.end("Invalid web request.");
          return;
        }
        next();
      });
      server.httpServer?.once("close", () => {
        void owner.close();
      });
    },
  };
}

function isBridge(value: unknown): value is {
  installDevelopmentWebBinding: typeof installDevelopmentWebBinding;
  prepareWebRequest: typeof prepareWebRequest;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "installDevelopmentWebBinding" in value &&
    typeof value.installDevelopmentWebBinding === "function" &&
    "prepareWebRequest" in value &&
    typeof value.prepareWebRequest === "function"
  );
}
