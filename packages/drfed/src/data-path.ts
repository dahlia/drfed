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

import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { env } from "node:process";

/**
 * Resolve an OS data location without creating directories or opening a store.
 * @returns The absolute persistent data directory for the selected platform.
 */
export function defaultPgliteDataPath(
  platform: NodeJS.Platform = process.platform,
  home = homedir(),
  environment: Readonly<Record<string, string | undefined>> = env,
): string {
  if (platform === "win32") {
    const local = environment.LOCALAPPDATA;
    return win32.join(
      local && win32.isAbsolute(local)
        ? local
        : win32.join(home, "AppData", "Local"),
      "DrFed",
      "data",
    );
  }
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "DrFed", "data");
  }
  const xdg = environment.XDG_DATA_HOME;
  return posix.join(
    xdg && posix.isAbsolute(xdg) ? xdg : posix.join(home, ".local", "share"),
    "drfed",
    "data",
  );
}
