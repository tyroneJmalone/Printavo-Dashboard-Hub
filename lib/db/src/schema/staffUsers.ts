import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Staff allowlist + roles for Hub authentication.
 *
 * Access model: an admin adds a staff email here FIRST; only then can that
 * person sign in (Google via Clerk). On their first authenticated request
 * the row is linked to their Clerk user id. Dev and prod have separate
 * Clerk user stores, so clerk_user_id re-links per environment — the email
 * (stored lowercase) is the durable identity.
 */
export const staffUsersTable = pgTable("staff_users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Lowercased at every write — unique identity across environments. */
  email: text("email").notNull().unique(),
  /** "admin" | "manager" | "staff" */
  role: text("role").notNull().default("staff"),
  /** Clerk user id, linked on first authenticated request (per environment). */
  clerkUserId: text("clerk_user_id").unique(),
  /** Email of the admin who added this row (null for the bootstrap seed). */
  addedByEmail: text("added_by_email"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type StaffUser = typeof staffUsersTable.$inferSelect;
export type StaffRole = "admin" | "manager" | "staff";
