import { pgTable, uuid, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { chipplyStoresTable } from "./chipplyStores";

/** Sanitized structured rows only; never original CSV bytes or passwords. */
export const chipplySummaryPreviewsTable = pgTable("chipply_summary_previews", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor").notNull(),
  sourceName: text("source_name").notNull(),
  payload: jsonb("payload").notNull(),
  result: jsonb("result"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const chipplySummaryObservationsTable = pgTable("chipply_summary_observations", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull().references(() => chipplyStoresTable.id, { onDelete: "cascade" }),
  sourceName: text("source_name").notNull(),
  sourceHash: text("source_hash").notNull(),
  source: jsonb("source").notNull(),
  retained: jsonb("retained").notNull().default({}),
  actor: text("actor").notNull(),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("chipply_summary_store_idx").on(t.storeId, t.importedAt)]);