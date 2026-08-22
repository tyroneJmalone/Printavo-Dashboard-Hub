import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export interface AiQuoteSize {
  size: string;
  quantity: number;
}

export interface AiQuoteCustomerCandidate {
  customerId: string;
  companyName: string;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  matchType: "exact" | "possible";
}

export interface AiQuoteProductSize {
  size: string;
  cost: number | null;
  salePrice: number | null;
  inventoryTotal: number | null;
}

export interface AiQuoteProductColor {
  name: string;
  image: string | null;
  sizes: AiQuoteProductSize[];
}

export interface AiQuoteProductOption {
  vendor: "sanmar" | "ss";
  matchType: "exact" | "closest";
  styleName: string;
  brand: string | null;
  title: string | null;
  image: string | null;
  colors: AiQuoteProductColor[];
}

export interface AiQuoteGarmentSelection {
  vendor: "sanmar" | "ss";
  styleName: string;
  brand: string | null;
  title: string | null;
  color: string;
  garmentCost: number;
  image: string | null;
}

export interface AiQuoteGarment {
  id: string;
  brand: string | null;
  style: string;
  description: string | null;
  color: string;
  sizes: AiQuoteSize[];
  productOptions: AiQuoteProductOption[];
  selectedProduct: AiQuoteGarmentSelection | null;
}

export interface AiQuoteDecoration {
  id: string;
  location: string;
  method: string;
  colorCount: number | null;
  details: string | null;
  matrixId: string | null;
  matrixColumnIndex: number | null;
}

export interface AiQuotePricingLine {
  garmentId: string;
  quantity: number;
  garmentCost: number;
  garmentMarkup: number;
  decorationCost: number;
  unitPrice: number;
  total: number;
}

export interface AiQuoteDraftData {
  customerQuery: string;
  contactQuery?: string | null;
  customerCandidates: AiQuoteCustomerCandidate[];
  selectedCustomer: AiQuoteCustomerCandidate | null;
  nickname: string;
  dueDate: string | null;
  markup: number;
  customerNote: string;
  productionNote: string;
  garments: AiQuoteGarment[];
  decorations: AiQuoteDecoration[];
  pricing: AiQuotePricingLine[];
  uncertainties: string[];
  warnings: string[];
}

/**
 * AI-assisted quote drafts are local, recoverable working records. A draft is
 * not a Printavo quote until the separate, explicitly confirmed create step
 * succeeds. Printavo writes have an "unknown" terminal state because blindly
 * retrying a timed-out, non-idempotent quoteCreate could duplicate a quote.
 */
export const aiQuoteDraftsTable = pgTable(
  "ai_quote_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: text("status").notNull().default("draft"), // draft | creating | created | failed | unknown
    revision: integer("revision").notNull().default(1),
    prompt: text("prompt").notNull(),
    draft: jsonb("draft").$type<AiQuoteDraftData>().notNull(),
    createdByEmail: text("created_by_email"),
    idempotencyKey: uuid("idempotency_key").notNull().defaultRandom(),
    printavoQuoteId: text("printavo_quote_id"),
    printavoVisualId: integer("printavo_visual_id"),
    printavoCreatedAt: timestamp("printavo_created_at", { withTimezone: true }),
    createAttemptedAt: timestamp("create_attempted_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("ai_quote_drafts_idempotency_uq").on(t.idempotencyKey),
    index("ai_quote_drafts_created_at_idx").on(t.createdAt),
  ],
);

export const insertAiQuoteDraftSchema = createInsertSchema(aiQuoteDraftsTable).omit({
  id: true,
  idempotencyKey: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertAiQuoteDraft = z.infer<typeof insertAiQuoteDraftSchema>;
export type AiQuoteDraft = typeof aiQuoteDraftsTable.$inferSelect;