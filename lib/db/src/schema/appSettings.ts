import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";

/**
 * Small key → JSON application settings store (e.g. the vendor ship-to
 * address used when submitting electronic POs). Single-user internal app —
 * one row per setting key.
 */
export const appSettingsTable = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AppSetting = typeof appSettingsTable.$inferSelect;
