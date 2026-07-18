import {
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { membersTable } from "./members";
import { listsTable } from "./lists";

export const missiveConfigTable = pgTable("missive_config", {
  id: serial("id").primaryKey(),
  apiToken: text("api_token"),
  webhookSecret: text("webhook_secret"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const missiveTriggersTable = pgTable(
  "missive_triggers",
  {
    id: serial("id").primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => membersTable.id, { onDelete: "cascade" }),
    codeword: text("codeword").notNull(),
    listId: integer("list_id")
      .notNull()
      .references(() => listsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("missive_triggers_member_codeword_idx").on(
      table.memberId,
      table.codeword,
    ),
  ],
);

export type MissiveConfig = typeof missiveConfigTable.$inferSelect;
export type MissivetTrigger = typeof missiveTriggersTable.$inferSelect;
