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

// Deliveries and viewers are walked in turn against the same stored rows.
// oxlint-disable no-await-in-loop

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type Database, linkInboundActivity, schema } from "@drfed/models";
import type { Uuid } from "@drfed/models/uuid";
import { InProcessMessageQueue } from "@fedify/fedify";
import { eq } from "drizzle-orm";

import { withTestHarness } from "../harness.test.ts";
import { accepted, globalId, localActorId } from "../seed.test.ts";
import {
  type Documents,
  PUBLIC,
  type Signer,
  addActor,
  createOf,
  createRecorder,
  eventually,
  findDeliveries,
  hostA,
  hostB,
  hostC,
  idOf,
  read,
  seedAccount,
  seedOtherInstance,
  seedViewers,
  signed,
  thirdInstanceId,
  withWorkers,
} from "./inbox-fixture.test.ts";

const aliceIri = "https://remote.example/users/alice";
const direct = {
  to: [`https://${hostA}/users/${localActorId}`],
  cc: [],
};
const everyone = { to: [PUBLIC], cc: [] };
const noteIri = (name: string): string =>
  `https://remote.example/notes/${name}`;
const activityIri = (name: string): string =>
  `https://remote.example/activities/${name}`;
const contentOf = (name: string): string => `<p>${name}</p>`;

/** @returns A note served from its IRI, as a remote server would. */
const noteOf = (
  name: string,
  addressing: Record<string, unknown>,
  content = contentOf(name),
) => ({
  "@context": "https://www.w3.org/ns/activitystreams",
  id: noteIri(name),
  type: "Note",
  attributedTo: aliceIri,
  content,
  published: "2026-10-01T00:00:00Z",
  ...addressing,
});

/** @returns Every delivery, once each so far is linked and handled. */
const settled = (db: Database, count: number) =>
  eventually(
    () => findDeliveries(db),
    (rows) =>
      rows.length === count &&
      rows.every(
        (row) => row.activityId != null && row.status !== "acknowledged",
      ),
  );

/**
 * Send a signed `Create` to an inbox host and wait for it to settle.
 * @returns How many deliveries there are now.
 */
async function deliver(
  db: Database,
  send: (request: Request) => Promise<Response>,
  alice: Signer,
  body: unknown,
  host: string | undefined,
  count: number,
): Promise<number> {
  assert.equal((await send(await signed(alice, body, host))).status, 202);
  await settled(db, count + 1);
  return count + 1;
}

/**
 * Seed the viewers, one more of an instance that never receives anything.
 * @returns The request options of each, `undefined` being anonymous.
 */
async function seedAllViewers(db: Database) {
  const viewers = await seedViewers(db);
  await seedOtherInstance(db, {
    id: thirdInstanceId,
    slug: "third-instance",
    host: hostC,
  });
  return {
    anonymous: undefined,
    stranger: viewers.stranger,
    third: await seedAccount(db, "third", {
      member: { instanceId: thirdInstanceId, accepted },
    }),
    receiverA: viewers.member,
    receiverB: viewers.other,
    admin: viewers.admin,
  };
}
type ViewerName = keyof Awaited<ReturnType<typeof seedAllViewers>>;

/** What instance B fetched of a fetched object after instance A stored it. */
type Refetch = "same" | "other" | "none";
interface Case {
  readonly name: string;
  readonly fetched: boolean;
  readonly publicCarrier: boolean;
  readonly publicObject: boolean;
  readonly refetch: Refetch;
}

const cases: readonly Case[] = [false, true]
  .flatMap((fetched) =>
    [false, true].flatMap((publicCarrier) =>
      [false, true].flatMap((publicObject) =>
        (fetched
          ? (["same", "other", "none"] as const)
          : (["same"] as const)
        ).map((refetch) => ({ fetched, publicCarrier, publicObject, refetch })),
      ),
    ),
  )
  .map((rest, index) => ({ ...rest, name: `${index + 1}` }));

