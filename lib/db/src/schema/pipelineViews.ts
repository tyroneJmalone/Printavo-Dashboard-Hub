import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { staffUsersTable } from "./staffUsers";

export const pipelineViewsTable = pgTable(
  "pipeline_views",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    staffId: uuid("staff_id").notNull()
      .references(() => staffUsersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    config: jsonb("config").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("pipeline_views_staff_idx").on(t.staffId),
    uniqueIndex("pipeline_views_one_default_per_staff_uq")
      .on(t.staffId)
      .where(sql`${t.isDefault} = true`),
  ],
);

export type PipelineView = typeof pipelineViewsTable.$inferSelect;
export type InsertPipelineView = typeof pipelineViewsTable.$inferInsert;