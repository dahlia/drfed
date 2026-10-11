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
// Keep the upgrade scenario and ordered writes together.
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import { migrate } from "@drfed/models";
import { uuidV7 } from "@drfed/models/uuid";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as migrateBaseline } from "drizzle-orm/pglite/migrator";

const migrationName = "20261010111648_record_delivery_snapshot";
const migrations = join(
  dirname(fileURLToPath(import.meta.resolve("@drfed/models/migrate"))),
  "..",
  "drizzle",
);

it("marks the deliveries linked before the upgrade that carried their stored activity", async () => {
  const baseline = await mkdtemp(join(tmpdir(), "drfed-snapshot-migration-"));
  const client = new PGlite();
  try {
    const entries = await readdir(migrations, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name < migrationName)
        .map((entry) =>
          cp(join(migrations, entry.name), join(baseline, entry.name), {
            recursive: true,
          }),
        ),
    );
    await migrateBaseline(drizzle({ client }), { migrationsFolder: baseline });
    const instanceId = uuidV7();
    await client.query("INSERT INTO instances (id, host) VALUES ($1, $2)", [
      instanceId,
      "remote.example",
    ]);
    const actorId = uuidV7();
    const actorIri = "https://remote.example/users/alice";
    await client.query(
      "INSERT INTO resources (id, iri, kind) VALUES ($1, $2, 'actor')",
      [actorId, actorIri],
    );
    await client.query(
      "INSERT INTO actors (id, type, instance_id, inbox_url) VALUES ($1, 'Person', $2, $3)",
      [actorId, instanceId, `${actorIri}/inbox`],
    );
    const insertActivity = async (iri: string, document: string) => {
      const id = uuidV7();
      await client.query(
        "INSERT INTO resources (id, iri, kind) VALUES ($1, $2, 'activity')",
        [id, iri],
      );
      await client.query(
        "INSERT INTO activities (id, type, actor_id, published, document) VALUES ($1, 'Create', $2, now(), $3::json)",
        [id, actorId, document],
      );
      return id;
    };
    const activityIri = "https://remote.example/activities/1";
    const document = {
      id: activityIri,
      type: "Create",
      actor: actorIri,
      object: { type: "Note", content: "original" },
    };
    const activityId = await insertActivity(
      activityIri,
      JSON.stringify(document),
    );
    // PostgreSQL's json holds U+0000, which jsonb does not.
    const unstorableIri = "https://remote.example/activities/2";
    const unstorableId = await insertActivity(
      unstorableIri,
      JSON.stringify({ ...document, id: unstorableIri, summary: "\0" }),
    );
    const insertDelivery = async (
      direction: "inbound" | "outbound",
      linkedId: string | null,
      payload: string | null,
    ) => {
      const id = uuidV7();
      await client.query(
        `INSERT INTO activity_deliveries (id, instance_id, direction, status, verification_result, inbox_url, activity_id, body, payload, completed)
         VALUES ($1, $2, $3::activity_delivery_direction, CASE WHEN $3 = 'inbound' THEN 'received' ELSE 'sent' END::activity_delivery_status, CASE WHEN $3 = 'inbound' THEN 'verified' END::activity_delivery_verification_result, 'https://local.example/inbox', $4, CASE WHEN $3 = 'inbound' THEN '\\x'::bytea END, $5::jsonb, now())`,
        [id, instanceId, direction, linkedId, payload],
      );
      return id;
    };
    const carrying = [
      await insertDelivery("inbound", activityId, JSON.stringify(document)),
      // Member order is not part of the document.
      await insertDelivery(
        "inbound",
        activityId,
        JSON.stringify(
          Object.fromEntries(Object.entries(document).toReversed()),
        ),
      ),
    ];
    const other = [
      await insertDelivery(
        "inbound",
        activityId,
        JSON.stringify({
          ...document,
          object: { type: "Note", content: "other" },
        }),
      ),
      await insertDelivery("inbound", activityId, null),
      await insertDelivery("inbound", activityId, "null"),
      await insertDelivery("inbound", null, JSON.stringify(document)),
      await insertDelivery("inbound", unstorableId, JSON.stringify(document)),
      await insertDelivery("outbound", activityId, JSON.stringify(document)),
    ];

    await migrate({ credentials: { driver: "pglite", client } });

    const { rows } = await client.query<{
      id: string;
      carried_snapshot: boolean;
    }>("SELECT id, carried_snapshot FROM activity_deliveries");
    assert.deepEqual(
      new Map(rows.map((row) => [row.id, row.carried_snapshot])),
      new Map([
        ...carrying.map((id) => [id, true] as const),
        ...other.map((id) => [id, false] as const),
      ]),
    );
  } finally {
    await client.close();
    await rm(baseline, { recursive: true, force: true });
  }
});
