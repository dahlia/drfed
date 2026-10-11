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

import { fileURLToPath } from "node:url";

import { solidStart } from "@solidjs/start/config";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import { cjsInterop } from "vite-plugin-cjs-interop";
import relay from "vite-plugin-relay-lite";

import { developmentBridge } from "./dev-plugin.ts";

export default defineConfig(({ command }) => ({
  ssr: { external: ["@drfed/web/bridge"] },
  plugins: [
    developmentBridge(),
    solidStart(),
    nitro({
      preset: "node-server",
      devServer: { runner: "self" },
      entry: fileURLToPath(new URL("src/runtime-entry.mjs", import.meta.url)),
      rollupConfig: { external: ["@drfed/web/bridge"] },
    }),
    relay({ codegen: command !== "build" }),
    {
      ...cjsInterop({ dependencies: ["relay-runtime"] }),
      applyToEnvironment: (environment) => environment.name === "ssr",
    },
  ],
}));
