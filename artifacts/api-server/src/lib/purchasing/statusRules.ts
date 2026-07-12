import type { Logger } from "pino";
import {
  db,
  poStatusRulesTable,
  poStatusSuggestionsTable,
  poFilesTable,
  pvOrdersTable,
  pvLineItemsTable,
  pvStatusesTable,
  type PoStatusRule,
  type PoStatusSuggestion,
} from "@workspace/db";
import { eq, asc, desc, and, inArray, isNotNull, gt, sql } from "drizzle-orm";
import { statusUpdateMutation } from "@workspace/printavo";
import { getPrintavoClient, printavoConfigured } from "../printavoGateway";
import { refreshOrderDetail, newDetailAgg } from "../sync/detail";
import { businessDaysUntilDue } from "./businessDays";

/**
 * Status rules engine (P3d).
 *
 * After a PO push (or on demand), orders whose need_ordering items are all
 * ordered get a SUGGESTED Printavo status change — nothing is written to
 * Printavo until the suggestion is explicitly applied (preview/confirm is
 * mandatory; statusUpdate mutates real data).
 *
 * Reads Postgres ONLY (pv_* tables); the single Printavo write
 * (statusUpdate) goes through the shared throttled gateway client.
 */

export type DecoGroup = "print" | "heat" | "embroidery";
export const DECO_GROUPS: readonly DecoGroup[] = ["print", "heat", "embroidery"];

/**
 * pv_line_items.category_name → deco group (normalized: trim + lowercase).
 * Only these three groups drive status rules (Tyler, 2026-07-09). Contract
 * categories are intentionally EXCLUDED — contract work has its own status
 * lane; fee-ish categories (Shipping, Extras, Art, Samples, ...) are ignored.
 */
const CATEGORY_TO_GROUP: Record<string, DecoGroup> = {
  "screen printing": "print",
  "heat applied graphics": "heat",
  "heat applied graphics - personalizations": "heat",
  embroidery: "embroidery",
  "embroidery - personalizations": "embroidery",
  "embroidery - set up/digitizing": "embroidery",
};

/** A line with this category makes the order mixed-deco by definition. */
const MIXED_CATEGORY = "mixed decoration";

const normCategory = (name: string | null): string =>
  (name ?? "").trim().toLowerCase();

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/* ── DTOs ────────────────────────────────────────────────────────────── */

export interface StatusRuleDto {
  id: string;
  priority: number;
  enabled: boolean;
  decoGroup: DecoGroup | null;
  specialMixedDeco: boolean;
  dueComparator: "more_than" | "at_most" | null;
  dueBusinessDays: number | null;
  targetStatusId: string;
  targetStatusName: string;
  createdAt: string;
  updatedAt: string;
}

export interface StatusSuggestionDto {
  id: string;
  orderPrintavoId: string;
  orderType: string;
  visualId: number | null;
  nickname: string | null;
  customerCompany: string | null;
  decoGroups: string[];
  mixed: boolean;
  currentStatusId: string | null;
  currentStatusName: string | null;
  suggestedStatusId: string;
  suggestedStatusName: string;
  poDate: string;
  dueDate: string | null;
  businessDaysOut: number | null;
  state: string;
  error: string | null;
  appliedAt: string | null;
  createdAt: string;
}

