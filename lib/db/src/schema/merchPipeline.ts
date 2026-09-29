import { pgTable, uuid, text, boolean, date, jsonb, timestamp } from "drizzle-orm/pg-core";
import { staffUsersTable } from "./staffUsers";
import { chipplyStoresTable } from "./chipplyStores";
import { correspondenceThreadsTable } from "./correspondence";

export const merchOpportunitiesTable = pgTable("merch_opportunities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  stage: text("stage").notNull().default("Target/Prospect/Inquiry"),
  ownerId: uuid("owner_id").references(() => staffUsersTable.id, { onDelete: "set null" }),
  nextAction: text("next_action").notNull().default(""),
  dueDate: date("due_date"),
  chipplyStoreId: uuid("chipply_store_id").references(() => chipplyStoresTable.id, { onDelete: "restrict" }),
  eventId: text("event_id"),
  details: jsonb("details").notNull().default({}),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const merchThreadLinksTable = pgTable("merch_thread_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  opportunityId: uuid("opportunity_id").references(() => merchOpportunitiesTable.id, { onDelete: "restrict" }),
  storeId: uuid("store_id").references(() => chipplyStoresTable.id, { onDelete: "cascade" }),
  threadId: uuid("thread_id").references(() => correspondenceThreadsTable.id, { onDelete: "cascade" }),
  manualUrl: text("manual_url"),
  createdBy: uuid("created_by").references(() => staffUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});