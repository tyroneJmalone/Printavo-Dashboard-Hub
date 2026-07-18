import { boolean, doublePrecision, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tasksTable } from "./tasks";
import { membersTable } from "./members";

export const subtasksTable = pgTable("subtasks", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id")
    .notNull()
    .references(() => tasksTable.id, { onDelete: "cascade" }),
  assigneeId: integer("assignee_id").references(() => membersTable.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  completed: boolean("completed").notNull().default(false),
  sortOrder: doublePrecision("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertSubtaskSchema = createInsertSchema(subtasksTable).omit({
  id: true,
  createdAt: true,
});
export type InsertSubtask = z.infer<typeof insertSubtaskSchema>;
export type Subtask = typeof subtasksTable.$inferSelect;
