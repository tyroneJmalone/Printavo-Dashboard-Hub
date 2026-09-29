import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const chipplyCategoryReviewsTable = pgTable("chipply_category_reviews", {
  id: text("id").primaryKey(),
  actor: text("actor").notNull(),
  state: text("state").notNull().default("preview"),
  snapshot: jsonb("snapshot").notNull(),
  results: jsonb("results"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const chipplyCategoryClaimsTable = pgTable("chipply_category_claims", {
  lineItemId: text("line_item_id").primaryKey(),
  reviewId: text("review_id").notNull(),
  state: text("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertChipplyCategoryReviewSchema = createInsertSchema(chipplyCategoryReviewsTable);
export type ChipplyCategoryReview = typeof chipplyCategoryReviewsTable.$inferSelect;