/** @returns Whether the viewer may read the object of the scenario. */
function expectReadable(viewer: ViewerName, scenario: Case): boolean {
  if (viewer === "admin" || scenario.publicObject) return true;
  if (!scenario.fetched && scenario.publicCarrier) return true;
  if (viewer === "receiverA") return true;
  if (viewer === "receiverB") {
    return !scenario.fetched || scenario.refetch === "same";
  }
  return false;
}

/**
 * @returns Whether the viewer reads the carrier itself, which B received as A
 *          did.
 */
const expectActivity = (viewer: ViewerName, scenario: Case): boolean =>
  scenario.publicCarrier ||
  viewer === "admin" ||
  viewer === "receiverA" ||
  viewer === "receiverB";

const surfacesQuery = `
  query ($activities: [ID!]!, $objects: [ID!]!, $actor: ID!) {
    activities: nodes(ids: $activities) {
      ... on Activity {
        object { detail { ... on Object { contentHtml } } }
        expectedClassifications { implementation }
      }
    }
    objects: nodes(ids: $objects) { ... on Object { contentHtml } }
    actor: node(id: $actor) {
      ... on Actor {
        objects(first: 50) { totalCount edges { node { contentHtml } } }
      }
    }
  }
`;

const expectedSurfaces = (viewer: ViewerName) => {
  const readable = cases.filter((scenario) => expectReadable(viewer, scenario));
  return {
    activities: cases.map((scenario) =>
      expectActivity(viewer, scenario)
        ? {
            object: expectReadable(viewer, scenario)
              ? { detail: { contentHtml: contentOf(scenario.name) } }
              : null,
            expectedClassifications: expectReadable(viewer, scenario)
              ? [{ implementation: "MASTODON" }, { implementation: "MISSKEY" }]
              : [],
          }
        : null,
    ),
    objects: cases.map((scenario) =>
      expectReadable(viewer, scenario)
        ? { contentHtml: contentOf(scenario.name) }
        : null,
    ),
    actor: {
      objects: {
        totalCount: readable.length,
        edges: readable.map((scenario) => contentOf(scenario.name)).toSorted(),
      },
    },
  };
};

/** @returns The data, the connection's edges sorted as order is untested. */
const normalized = (data: Record<string, unknown>) => {
  const { objects } = data.actor as {
    objects: { totalCount: number; edges: { node: { contentHtml: string } }[] };
  };
  return {
    ...data,
    actor: {
      objects: {
        totalCount: objects.totalCount,
        edges: objects.edges.map(({ node }) => node.contentHtml).toSorted(),
      },
    },
  };
};

const marksOf = async (db: Database, id: Uuid) =>
  await db.query.activityDeliveries.findMany({
    columns: { carriedSnapshot: true, carriedObjectSnapshot: true },
    where: { activityId: id },
    orderBy: { created: "asc", id: "asc" },
  });

