-- Development-only, additive migration. Production schema changes belong to Publish.
-- Existing stores, mirrors and unrelated constraints/defaults are never modified.
BEGIN;

CREATE TABLE IF NOT EXISTS "chipply_data_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "source_hash" text NOT NULL,
  "source_name" text NOT NULL,
  "payload" jsonb NOT NULL,
  "actor" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chipply_data_snapshots_store_id_chipply_stores_id_fk"
    FOREIGN KEY ("store_id") REFERENCES "public"."chipply_stores"("id")
);
CREATE TABLE IF NOT EXISTS "chipply_data_current" (
  "store_id" uuid PRIMARY KEY NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chipply_data_current_store_id_chipply_stores_id_fk"
    FOREIGN KEY ("store_id") REFERENCES "public"."chipply_stores"("id"),
  CONSTRAINT "chipply_data_current_snapshot_id_chipply_data_snapshots_id_fk"
    FOREIGN KEY ("snapshot_id") REFERENCES "public"."chipply_data_snapshots"("id")
);
CREATE TABLE IF NOT EXISTS "chipply_data_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "store_id" uuid NOT NULL,
  "previous_snapshot_id" uuid,
  "snapshot_id" uuid NOT NULL,
  "actor" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chipply_data_events_store_id_chipply_stores_id_fk"
    FOREIGN KEY ("store_id") REFERENCES "public"."chipply_stores"("id")
);
CREATE TABLE IF NOT EXISTS "chipply_data_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "snapshot_id" uuid NOT NULL,
  "row_ordinal" integer NOT NULL,
  "invoice_id" text NOT NULL,
  "reason" text NOT NULL,
  "actor" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chipply_data_overrides_snapshot_id_chipply_data_snapshots_id_fk"
    FOREIGN KEY ("snapshot_id") REFERENCES "public"."chipply_data_snapshots"("id")
);
CREATE TABLE IF NOT EXISTS "chipply_data_previews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor" text NOT NULL,
  "source_name" text NOT NULL,
  "payload" jsonb NOT NULL,
  "expected_snapshot_id" uuid,
  "expires_at" timestamp with time zone NOT NULL,
  "confirmed_snapshot_id" uuid
);
CREATE TABLE IF NOT EXISTS "merch_opportunities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "stage" text DEFAULT 'Target/Prospect/Inquiry' NOT NULL,
  "owner_id" uuid,
  "next_action" text DEFAULT '' NOT NULL,
  "due_date" date,
  "chipply_store_id" uuid,
  "event_id" text,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "archived" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "merch_opportunities_owner_id_staff_users_id_fk"
    FOREIGN KEY ("owner_id") REFERENCES "public"."staff_users"("id") ON DELETE SET NULL,
  CONSTRAINT "merch_opportunities_chipply_store_id_chipply_stores_id_fk"
    FOREIGN KEY ("chipply_store_id") REFERENCES "public"."chipply_stores"("id") ON DELETE RESTRICT
);
CREATE TABLE IF NOT EXISTS "merch_thread_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "opportunity_id" uuid,
  "store_id" uuid,
  "thread_id" uuid,
  "manual_url" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "merch_thread_links_opportunity_id_merch_opportunities_id_fk"
    FOREIGN KEY ("opportunity_id") REFERENCES "public"."merch_opportunities"("id") ON DELETE RESTRICT,
  CONSTRAINT "merch_thread_links_store_id_chipply_stores_id_fk"
    FOREIGN KEY ("store_id") REFERENCES "public"."chipply_stores"("id") ON DELETE CASCADE,
  CONSTRAINT "merch_thread_links_thread_id_correspondence_threads_id_fk"
    FOREIGN KEY ("thread_id") REFERENCES "public"."correspondence_threads"("id") ON DELETE CASCADE,
  CONSTRAINT "merch_thread_links_created_by_staff_users_id_fk"
    FOREIGN KEY ("created_by") REFERENCES "public"."staff_users"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "chipply_data_override_snapshot_idx"
  ON "chipply_data_overrides" ("snapshot_id");
CREATE UNIQUE INDEX IF NOT EXISTS "chipply_data_store_hash_uq"
  ON "chipply_data_snapshots" ("store_id", "source_hash");
-- Existing partial unique index is left unchanged. This fails rather than
-- deleting or merging records if unexpected duplicate event IDs exist.
CREATE UNIQUE INDEX IF NOT EXISTS "chipply_stores_event_id_uq"
  ON "chipply_stores" ("event_id") WHERE "event_id" IS NOT NULL;

COMMIT;