function toRuleDto(r: PoStatusRule): StatusRuleDto {
  return {
    id: r.id,
    priority: r.priority,
    enabled: r.enabled,
    decoGroup: (r.decoGroup as DecoGroup | null) ?? null,
    specialMixedDeco: r.specialMixedDeco,
    dueComparator: (r.dueComparator as "more_than" | "at_most" | null) ?? null,
    dueBusinessDays: r.dueBusinessDays,
    targetStatusId: r.targetStatusId,
    targetStatusName: r.targetStatusName,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toSuggestionDto(s: PoStatusSuggestion): StatusSuggestionDto {
  return {
    id: s.id,
    orderPrintavoId: s.orderPrintavoId,
    orderType: s.orderType,
    visualId: s.visualId,
    nickname: s.nickname,
    customerCompany: s.customerCompany,
    decoGroups: Array.isArray(s.decoGroups) ? (s.decoGroups as string[]) : [],
    mixed: s.mixed,
    currentStatusId: s.currentStatusId,
    currentStatusName: s.currentStatusName,
    suggestedStatusId: s.suggestedStatusId,
    suggestedStatusName: s.suggestedStatusName,
    poDate: s.poDate.toISOString(),
    dueDate: s.dueDate ? s.dueDate.toISOString() : null,
    businessDaysOut: s.businessDaysOut,
    state: s.state,
    error: s.error,
    appliedAt: s.appliedAt ? s.appliedAt.toISOString() : null,
    createdAt: s.createdAt.toISOString(),
  };
}

/* ── Rules CRUD ──────────────────────────────────────────────────────── */

export interface StatusRuleInput {
  priority?: number;
  enabled?: boolean;
  decoGroup?: DecoGroup | null;
  specialMixedDeco?: boolean;
  dueComparator?: "more_than" | "at_most" | null;
  dueBusinessDays?: number | null;
  targetStatusId?: string;
}

export type RuleMutationResult =
  | { status: "ok"; rule: StatusRuleDto }
  | { status: "not_found" }
  | { status: "invalid"; message: string };

function validateRuleShape(input: {
  decoGroup: string | null;
  specialMixedDeco: boolean;
  dueComparator: string | null;
  dueBusinessDays: number | null;
}): string | null {
  if (input.specialMixedDeco && input.decoGroup) {
    return "A mixed-decoration rule cannot also name a single category";
  }
  if ((input.dueComparator == null) !== (input.dueBusinessDays == null)) {
    return "Due-date condition needs both a comparator and a number of business days";
  }
  if (input.dueBusinessDays != null && input.dueBusinessDays < 0) {
    return "Business days must be zero or more";
  }
  return null;
}

async function snapshotStatusName(statusId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: pvStatusesTable.name })
    .from(pvStatusesTable)
    .where(eq(pvStatusesTable.printavoId, statusId))
    .limit(1);
  return row ? row.name : null;
}

export async function listStatusRules(): Promise<StatusRuleDto[]> {
  const rows = await db
    .select()
    .from(poStatusRulesTable)
    .orderBy(asc(poStatusRulesTable.priority), asc(poStatusRulesTable.createdAt));
  return rows.map(toRuleDto);
}

export async function createStatusRule(
  input: StatusRuleInput,
): Promise<RuleMutationResult> {
  if (!input.targetStatusId) {
    return { status: "invalid", message: "A target status is required" };
  }
  const shape = {
    decoGroup: input.decoGroup ?? null,
    specialMixedDeco: input.specialMixedDeco ?? false,
    dueComparator: input.dueComparator ?? null,
    dueBusinessDays: input.dueBusinessDays ?? null,
  };
  const invalid = validateRuleShape(shape);
  if (invalid) return { status: "invalid", message: invalid };
  const statusName = await snapshotStatusName(input.targetStatusId);
  if (!statusName) {
    return { status: "invalid", message: "Unknown Printavo status" };
  }
  let priority = input.priority;
  if (priority == null) {
    const [max] = await db
      .select({ max: sql<number>`coalesce(max(${poStatusRulesTable.priority}), 0)` })
      .from(poStatusRulesTable);
    priority = (max?.max ?? 0) + 1;
  }
  const [row] = await db
    .insert(poStatusRulesTable)
    .values({
      priority,
      enabled: input.enabled ?? true,
      decoGroup: shape.decoGroup,
      specialMixedDeco: shape.specialMixedDeco,
      dueComparator: shape.dueComparator,
      dueBusinessDays: shape.dueBusinessDays,
      targetStatusId: input.targetStatusId,
      targetStatusName: statusName,
    })
    .returning();
  return { status: "ok", rule: toRuleDto(row) };
}

