import {
  boolean,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { listsTable } from "./lists";

export const ticktickSyncConfigsTable = pgTable("ticktick_sync_configs", {
  id: serial("id").primaryKey(),
  ticktickProjectId: text("ticktick_project_id").notNull().unique(),
  ticktickProjectName: text("ticktick_project_name").notNull(),
  momintumListId: integer("momintum_list_id")
    .references(() => listsTable.id, { onDelete: "cascade" })
    .notNull(),
  enabled: boolean("enabled").notNull().default(true),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastSyncError: text("last_sync_error"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const ticktickTaskMapTable = pgTable("ticktick_task_map", {
  id: serial("id").primaryKey(),
  ticktickTaskId: text("ticktick_task_id").notNull().unique(),
  ticktickProjectId: text("ticktick_project_id").notNull(),
  momintumTaskId: integer("momintum_task_id").notNull(),
  lastTicktickStatus: integer("last_ticktick_status").notNull().default(0),
  lastMomintumCompleted: boolean("last_momintum_completed")
    .notNull()
    .default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
