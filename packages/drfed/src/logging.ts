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

import { object } from "@optique/core/constructs";
import { message } from "@optique/core/message";
import type { InferValue } from "@optique/core/parser";
import { option } from "@optique/core/primitives";
import { string } from "@optique/core/valueparser";
import { type LogOutput, logLevel, textFormatter } from "@optique/logtape";

import {
  configurationPath,
  type createConfigurationBindings,
  configurationSettings as settings,
} from "./configuration.ts";

/** Logging option spellings shared by server and web command metadata. */
export const loggingValueOptionNames = {
  logLevel: ["--log-level", "-L"],
  logFormat: ["--log-format"],
  logOutput: ["--log-output"],
} as const;

/** Create the common server/web logging projection without opening outputs.
 * @returns Source-aware logging parsers.
 */
export function createLoggingParser(
  bindings: ReturnType<typeof createConfigurationBindings>,
) {
  const { bind } = bindings;
  const identity = (value: string) => value;
  const level = logLevel();
  const formatter = textFormatter();
  return object("Logging options", {
    level: bind(
      option(...loggingValueOptionNames.logLevel, level, {
        description: message`The lowest log level to record.`,
      }),
      settings.logLevel,
      level,
      identity,
      "info",
    ),
    format: bind(
      option(...loggingValueOptionNames.logFormat, formatter, {
        description: message`The log formatter.`,
      }),
      settings.logFormat,
      formatter,
      identity,
    ),
    output: bind(
      option(
        ...loggingValueOptionNames.logOutput,
        string({ metavar: "FILE" }),
        {
          description: message`Log output file. Use - for the console.`,
        },
      ),
      settings.logOutput,
      string(),
      identity,
      "-",
    ),
  });
}

type RawLoggingOptions = InferValue<ReturnType<typeof createLoggingParser>>;

/** Resolve log formatting and source-relative output paths without resources.
 * @returns Configuration accepted by Optique's LogTape integration.
 */
export function resolveLogging(raw: RawLoggingOptions, cwd = process.cwd()) {
  const outputSetting = raw.output;
  if (outputSetting?.value === undefined) {
    throw new Error("Missing log output.");
  }
  const output = outputSetting.value;
  if (output.trim() === "") throw new Error("Log output path cannot be empty.");
  const formatter = raw.format?.value;
  const logOutput: LogOutput =
    output === "-"
      ? { type: "console", ...(formatter === undefined ? {} : { formatter }) }
      : {
          type: "file",
          path: configurationPath(outputSetting, cwd),
          ...(formatter === undefined ? {} : { formatter }),
        };
  const level = raw.level?.value;
  if (level === undefined) throw new Error("Missing log level.");
  return { logLevel: level, logOutput };
}