export async function updateStatusRule(
  id: string,
  input: StatusRuleInput,
): Promise<RuleMutationResult> {
  const [existing] = await db
    .select()
    .from(poStatusRulesTable)
    .where(eq(poStatusRulesTable.id, id))
    .limit(1);
  if (!existing) return { status: "not_found" };

  const next = {
    decoGroup:
      input.decoGroup !== undefined ? input.decoGroup : (existing.decoGroup as DecoGroup | null),
    specialMixedDeco: input.specialMixedDeco ?? existing.specialMixedDeco,
    dueComparator:
      input.dueComparator !== undefined ? input.dueComparator : (existing.dueComparator as "more_than" | "at_most" | null),
    dueBusinessDays:
      input.dueBusinessDays !== undefined ? input.dueBusinessDays : existing.dueBusinessDays,
  };
  const invalid = validateRuleShape(next);
  if (invalid) return { status: "invalid", message: invalid };

  let targetStatusId = existing.targetStatusId;
  let targetStatusName = existing.targetStatusName;
  if (input.targetStatusId && input.targetStatusId !== existing.targetStatusId) {
    const statusName = await snapshotStatusName(input.targetStatusId);
    if (!statusName) return { status: "invalid", message: "Unknown Printavo status" };
    targetStatusId = input.targetStatusId;
    targetStatusName = statusName;
  }

  const [row] = await db
    .update(poStatusRulesTable)
    .set({
      priority: input.priority ?? existing.priority,
      enabled: input.enabled ?? existing.enabled,
      decoGroup: next.decoGroup,
      specialMixedDeco: next.specialMixedDeco,
      dueComparator: next.dueComparator,
      dueBusinessDays: next.dueBusinessDays,
      targetStatusId,
      targetStatusName,
      updatedAt: new Date(),
    })
    .where(eq(poStatusRulesTable.id, id))
    .returning();
  return { status: "ok", rule: toRuleDto(row) };
}

export type ReorderRulesResult =
  | { status: "ok"; rules: StatusRuleDto[] }
  | { status: "invalid"; message: string };

/**
 * Atomically renumber rule priorities to match the given order (1..n).
 * Replaces client-side priority swaps, which could dead-end with equal
 * priorities if one of two PATCHes failed mid-way.
 */
export async function reorderStatusRules(
  orderedIds: string[],
): Promise<ReorderRulesResult> {
  return db.transaction(async (tx): Promise<ReorderRulesResult> => {
    const existing = await tx
      .select({ id: poStatusRulesTable.id })
      .from(poStatusRulesTable)
      .for("update");
    const existingIds = new Set(existing.map((r) => r.id));
    if (
      orderedIds.length !== existingIds.size ||
      new Set(orderedIds).size !== orderedIds.length ||
      !orderedIds.every((id) => existingIds.has(id))
    ) {
      return {
        status: "invalid",
        message: "Rule list is out of date — refresh and try again",
      };
    }
    const now = new Date();
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(poStatusRulesTable)
        .set({ priority: i + 1, updatedAt: now })
        .where(eq(poStatusRulesTable.id, orderedIds[i]));
    }
    const rows = await tx
      .select()
      .from(poStatusRulesTable)
      .orderBy(asc(poStatusRulesTable.priority), asc(poStatusRulesTable.createdAt));
    return { status: "ok", rules: rows.map(toRuleDto) };
  });
}

export async function deleteStatusRule(id: string): Promise<"ok" | "not_found"> {
  const deleted = await db
    .delete(poStatusRulesTable)
    .where(eq(poStatusRulesTable.id, id))
    .returning({ id: poStatusRulesTable.id });
  return deleted.length > 0 ? "ok" : "not_found";
}

/** Printavo statuses for the rule target picker (Postgres only). */
export async function listPrintavoStatuses(): Promise<
  { id: string; name: string; color: string | null }[]
