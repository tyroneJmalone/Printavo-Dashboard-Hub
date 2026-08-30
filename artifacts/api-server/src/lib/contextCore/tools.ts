import { z } from "zod";
import type { ContextCaller, ContextTool } from "./types";
import {
  getCustomerSummary,
  getOrderDetails,
  getRecentOrders,
  lookupCustomers,
} from "./facts";
import { searchKnowledge } from "./knowledge";
import { interpretAndCreateDraft } from "../quoteDrafts/service";

/**
 * The context layer's tool registry — the single protocol-independent
 * definition every door (MCP, REST, internal) serves from. Adding a tool
 * here automatically exposes it through all doors, subject to trust tier
 * and per-consumer scopes.
 *
 * Trust tiers: every Printavo fact tool is internal-only. External-tier
 * consumers currently get NO tools (the tier exists so the boundary is
 * structural from day one, per the Task #44 review).
 */

function hubBaseUrl(): string {
  const domain = (process.env.REPLIT_DOMAINS ?? "").split(",")[0]?.trim();
  return domain ? `https://${domain}` : "";
}

export const CONTEXT_TOOLS: ContextTool[] = [
  {
    name: "lookup_customer",
    title: "Look up a customer",
    description:
      "Find Mint Prints customers by company name, contact name, or email. Returns candidate matches with a matchType ('exact' or 'possible'). Always confirm which candidate is correct before using customer-specific data when more than one plausible match exists.",
    schema: z.object({
      query: z
        .string()
        .min(2)
        .max(200)
        .describe("Company name, contact name, or email fragment to search for"),
    }),
    allowedTiers: ["internal"],
    isAction: false,
    cacheTtlSeconds: 30,
    handler: async (args) => lookupCustomers(String(args.query)),
  },
  {
    name: "get_customer_summary",
    title: "Get a customer summary",
    description:
      "Get a customer's profile and order statistics from the Hub's synced Printavo data: primary contact, lifetime invoice revenue, outstanding balance, order counts, and their 5 most recent orders. Use lookup_customer first to get the customerId.",
    schema: z.object({
      customerId: z.string().min(1).max(50).describe("Printavo customer id from lookup_customer"),
    }),
    allowedTiers: ["internal"],
    isAction: false,
    cacheTtlSeconds: 60,
    handler: async (args) => getCustomerSummary(String(args.customerId)),
  },
  {
    name: "get_recent_orders",
    title: "List a customer's recent orders",
    description:
      "List a customer's recent quotes and invoices with status, totals, outstanding balance, and due dates. Use lookup_customer first to get the customerId.",
    schema: z.object({
      customerId: z.string().min(1).max(50).describe("Printavo customer id from lookup_customer"),
      limit: z.number().int().min(1).max(25).optional().describe("Max orders to return (default 10)"),
    }),
    allowedTiers: ["internal"],
    isAction: false,
    cacheTtlSeconds: 30,
    handler: async (args) =>
      getRecentOrders(String(args.customerId), Math.min(Math.max(Number(args.limit ?? 10), 1), 25)),
  },
  {
    name: "get_order_details",
    title: "Get order details",
    description:
      "Get one order (quote or invoice) by its visual id — the short number staff and customers reference, like #22133. Returns status, totals, due dates, garment line items with sizes, decorations, and payments.",
    schema: z.object({
      visualId: z
        .number()
        .int()
        .min(1)
        .max(999999)
        .describe("The order's visual id (the short human-facing order number)"),
    }),
    allowedTiers: ["internal"],
    isAction: false,
    cacheTtlSeconds: 30,
    handler: async (args) => getOrderDetails(Number(args.visualId)),
  },
  {
    name: "search_knowledge",
    title: "Search company knowledge",
    description:
      "Search Mint Prints' staff-reviewed knowledge base for company facts: policies, pricing rules, turnaround times, production capabilities, FAQs. Returns only approved, currently-effective entries. Quote entry text verbatim when stating policies — never paraphrase a policy or invent one that isn't returned.",
    schema: z.object({
      query: z.string().min(2).max(300).describe("What you need to know, in a few keywords"),
      category: z
        .string()
        .max(50)
        .optional()
        .describe("Optional category filter, e.g. 'policy', 'pricing', 'production', 'faq'"),
    }),
    allowedTiers: ["internal"],
    isAction: false,
    cacheTtlSeconds: 30,
    handler: async (args) =>
      searchKnowledge({
        query: String(args.query),
        category: args.category ? String(args.category) : null,
      }),
  },
  {
    name: "create_quote_draft",
    title: "Create a quote draft for human review",
    description:
      "Create a DRAFT quote in the Hub from a plain-English request (customer, garments, quantities, decorations, due date). This never creates anything in Printavo — a staff member reviews, edits, and explicitly confirms the draft in the Hub first. Returns a link to the draft. Use only when someone asks to quote actual work.",
    schema: z.object({
      prompt: z
        .string()
        .min(10)
        .max(4000)
        .describe(
          "Plain-English quote request, e.g. '24 Gildan 5000 black tees, 2-color front print, for Acme Corp, due June 5'",
        ),
    }),
    allowedTiers: ["internal"],
    isAction: true,
    cacheTtlSeconds: 0,
    handler: async (args, caller: ContextCaller) => {
      const attribution = caller.staffEmail ?? `ai:${caller.name}`;
      const draft = await interpretAndCreateDraft(String(args.prompt), attribution);
      const base = hubBaseUrl();
      return {
        draftId: draft.id,
        nickname: draft.draft.nickname,
        status: "draft_created",
        reviewUrl: `${base}/ai-quotes/${draft.id}`,
        uncertainties: draft.draft.uncertainties,
        note: "Draft only. A human must review and confirm it in the Hub before any quote reaches Printavo or the customer.",
      };
    },
  },
];

export function findContextTool(name: string): ContextTool | undefined {
  return CONTEXT_TOOLS.find((tool) => tool.name === name);
}

export function toolsForCaller(caller: ContextCaller): ContextTool[] {
  return CONTEXT_TOOLS.filter(
    (tool) =>
      tool.allowedTiers.includes(caller.tier) &&
      (caller.scopes.includes("*") || caller.scopes.includes(tool.name)),
  );
}
