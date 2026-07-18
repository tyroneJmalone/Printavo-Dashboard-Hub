import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { membersTable } from "./members";
import { teamsTable } from "./teams";

export const listsTable = pgTable("lists", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  ownerId: integer("owner_id").references(() => membersTable.id, {
    onDelete: "set null",
  }),
  teamId: integer("team_id").references(() => teamsTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const insertListSchema = createInsertSchema(listsTable).omit({
  id: true,
  createdAt: true,
});
export type InsertList = z.infer<typeof insertListSchema>;
export type List = typeof listsTable.$inferSelect;