> {
  const rows = await db
    .select({
      id: pvStatusesTable.printavoId,
      name: pvStatusesTable.name,
      data: pvStatusesTable.data,
    })
    .from(pvStatusesTable)
    .orderBy(asc(pvStatusesTable.name));
  return rows.map((r) => {
    const raw = r.data as { color?: unknown } | null;
    const color = typeof raw?.color === "string" ? raw.color : null;
    return { id: r.id, name: r.name, color };
  });
}

/* ── Evaluation ──────────────────────────────────────────────────────── */

export interface EvalCandidate {
  orderPrintavoId: string;
  /** "PO date" — the push-completion timestamp the due window counts from. */
  poDate: Date;
}

interface OrderComposition {
  groups: Set<DecoGroup>;
  mixed: boolean;
  needOrderingCount: number;
  orderedCount: number;
}

function composeOrder(
  lines: { categoryName: string | null; productStatus: string | null; items: number }[],
): OrderComposition {
  const groups = new Set<DecoGroup>();
  let mixedLine = false;
  let needOrderingCount = 0;
  let orderedCount = 0;
  for (const line of lines) {
    const cat = normCategory(line.categoryName);
    const group = CATEGORY_TO_GROUP[cat];
    if (group) groups.add(group);
    if (cat === MIXED_CATEGORY) mixedLine = true;
    // Stale zero-quantity lines (e.g. picked-up orders never cleaned up)
    // must not block status suggestions forever — same pragmatics as the
    // needs-ordering cart.
    if (line.productStatus === "need_ordering" && line.items > 0) needOrderingCount += 1;
    if (line.productStatus === "ordered") orderedCount += 1;
  }
  return { groups, mixed: mixedLine || groups.size > 1, needOrderingCount, orderedCount };
}

function ruleMatches(
  rule: PoStatusRule,
  comp: OrderComposition,
  businessDaysOut: number | null,
): boolean {
  if (rule.specialMixedDeco) {
    if (!comp.mixed) return false;
  } else if (rule.decoGroup) {
    if (comp.mixed) return false;
    if (comp.groups.size !== 1 || !comp.groups.has(rule.decoGroup as DecoGroup)) {
      return false;
    }
  }
  if (rule.dueComparator && rule.dueBusinessDays != null) {
    if (businessDaysOut == null) return false;
    if (rule.dueComparator === "more_than" && businessDaysOut <= rule.dueBusinessDays) {
      return false;
    }
    if (rule.dueComparator === "at_most" && businessDaysOut > rule.dueBusinessDays) {
      return false;
    }
  }
  return true;
}

/**
 * Evaluate rules for candidate orders and upsert pending suggestions.
 * Guards (per order): every need_ordering line (qty > 0) is gone AND at
 * least one line is currently `ordered` — the second guard keeps old
 * completed orders (also zero need_ordering) from being resurrected by a
 * manual evaluation. Returns how many suggestions were created/updated.
 */
export interface CreatedStatusSuggestion {
  suggestionId: string;
  orderPrintavoId: string;
  visualId: number | null;
  suggestedStatusName: string;
}

