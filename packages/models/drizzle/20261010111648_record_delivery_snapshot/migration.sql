ALTER TABLE "activity_deliveries" ADD COLUMN "carried_snapshot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Deliveries linked before this decide as linkInboundActivity() now does: one
-- carried the stored activity when its payload is the stored document.  A
-- document jsonb cannot hold carries nothing, as such a payload is not stored.
DO $$
DECLARE
  linked record;
BEGIN
  FOR linked IN
    SELECT d.id, d.payload, a.document
    FROM activity_deliveries d
    JOIN activities a ON a.id = d.activity_id
    WHERE d.direction = 'inbound'
      AND d.payload IS NOT NULL
      AND jsonb_typeof(d.payload) <> 'null'
      AND a.document IS NOT NULL
  LOOP
    BEGIN
      IF linked.payload = linked.document::jsonb THEN
        UPDATE activity_deliveries
        SET carried_snapshot = true
        WHERE id = linked.id;
      END IF;
    EXCEPTION WHEN data_exception THEN
      NULL;
    END;
  END LOOP;
END
$$;
