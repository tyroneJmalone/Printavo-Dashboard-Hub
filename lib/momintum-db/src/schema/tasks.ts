import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { listsTable } from "./lists";
import { membersTable } from "./members";

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  notes: text("notes"),
  listId: integer("list_id").references(() => listsTable.id, {
    onDelete: "set null",
  }),
  assigneeId: integer("assignee_id").references(() => membersTable.id, {
    onDelete: "set null",
  }),
  createdById: integer("created_by_id").references(() => membersTable.id, {
    onDelete: "set null",
  }),
  priority: text("priority").notNull().default("none"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  tags: text("tags").array().notNull().default([]),
  sortOrder: doublePrecision("sort_order").notNull().default(0),
  recurrence: text("recurrence"),
  recurringParentId: integer("recurring_parent_id"),
  source: text("source"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const insertTaskSchema = createInsertSchema(tasksTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertTask = z.infer<typeof insertTaskSchema>;
export type Task = typeof tasksTable.$inferSelect;