export async function evaluateStatusRules(
  candidates: EvalCandidate[],
  log: Logger,
): Promise<{ checked: number; suggested: number; created: CreatedStatusSuggestion[] }> {
  if (candidates.length === 0) return { checked: 0, suggested: 0, created: [] };
  const rules = await db
    .select()
    .from(poStatusRulesTable)
    .where(eq(poStatusRulesTable.enabled, true))
    .orderBy(asc(poStatusRulesTable.priority), asc(poStatusRulesTable.createdAt));
  if (rules.length === 0) return { checked: 0, suggested: 0, created: [] };
  const created: CreatedStatusSuggestion[] = [];

  let suggested = 0;
  let checked = 0;
  for (const cand of candidates) {
    checked += 1;
    const [order] = await db
      .select({
        printavoId: pvOrdersTable.printavoId,
        visualId: pvOrdersTable.visualId,
        orderType: pvOrdersTable.orderType,
        statusId: pvOrdersTable.statusId,
        statusName: pvOrdersTable.statusName,
        nickname: pvOrdersTable.nickname,
        customerCompany: pvOrdersTable.customerCompany,
        customerDueAt: pvOrdersTable.customerDueAt,
      })
      .from(pvOrdersTable)
      .where(eq(pvOrdersTable.printavoId, cand.orderPrintavoId))
      .limit(1);
    if (!order) continue;

    const lines = await db
      .select({
        categoryName: pvLineItemsTable.categoryName,
        productStatus: pvLineItemsTable.productStatus,
        items: pvLineItemsTable.items,
      })
      .from(pvLineItemsTable)
      .where(eq(pvLineItemsTable.orderId, cand.orderPrintavoId));
    const comp = composeOrder(lines);
    if (comp.needOrderingCount > 0 || comp.orderedCount === 0) continue;

    const businessDaysOut = order.customerDueAt
      ? businessDaysUntilDue(cand.poDate, order.customerDueAt)
      : null;
    const matched = rules.find((r) => ruleMatches(r, comp, businessDaysOut));
    if (!matched) continue;

    if (matched.targetStatusId === order.statusId) {
      // Already in the target status — clear any now-moot open suggestion
      // (pending or failed).
      await db
        .delete(poStatusSuggestionsTable)
        .where(
          and(
            eq(poStatusSuggestionsTable.orderPrintavoId, cand.orderPrintavoId),
            inArray(poStatusSuggestionsTable.state, ["pending", "failed"]),
          ),
        );
      continue;
    }

    // Idempotent re-evaluation: if this exact suggestion (same order, same
    // PO date, same target) was already applied or dismissed, don't nag.
    const [settled] = await db
      .select({ id: poStatusSuggestionsTable.id })
      .from(poStatusSuggestionsTable)
      .where(
        and(
          eq(poStatusSuggestionsTable.orderPrintavoId, cand.orderPrintavoId),
          eq(poStatusSuggestionsTable.suggestedStatusId, matched.targetStatusId),
          eq(poStatusSuggestionsTable.poDate, cand.poDate),
          inArray(poStatusSuggestionsTable.state, ["applied", "dismissed"]),
        ),
      )
      .limit(1);
    if (settled) continue;

    const snapshot = {
      orderType: order.orderType,
      visualId: order.visualId,
      nickname: order.nickname,
      customerCompany: order.customerCompany,
      decoGroups: [...comp.groups] as string[],
      mixed: comp.mixed,
      currentStatusId: order.statusId,
      currentStatusName: order.statusName,
      suggestedStatusId: matched.targetStatusId,
      suggestedStatusName: matched.targetStatusName,
      ruleId: matched.id,
      poDate: cand.poDate,
      dueDate: order.customerDueAt,
      businessDaysOut,
      error: null as string | null,
      updatedAt: new Date(),
    };
    // A fresh evaluation supersedes any earlier failed attempt for this
    // order — otherwise the card would show a failed row AND a pending row
    // for the same order, and the failed one would linger forever.
    await db
      .delete(poStatusSuggestionsTable)
      .where(
        and(
          eq(poStatusSuggestionsTable.orderPrintavoId, cand.orderPrintavoId),
          eq(poStatusSuggestionsTable.state, "failed"),
        ),
      );
    const [inserted] = await db
      .insert(poStatusSuggestionsTable)
      .values({ orderPrintavoId: cand.orderPrintavoId, ...snapshot })
      .onConflictDoUpdate({
        target: [poStatusSuggestionsTable.orderPrintavoId],
        targetWhere: sql`state = 'pending'`,
        set: snapshot,
      })
      .returning({ id: poStatusSuggestionsTable.id });
    if (inserted) {
      created.push({
        suggestionId: inserted.id,
        orderPrintavoId: cand.orderPrintavoId,
        visualId: order.visualId,
        suggestedStatusName: matched.targetStatusName,
      });
    }
    suggested += 1;
  }
  log.info({ checked, suggested }, "status rules evaluated");
  return { checked, suggested, created };
}

