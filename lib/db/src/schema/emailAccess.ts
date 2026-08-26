import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { staffUsersTable } from "./staffUsers";
import { emailMailboxesTable } from "./emailActivity";

export const emailAccessGroupsTable = pgTable(
  "email_access_groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdByEmail: text("created_by_email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("email_access_groups_name_ux").on(t.name)],
);

export const emailAccessGroupMembersTable = pgTable(
  "email_access_group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => emailAccessGroupsTable.id, { onDelete: "cascade" }),
    staffId: uuid("staff_id")
      .notNull()
      .references(() => staffUsersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.staffId] })],
);

export const emailAccessGroupMailboxesTable = pgTable(
  "email_access_group_mailboxes",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => emailAccessGroupsTable.id, { onDelete: "cascade" }),
    mailboxId: uuid("mailbox_id")
      .notNull()
      .references(() => emailMailboxesTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.mailboxId] })],
);

/**
 * A missing policy row is deliberately equivalent to a protected, private
 * mailbox with no owner. That fail-closed rule protects all pre-existing
 * mailboxes during rollout.
 */
export const emailMailboxPoliciesTable = pgTable("email_mailbox_policies", {
  mailboxId: uuid("mailbox_id")
    .primaryKey()
    .references(() => emailMailboxesTable.id, { onDelete: "cascade" }),
  ownerStaffId: uuid("owner_staff_id").references(() => staffUsersTable.id, {
    onDelete: "set null",
  }),
  /** private | group | workspace */
  visibility: text("visibility").notNull().default("private"),
  protected: boolean("protected").notNull().default(true),
  updatedByEmail: text("updated_by_email"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const emailAccessSettingsTable = pgTable("email_access_settings", {
  id: integer("id").primaryKey().default(1),
  /** deny is the only safe default; workspace access is set per mailbox. */
  defaultAccess: text("default_access").notNull().default("deny"),
  retentionDays: integer("retention_days").notNull().default(3650),
  aiProcessingEnabled: boolean("ai_processing_enabled").notNull().default(true),
  updatedByEmail: text("updated_by_email"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EmailAccessGroup = typeof emailAccessGroupsTable.$inferSelect;
export type EmailMailboxPolicy = typeof emailMailboxPoliciesTable.$inferSelect;
export type EmailAccessSettings = typeof emailAccessSettingsTable.$inferSelect;