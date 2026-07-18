import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { membersTable } from "./members";

export const feedbackTable = pgTable("feedback", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id").references(() => membersTable.id, {
    onDelete: "set null",
  }),
  type: text("type").notNull().default("general"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type Feedback = typeof feedbackTable.$inferSelect;