/**
 * Post-push hook — best-effort, never fails the push. `poDate` is the push
 * completion instant.
 */
export async function evaluateAfterPush(
  orderIds: string[],
  poDate: Date,
  log: Logger,
): Promise<CreatedStatusSuggestion[]> {
  if (orderIds.length === 0) return [];
  try {
    const { created } = await evaluateStatusRules(
      orderIds.map((orderPrintavoId) => ({ orderPrintavoId, poDate })),
      log,
    );
    return created;
  } catch (err) {
    log.warn({ err }, "post-push status rule evaluation failed (non-fatal)");
    return [];
  }
}

/**
 * Manual "check now": candidates are orders referenced by POs pushed in the
 * last 30 days; each order's PO date is its latest push completion
 * (push_state.finishedAt, falling back to pushed_to_printavo_at).
 */
export async function evaluateRecentPushedOrders(
  log: Logger,
): Promise<{ checked: number; suggested: number }> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const pos = await db
    .select({
      lineItems: poFilesTable.lineItems,
      pushedToPrintavoAt: poFilesTable.pushedToPrintavoAt,
      pushState: poFilesTable.pushState,
    })
    .from(poFilesTable)
    .where(
      and(
        isNotNull(poFilesTable.pushedToPrintavoAt),
        gt(poFilesTable.pushedToPrintavoAt, cutoff),
      ),
    );

  const byOrder = new Map<string, Date>();
  for (const po of pos) {
    let poDate = po.pushedToPrintavoAt as Date;
    const finishedAt = (po.pushState as { finishedAt?: string } | null)?.finishedAt;
    if (finishedAt) {
      const parsed = new Date(finishedAt);
      if (!Number.isNaN(parsed.getTime())) poDate = parsed;
    }
    const lines = Array.isArray(po.lineItems)
      ? (po.lineItems as { printavoOrderId?: string | null }[])
      : [];
    for (const line of lines) {
      if (!line.printavoOrderId) continue;
      const prev = byOrder.get(line.printavoOrderId);
      if (!prev || poDate.getTime() > prev.getTime()) {
        byOrder.set(line.printavoOrderId, poDate);
      }
    }
  }
  return evaluateStatusRules(
    [...byOrder.entries()].map(([orderPrintavoId, poDate]) => ({
      orderPrintavoId,
      poDate,
    })),
    log,
  );
}

/* ── Suggestions: list / apply / dismiss ─────────────────────────────── */

export async function listStatusSuggestions(
  scope: "open" | "all",
): Promise<StatusSuggestionDto[]> {
  const rows =
    scope === "all"
      ? await db
          .select()
          .from(poStatusSuggestionsTable)
          .orderBy(desc(poStatusSuggestionsTable.createdAt))
          .limit(200)
      : await db
          .select()
          .from(poStatusSuggestionsTable)
          .where(inArray(poStatusSuggestionsTable.state, ["pending", "failed"]))
          .orderBy(desc(poStatusSuggestionsTable.createdAt));
  return rows.map(toSuggestionDto);
}

export type ApplySuggestionResult =
  | { status: "ok"; suggestion: StatusSuggestionDto }
  | { status: "not_found" }
  | { status: "invalid_state"; state: string }
  | { status: "already_in_target" }
  | { status: "stale_status"; suggestion: StatusSuggestionDto }
  | { status: "gateway_error"; error: string; suggestion: StatusSuggestionDto }
  | { status: "not_configured" };

/**
 * Apply a suggestion: statusUpdate through the shared throttled gateway,
 * then mark applied and refresh the order's detail (best-effort). The row
 * is locked for the duration so a double-click can't double-write; `failed`
 * rows may be retried.
 *
 * Stale-status guard: if the order's status (per the latest sync) no longer
 * matches the snapshot taken at evaluation time, nothing is written — the
 * snapshot is refreshed and the caller gets `stale_status` so the user can
 * re-confirm against the real "from" status. If the order already reached
 * the target some other way, the suggestion is deleted as moot.
 */
