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
// oxlint-disable no-console node/no-top-level-await
import { writeFile } from "node:fs/promises";
import process from "node:process";

import { schema } from "@drfed/graphql/schema";
import { printSchema } from "graphql";

// The mise task owns CLI parsing; this internal variable carries its output path.
const output = process.env.DRFED_SCHEMA_OUTPUT ?? "-";
const text = printSchema(schema);
if (output === "-") {
  process.stdout.write(`${text}\n`);
} else {
  await writeFile(output, text, "utf8");
}
