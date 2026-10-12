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

const migrationName = "20261011144453_record_object_snapshot";
const migrations = join(
  dirname(fileURLToPath(import.meta.resolve("@drfed/models/migrate"))),
  "..",
  "drizzle",
);

it("takes every remote object stored before the upgrade as fetched, and no delivery as having carried it", async () => {
  const baseline = await mkdtemp(join(tmpdir(), "drfed-object-migration-"));
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
    const insertResource = async (iri: string, kind: string) => {
      const id = uuidV7();
      await client.query(
        "INSERT INTO resources (id, iri, kind) VALUES ($1, $2, $3::resource_kind)",
        [id, iri, kind],
      );
      return id;
    };
    const insertActor = async (iri: string, local: boolean) => {
      const id = await insertResource(iri, "actor");
      if (local) {
        await client.query("INSERT INTO local_actors (id) VALUES ($1)", [id]);
      }
      await client.query(
        "INSERT INTO actors (id, type, instance_id, inbox_url, local_id, username) VALUES ($1, 'Person', $2, $3, $4, $5)",
        [
          id,
          instanceId,
          `${iri}/inbox`,
          local ? id : null,
          local ? "bob" : null,
        ],
      );
      return id;
    };
    const insertObject = async (actorId: string, name: string) => {
      const activityId = await insertResource(
        `https://remote.example/activities/${name}`,
        "activity",
      );
      const id = await insertResource(
        `https://remote.example/notes/${name}`,
        "object",
      );
      await client.query(
        "INSERT INTO objects (id, actor_id, activity_id, type, content_html) VALUES ($1, $2, $3, 'Note', 'content')",
        [id, actorId, activityId],
      );
      await client.query(
        "INSERT INTO activities (id, type, actor_id, object_id, published) VALUES ($1, 'Create', $2, $3, now())",
        [activityId, actorId, id],
      );
      return { id, activityId };
    };
    const remote = await insertObject(
      await insertActor("https://remote.example/users/alice", false),
      "remote",
    );
    const local = await insertObject(
      await insertActor("https://remote.example/users/bob", true),
      "local",
    );
    const deliveryId = uuidV7();
    await client.query(
      `INSERT INTO activity_deliveries (id, instance_id, direction, status, verification_result, inbox_url, activity_id, body, carried_snapshot, completed)
       VALUES ($1, $2, 'inbound', 'received', 'verified', 'https://local.example/inbox', $3, '\\x'::bytea, true, now())`,
      [deliveryId, instanceId, remote.activityId],
    );

    await migrate({ credentials: { driver: "pglite", client } });

    const { rows: objects } = await client.query<{
      id: string;
      fetched: boolean;
    }>("SELECT id, fetched FROM objects");
    assert.deepEqual(
      new Map(objects.map((row) => [row.id, row.fetched])),
      new Map([
        [remote.id, true],
        [local.id, false],
      ]),
    );
    const { rows: deliveries } = await client.query<{
      carried_snapshot: boolean;
      carried_object_snapshot: boolean;
      fetched_object: unknown;
    }>(
      "SELECT carried_snapshot, carried_object_snapshot, fetched_object FROM activity_deliveries",
    );
    assert.deepEqual(deliveries, [
      {
        carried_snapshot: true,
        carried_object_snapshot: false,
        fetched_object: null,
      },
    ]);
  } finally {
    await client.close();
    await rm(baseline, { recursive: true, force: true });
  }
});