export async function applyStatusSuggestion(
  id: string,
  log: Logger,
): Promise<ApplySuggestionResult> {
  if (!printavoConfigured()) return { status: "not_configured" };
  const result = await db.transaction(async (tx): Promise<ApplySuggestionResult> => {
    const [row] = await tx
      .select()
      .from(poStatusSuggestionsTable)
      .where(eq(poStatusSuggestionsTable.id, id))
      .for("update");
    if (!row) return { status: "not_found" };
    if (row.state !== "pending" && row.state !== "failed") {
      return { status: "invalid_state", state: row.state };
    }
    const [order] = await tx
      .select({
        statusId: pvOrdersTable.statusId,
        statusName: pvOrdersTable.statusName,
      })
      .from(pvOrdersTable)
      .where(eq(pvOrdersTable.printavoId, row.orderPrintavoId))
      .limit(1);
    if (order) {
      if (order.statusId === row.suggestedStatusId) {
        await tx
          .delete(poStatusSuggestionsTable)
          .where(eq(poStatusSuggestionsTable.id, id));
        return { status: "already_in_target" };
      }
      if (order.statusId !== row.currentStatusId) {
        const [refreshed] = await tx
          .update(poStatusSuggestionsTable)
          .set({
            currentStatusId: order.statusId,
            currentStatusName: order.statusName,
            updatedAt: new Date(),
          })
          .where(eq(poStatusSuggestionsTable.id, id))
          .returning();
        return { status: "stale_status", suggestion: toSuggestionDto(refreshed) };
      }
    }
    const client = getPrintavoClient();
    try {
      await client.query(
        statusUpdateMutation(row.orderPrintavoId, row.suggestedStatusId),
      );
    } catch (err) {
      const message = errMessage(err);
      log.error(
        { err, suggestionId: id, orderId: row.orderPrintavoId },
        "statusUpdate failed",
      );
      const [failed] = await tx
        .update(poStatusSuggestionsTable)
        .set({ state: "failed", error: message, updatedAt: new Date() })
        .where(eq(poStatusSuggestionsTable.id, id))
        .returning();
      return {
        status: "gateway_error",
        error: message,
        suggestion: toSuggestionDto(failed),
      };
    }
    const [applied] = await tx
      .update(poStatusSuggestionsTable)
      .set({
        state: "applied",
        appliedAt: new Date(),
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(poStatusSuggestionsTable.id, id))
      .returning();
    return { status: "ok", suggestion: toSuggestionDto(applied) };
  });

  if (result.status === "ok") {
    try {
      await refreshOrderDetail(
        result.suggestion.orderPrintavoId,
        result.suggestion.orderType === "quote" ? "quotes" : "invoices",
        newDetailAgg(),
        log,
      );
    } catch (err) {
      log.warn(
        { err, orderId: result.suggestion.orderPrintavoId },
        "post-apply order refresh failed (sync sweep will catch up)",
      );
    }
  }
  return result;
}

export type DismissSuggestionResult =
  | { status: "ok"; suggestion: StatusSuggestionDto }
  | { status: "not_found" }
  | { status: "invalid_state"; state: string };

export async function dismissStatusSuggestion(
  id: string,
): Promise<DismissSuggestionResult> {
  return db.transaction(async (tx): Promise<DismissSuggestionResult> => {
    const [row] = await tx
      .select()
      .from(poStatusSuggestionsTable)
      .where(eq(poStatusSuggestionsTable.id, id))
      .for("update");
    if (!row) return { status: "not_found" };
    if (row.state !== "pending" && row.state !== "failed") {
      return { status: "invalid_state", state: row.state };
    }
    const [dismissed] = await tx
      .update(poStatusSuggestionsTable)
      .set({ state: "dismissed", updatedAt: new Date() })
      .where(eq(poStatusSuggestionsTable.id, id))
      .returning();
    return { status: "ok", suggestion: toSuggestionDto(dismissed) };
  });
}