describe("Reading an object by the activity that carried it", () => {
  it("opens a fetched object neither by a public carrier nor by a delivery that fetched it otherwise", async () => {
    for (const queued of [false, true]) {
      await withTestHarness(async ({ db, post: graphql }) => {
        const viewers = await seedAllViewers(db);
        const documents: Documents = new Map();
        const alice = await addActor(documents, aliceIri);
        const { federation, send } = await createRecorder(
          db,
          documents,
          queued ? { queue: new InProcessMessageQueue() } : {},
        );
        await withWorkers(federation, async () => {
          let count = 0;
          for (const scenario of cases) {
            const carrier = scenario.publicCarrier ? everyone : direct;
            const addressing = scenario.publicObject ? everyone : direct;
            if (scenario.fetched) {
              documents.set(
                noteIri(scenario.name),
                noteOf(scenario.name, addressing),
              );
            }
            const body = createOf(alice.iri, scenario.name, {
              activity: carrier,
              object: scenario.fetched ? noteIri(scenario.name) : addressing,
            });
            count = await deliver(db, send, alice, body, undefined, count);
            if (scenario.refetch === "other") {
              documents.set(
                noteIri(scenario.name),
                noteOf(scenario.name, addressing, "<p>REDACTED</p>"),
              );
            } else if (scenario.refetch === "none") {
              documents.delete(noteIri(scenario.name));
            }
            count = await deliver(db, send, alice, body, hostB, count);
          }
        });
        const variables = {
          activities: await Promise.all(
            cases.map(async (scenario) =>
              globalId("Activity", await idOf(db, activityIri(scenario.name))),
            ),
          ),
          objects: await Promise.all(
            cases.map(async (scenario) =>
              globalId("Object", await idOf(db, noteIri(scenario.name))),
            ),
          ),
          actor: globalId("Actor", await idOf(db, aliceIri)),
        };
        for (const [name, init] of Object.entries(viewers)) {
          assert.deepEqual(
            normalized(await read(graphql, surfacesQuery, variables, init)),
            expectedSurfaces(name as ViewerName),
            `queued: ${queued}, viewer: ${name}`,
          );
        }
      });
    }
  });

  it("never widens a fetched object by a later public activity or a tampered duplicate", async () => {
    await withTestHarness(async ({ db, post: graphql }) => {
      const viewers = await seedAllViewers(db);
      const documents: Documents = new Map();
      const alice = await addActor(documents, aliceIri);
      const { send } = await createRecorder(db, documents);
      documents.set(noteIri("1"), noteOf("1", direct));
      const first = createOf(alice.iri, "1", {
        activity: direct,
        object: noteIri("1"),
      });
      let count = await deliver(db, send, alice, first, undefined, 0);
      // A later public activity refers to the same object by its IRI.
      const later = createOf(alice.iri, "2", {
        activity: everyone,
        object: noteIri("1"),
      });
      count = await deliver(db, send, alice, later, hostB, count);
      // The same activity IRI, as fetched as stored, in another envelope.
      const tampered = { ...first, summary: "tampered" };
      await deliver(db, send, alice, tampered, hostC, count);
      const query = `
        query ($object: ID!) { object: node(id: $object) { id } }
      `;
      const variables = {
        object: globalId("Object", await idOf(db, noteIri("1"))),
      };
      for (const [name, init] of Object.entries(viewers)) {
        const readable = name === "receiverA" || name === "admin";
        assert.deepEqual(
          await read(graphql, query, variables, init),
          { object: readable ? { id: variables.object } : null },
          `viewer: ${name}`,
        );
      }
      assert.deepEqual(await marksOf(db, await idOf(db, activityIri("1"))), [
        { carriedSnapshot: true, carriedObjectSnapshot: true },
        { carriedSnapshot: false, carriedObjectSnapshot: false },
      ]);
    });
  });

  it("keeps an object conservatively marked as fetched closed without another grant", async () => {
    await withTestHarness(async ({ db, post: graphql }) => {
      const viewers = await seedAllViewers(db);
      const documents: Documents = new Map();
      const alice = await addActor(documents, aliceIri);
      const { send } = await createRecorder(db, documents);
      const body = createOf(alice.iri, "1", {
        activity: everyone,
        object: direct,
      });
      await deliver(db, send, alice, body, undefined, 0);
      const objectId = await idOf(db, noteIri("1"));
      const query = `
        query ($object: ID!) { object: node(id: $object) { id } }
      `;
      const variables = { object: globalId("Object", objectId) };
      assert.deepEqual(await read(graphql, query, variables), {
        object: { id: variables.object },
      });
      // As the migration that added the marks left a row stored before it.
      await db
        .update(schema.objects)
        .set({ fetched: true })
        .where(eq(schema.objects.id, objectId));
      await db
        .update(schema.activityDeliveries)
        .set({ carriedObjectSnapshot: false });
      for (const [name, init] of Object.entries(viewers)) {
        assert.deepEqual(
          await read(graphql, query, variables, init),
          { object: name === "admin" ? { id: variables.object } : null },
          `viewer: ${name}`,
        );
      }
    });
  });

  it("closes an object whose carrier row is gone until a carrier is linked again", async () => {
    await withTestHarness(async ({ db, post: graphql }) => {
      const viewers = await seedAllViewers(db);
      const documents: Documents = new Map();
      const alice = await addActor(documents, aliceIri);
      const { send } = await createRecorder(db, documents);
      const bodies = [
        createOf(alice.iri, "1", { activity: direct, object: direct }),
        createOf(alice.iri, "2", { activity: everyone, object: direct }),
      ];
      let count = 0;
      for (const body of bodies) {
        count = await deliver(db, send, alice, body, undefined, count);
      }
      const query = `
        query ($objects: [ID!]!, $actor: ID!) {
          objects: nodes(ids: $objects) { ... on Object { contentHtml } }
          actor: node(id: $actor) { ... on Actor { objects { totalCount } } }
        }
      `;
      const variables = {
        objects: [
          globalId("Object", await idOf(db, noteIri("1"))),
          globalId("Object", await idOf(db, noteIri("2"))),
        ],
        actor: globalId("Actor", await idOf(db, aliceIri)),
      };
      const sees = (one: boolean, two: boolean) => ({
        objects: [
          one ? { contentHtml: contentOf("1") } : null,
          two ? { contentHtml: contentOf("2") } : null,
        ],
        actor: { objects: { totalCount: Number(one) + Number(two) } },
      });
      const assertSeen = async (
        expected: Partial<Record<ViewerName, readonly [boolean, boolean]>>,
        when: string,
      ) => {
        for (const [name, init] of Object.entries(viewers)) {
          const [one, two] = expected[name as ViewerName] ?? [false, false];
          assert.deepEqual(
            await read(graphql, query, variables, init),
            sees(one, two),
            `${when}, viewer: ${name}`,
          );
        }
      };
      const carriers = await Promise.all(
        ["1", "2"].map(async (name) => {
          const id = await idOf(db, activityIri(name));
          const row = await db.query.activities.findFirst({ where: { id } });
          assert.ok(row != null);
          return row;
        }),
      );
      const deleteCarriers = async () => {
        for (const { id } of carriers) {
          await db
            .delete(schema.activities)
            .where(eq(schema.activities.id, id));
        }
      };
      const restoreCarrier = async (index: number, document: unknown) => {
        const row = carriers[index];
        assert.ok(row != null);
        await db.insert(schema.activities).values({ ...row, document });
        const deliveries = await db.query.activityDeliveries.findMany({
          where: { activityIri: activityIri(`${index + 1}`) },
        });
        for (const delivery of deliveries) {
          assert.equal(await linkInboundActivity(db, delivery.id), true);
        }
      };

      const everyoneSees = Object.fromEntries(
        Object.keys(viewers).map((name) => [name, [false, true] as const]),
      );
      await assertSeen(
        { ...everyoneSees, receiverA: [true, true], admin: [true, true] },
        "stored",
      );
      // Only the typed rows go; the resources and the objects' links stay.
      await deleteCarriers();
      const links = await db.query.objects.findMany({
        columns: { activityId: true },
      });
      assert.deepEqual(
        links.map(({ activityId }) => activityId).toSorted(),
        carriers.map(({ id }) => id).toSorted(),
      );
      await assertSeen({ admin: [true, true] }, "deleted");
      // Stored again with other contents: the deliveries carried none of it.
      await restoreCarrier(0, { ...bodies[0], summary: "other" });
      await assertSeen({ admin: [true, true] }, "restored otherwise");
      await deleteCarriers();
      for (const [index, body] of bodies.entries()) {
        await restoreCarrier(index, body);
      }
      await assertSeen(
        { ...everyoneSees, receiverA: [true, true], admin: [true, true] },
        "restored as stored",
      );
      for (const { id } of carriers) {
        assert.deepEqual(await marksOf(db, id), [
          { carriedSnapshot: true, carriedObjectSnapshot: true },
        ]);
      }
    });
  });
});
