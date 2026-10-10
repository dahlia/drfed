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
import type { MigrationState } from "./migration-state.ts";

export type MigrationPreparationCode =
  | "invalid-options"
  | "invalid-migration-files"
  | "connection-failed"
  | "lock-timeout"
  | "aborted"
  | "inspection-failed"
  | "incompatible-history"
  | "migration-failed"
  | "cleanup-failed";

const explanations: Record<MigrationPreparationCode, string> = {
  "invalid-options": "Invalid migration preparation options.",
  "invalid-migration-files": "Could not verify the bundled migration files.",
  "connection-failed": "Could not maintain the migration database connection.",
  "lock-timeout": "Timed out waiting for the migration session lock.",
  aborted: "Migration preparation was aborted.",
  "inspection-failed":
    "Could not inspect migration history; check database permissions.",
  "incompatible-history":
    "Database migration history is incompatible with this package.",
  "migration-failed": "Could not apply database migrations.",
  "cleanup-failed": "Could not cleanly release the migration database session.",
};

/** Sanitized failure information; raw database errors and credentials are omitted. */
export class MigrationPreparationError extends Error {
  readonly code: MigrationPreparationCode;
  readonly state: MigrationState | undefined;
  readonly cleanupFailed: boolean;

  constructor(
    code: MigrationPreparationCode,
    state?: MigrationState,
    cleanupFailed = false,
  ) {
    super(explanations[code]);
    this.name = "MigrationPreparationError";
    this.code = code;
    this.state = state;
    this.cleanupFailed = cleanupFailed;
  }
}
