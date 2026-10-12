ALTER TABLE "activity_deliveries" ADD COLUMN "fetched_object" jsonb;--> statement-breakpoint
ALTER TABLE "activity_deliveries" ADD COLUMN "carried_object_snapshot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "objects" ADD COLUMN "fetched" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Nothing tells whether a remote object stored before this was fetched, nor
-- which version of it a delivery linked before this saw.  Each is taken as
-- fetched, so that no delivery opens it unless it fetched it as stored, and
-- none of those deliveries is marked as having carried it.
UPDATE "objects" SET "fetched" = true
FROM "actors"
WHERE "actors"."id" = "objects"."actor_id" AND "actors"."local_id" IS NULL;
