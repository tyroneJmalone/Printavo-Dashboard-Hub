import { z } from "zod";

export const stages = ["Target/Prospect/Inquiry", "Discovery", "Real Deal/Scheduled", "Gathering/Building", "Live", "Closed"] as const;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === v;
}, "Invalid calendar date").nullable();
const text = z.string().trim().max(10000);
const url = z.string().max(2000).refine(v => {
  if (!v) return true;
  try { const u = new URL(v); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; }
}, "Use an HTTPS URL without credentials");
export function missiveConversationId(value: string): string | null {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || !["mail.missiveapp.com", "app.missiveapp.com"].includes(u.hostname)
      || u.port || u.username || u.password || u.search || /[\s\\%]/.test(value)) return null;
    const route = u.hash && u.pathname === "/" ? u.hash.slice(1).replace(/^\//, "") : !u.hash ? u.pathname.slice(1) : "";
    const match = /^(?:(?:inbox|all)(?:\/conversations)?|conversations)\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(route);
    return match?.[1].toLowerCase() ?? null;
  } catch { return null; }
}
export const missiveUrl = z.string().max(2000)
  .refine(v => missiveConversationId(v) !== null, "Use a direct HTTPS Missive conversation URL without query parameters")
  .transform(v => `https://mail.missiveapp.com/#inbox/${missiveConversationId(v)}`);
export const detailsSchema = z.object({
  status: text.optional(), dashboardUrl: url.optional(), previewUrl: url.optional(), websiteUrl: url.optional(),
  launchDate: date.optional(), closeDate: date.optional(), inHandDate: date.optional(),
  fundraiser: z.boolean().optional(), payee: text.optional(), processes: text.optional(), audience: text.optional(),
  repeat: z.boolean().optional(), partial: z.boolean().optional(), inHouse: z.boolean().optional(),
  notes: text.optional(), mailingAddress: text.optional(), checkDate: date.optional(),
  checkAmount: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/, "Use a non-negative amount with at most two decimal places").nullable().optional(),
  payoutNotes: text.optional(),
}).strict();
export const opportunitySchema = z.object({
  name: z.string().trim().min(1).max(300),
  stage: z.enum(stages).default(stages[0]),
  ownerId: z.string().uuid().nullable().default(null),
  nextAction: z.string().trim().max(2000).default(""),
  dueDate: date.default(null),
  chipplyStoreId: z.string().uuid().nullable().default(null),
  eventId: z.string().trim().min(1).max(100).nullable().default(null),
  archived: z.boolean().default(false),
  details: detailsSchema.default({}),
}).strict();
export const threadLinkSchema = z.object({
  confirmed: z.literal(true),
  threadId: z.string().uuid().optional(),
  manualUrl: missiveUrl.optional(),
}).strict().refine(v => Boolean(v.threadId) !== Boolean(v.manualUrl), "Choose one thread or manual URL");