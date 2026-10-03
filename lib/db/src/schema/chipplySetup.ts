import { pgTable, uuid, integer, jsonb, boolean, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { chipplyStoresTable } from "./chipplyStores";

export const chipplySetupTable = pgTable("chipply_setup", {
  storeId: uuid("store_id").primaryKey().references(() => chipplyStoresTable.id, { onDelete: "cascade" }),
  currentStep: integer("current_step").notNull().default(1),
  version: integer("version").notNull().default(1),
  confirmedSteps: jsonb("confirmed_steps").$type<number[]>().notNull().default([]),
  marginSkipped: boolean("margin_skipped").notNull().default(false),
  notes: text("notes").notNull().default(""),
  evidenceKey: text("evidence_key").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertChipplySetupSchema = createInsertSchema(chipplySetupTable);
export type ChipplySetup = typeof chipplySetupTable.$inferSelect;