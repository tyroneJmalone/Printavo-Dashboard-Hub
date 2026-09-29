import { pgTable, uuid, text, jsonb, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { chipplyStoresTable } from "./chipplyStores";

// Bounded, PII-free normalized source snapshots. Old versions are immutable.
export const chipplyDataSnapshotsTable = pgTable("chipply_data_snapshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull().references(() => chipplyStoresTable.id),
  sourceHash: text("source_hash").notNull(),
  sourceName: text("source_name").notNull(),
  payload: jsonb("payload").notNull(),
  actor: text("actor").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("chipply_data_store_hash_uq").on(t.storeId, t.sourceHash)]);
export const chipplyDataCurrentTable = pgTable("chipply_data_current", {
  storeId: uuid("store_id").primaryKey().references(() => chipplyStoresTable.id),
  snapshotId: uuid("snapshot_id").notNull().references(() => chipplyDataSnapshotsTable.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const chipplyDataPreviewsTable = pgTable("chipply_data_previews", {
  id: uuid("id").primaryKey().defaultRandom(),
  actor: text("actor").notNull(),
  sourceName: text("source_name").notNull(),
  payload: jsonb("payload").notNull(),
  expectedSnapshotId: uuid("expected_snapshot_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  confirmedSnapshotId: uuid("confirmed_snapshot_id"),
});
export const chipplyDataOverridesTable = pgTable("chipply_data_overrides", {
  id: uuid("id").primaryKey().defaultRandom(),
  snapshotId: uuid("snapshot_id").notNull().references(() => chipplyDataSnapshotsTable.id),
  rowOrdinal: integer("row_ordinal").notNull(),
  invoiceId: text("invoice_id").notNull(),
  reason: text("reason").notNull(),
  actor: text("actor").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("chipply_data_override_snapshot_idx").on(t.snapshotId)]);
export const chipplyDataEventsTable = pgTable("chipply_data_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  storeId: uuid("store_id").notNull().references(() => chipplyStoresTable.id),
  previousSnapshotId: uuid("previous_snapshot_id"),
  snapshotId: uuid("snapshot_id").notNull(),
  actor: text("actor").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});