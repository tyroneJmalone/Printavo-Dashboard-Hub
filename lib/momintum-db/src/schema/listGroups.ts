import {
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

/**
 * List groups — sidebar folders that lists can be nested under.
 *
 * HUB-OWNED tables in the shared LIVE moMINTum database (added 2026-07-19 at
 * Tyler's request, additive-only DDL). The standalone moMINTum app does not
 * know about them; its drizzle pushes must never drop `list_groups` /
 * `list_group_memberships`. Membership is kept in a separate table instead of
 * a column on `lists` so the standalone app's schema tooling never sees an
 * unknown column on a table it manages.
 */
export const listGroupsTable = pgTable("list_groups", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color").notNull().default("#5B6B99"),
  sortOrder: doublePrecision("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const listGroupMembershipsTable = pgTable("list_group_memberships", {
  listId: integer("list_id")
    .primaryKey()
    .references(() => listsTable.id, { onDelete: "cascade" }),
  groupId: integer("group_id")
    .notNull()
    .references(() => listGroupsTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertListGroupSchema = createInsertSchema(listGroupsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertListGroup = z.infer<typeof insertListGroupSchema>;
export type ListGroup = typeof listGroupsTable.$inferSelect;
export type ListGroupMembership =
  typeof listGroupMembershipsTable.$inferSelect;
