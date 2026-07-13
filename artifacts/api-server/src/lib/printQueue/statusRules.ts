import type { Logger } from "pino";
import {
  db,
  appSettingsTable,
  pqStatusRulesTable,
  pvOrdersTable,
  pvLineItemsTable,
  pvStatusesTable,
  type PqStatusRule,
} from "@workspace/db";
import { eq, asc, sql } from "drizzle-orm";
import {
  composeOrder,
  ruleMatches,
  type DecoGroup,
} from "../purchasing/statusRules";
import { businessDaysUntilDue } from "../purchasing/businessDays";

/**
 * Print Queue status rules engine (PQ2) — SEPARATE from the purchasing
 * engine (po_status_rules). Fires after a workorder batch is printed.
 *
 * - trigger = source status(es) + optional deco composition + optional
 *   due-date window (anchored at NOW, not a PO date).
 * - target NULL = explicit "no change" (stops evaluation, changes nothing).
 * - mode: off (manual preset only) | ask (confirm panel, default) | auto.
 * - The app_settings master switch pq_automation_enabled (default FALSE)
 *   gates ALL after-print automation server-side.
 *
 * Reads Postgres ONLY. No deco/needs-ordering gate is copied from
 * purchasing — the PQ trigger is "just printed", nothing else.
 */

export type PqRuleMode = "off" | "ask" | "auto";

/* ── Master kill switch ──────────────────────────────────────────────── */

const AUTOMATION_KEY = "pq_automation_enabled";

export async function getPqAutomationEnabled(): Promise<boolean> {
  const rows = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, AUTOMATION_KEY))
    .limit(1);
  return rows[0] ? rows[0].value === true : false;
}

export async function setPqAutomationEnabled(enabled: boolean): Promise<boolean> {
  await db
    .insert(appSettingsTable)
    .values({ key: AUTOMATION_KEY, value: enabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettingsTable.key,
      set: { value: enabled, updatedAt: new Date() },
    });
  return enabled;
}

/* ── DTOs ────────────────────────────────────────────────────────────── */

export interface PqRuleDto {
  id: string;
  priority: number;
  enabled: boolean;
  name: string | null;
  sourceStatusIds: string[];
  decoGroup: DecoGroup | null;
  specialMixedDeco: boolean;
  dueComparator: "more_than" | "at_most" | null;
  dueBusinessDays: number | null;
  targetStatusId: string | null;
  targetStatusName: string | null;
  mode: PqRuleMode;
  createdAt: string;
  updatedAt: string;
}

function toRuleDto(r: PqStatusRule): PqRuleDto {
  return {
    id: r.id,
    priority: r.priority,
    enabled: r.enabled,
    name: r.name,
    sourceStatusIds: Array.isArray(r.sourceStatusIds)
      ? (r.sourceStatusIds as string[])
      : [],
    decoGroup: (r.decoGroup as DecoGroup | null) ?? null,
    specialMixedDeco: r.specialMixedDeco,
    dueComparator: (r.dueComparator as "more_than" | "at_most" | null) ?? null,
    dueBusinessDays: r.dueBusinessDays,
    targetStatusId: r.targetStatusId,
    targetStatusName: r.targetStatusName,
    mode: (r.mode as PqRuleMode) ?? "ask",
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/* ── CRUD ────────────────────────────────────────────────────────────── */

export interface PqRuleInput {
  priority?: number;
  enabled?: boolean;
  name?: string | null;
  sourceStatusIds?: string[];
  decoGroup?: DecoGroup | null;
  specialMixedDeco?: boolean;
  dueComparator?: "more_than" | "at_most" | null;
  dueBusinessDays?: number | null;
  /** NULL = explicit "no change" rule. */
  targetStatusId?: string | null;
  mode?: PqRuleMode;
}

export type PqRuleMutationResult =
  | { status: "ok"; rule: PqRuleDto }
  | { status: "not_found" }
  | { status: "invalid"; message: string };

const MODES: readonly PqRuleMode[] = ["off", "ask", "auto"];

function validateShape(input: {
  decoGroup: string | null;
  specialMixedDeco: boolean;
  dueComparator: string | null;
  dueBusinessDays: number | null;
  mode: string;
  sourceStatusIds: unknown;
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
  if (!MODES.includes(input.mode as PqRuleMode)) {
    return "Mode must be off, ask, or auto";
  }
  if (
    !Array.isArray(input.sourceStatusIds) ||
    input.sourceStatusIds.some((s) => typeof s !== "string" || !s.trim())
  ) {
    return "Source statuses must be a list of status ids";
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

export async function listPqStatusRules(): Promise<PqRuleDto[]> {
  const rows = await db
    .select()
    .from(pqStatusRulesTable)
    .orderBy(asc(pqStatusRulesTable.priority), asc(pqStatusRulesTable.createdAt));
  return rows.map(toRuleDto);
}

export async function createPqStatusRule(
  input: PqRuleInput,
): Promise<PqRuleMutationResult> {
  const shape = {
    decoGroup: input.decoGroup ?? null,
    specialMixedDeco: input.specialMixedDeco ?? false,
    dueComparator: input.dueComparator ?? null,
    dueBusinessDays: input.dueBusinessDays ?? null,
    mode: input.mode ?? "ask",
    sourceStatusIds: input.sourceStatusIds ?? [],
  };
  const invalid = validateShape(shape);
  if (invalid) return { status: "invalid", message: invalid };

  let targetStatusId: string | null = input.targetStatusId ?? null;
  let targetStatusName: string | null = null;
  if (targetStatusId) {
    targetStatusName = await snapshotStatusName(targetStatusId);
    if (!targetStatusName) {
      return { status: "invalid", message: "Unknown Printavo status" };
    }
  } else {
    targetStatusId = null;
  }

  let priority = input.priority;
  if (priority == null) {
    const [max] = await db
      .select({ max: sql<number>`coalesce(max(${pqStatusRulesTable.priority}), 0)` })
      .from(pqStatusRulesTable);
    priority = (max?.max ?? 0) + 1;
  }
  const [row] = await db
    .insert(pqStatusRulesTable)
    .values({
      priority,
      enabled: input.enabled ?? true,
      name: input.name?.trim() || null,
      sourceStatusIds: [...new Set(shape.sourceStatusIds)],
      decoGroup: shape.decoGroup,
      specialMixedDeco: shape.specialMixedDeco,
      dueComparator: shape.dueComparator,
      dueBusinessDays: shape.dueBusinessDays,
      targetStatusId,
      targetStatusName,
      mode: shape.mode,
    })
    .returning();
  return { status: "ok", rule: toRuleDto(row) };
}

export async function updatePqStatusRule(
  id: string,
  input: PqRuleInput,
): Promise<PqRuleMutationResult> {
  const [existing] = await db
    .select()
    .from(pqStatusRulesTable)
    .where(eq(pqStatusRulesTable.id, id))
    .limit(1);
  if (!existing) return { status: "not_found" };

  const next = {
    decoGroup:
      input.decoGroup !== undefined
        ? input.decoGroup
        : (existing.decoGroup as DecoGroup | null),
    specialMixedDeco: input.specialMixedDeco ?? existing.specialMixedDeco,
    dueComparator:
      input.dueComparator !== undefined
        ? input.dueComparator
        : (existing.dueComparator as "more_than" | "at_most" | null),
    dueBusinessDays:
      input.dueBusinessDays !== undefined
        ? input.dueBusinessDays
        : existing.dueBusinessDays,
    mode: input.mode ?? ((existing.mode as PqRuleMode) || "ask"),
    sourceStatusIds:
      input.sourceStatusIds !== undefined
        ? input.sourceStatusIds
        : Array.isArray(existing.sourceStatusIds)
          ? (existing.sourceStatusIds as string[])
          : [],
  };
  const invalid = validateShape(next);
  if (invalid) return { status: "invalid", message: invalid };

  let targetStatusId = existing.targetStatusId;
  let targetStatusName = existing.targetStatusName;
  if (input.targetStatusId !== undefined) {
    if (input.targetStatusId === null) {
      targetStatusId = null;
      targetStatusName = null;
    } else if (input.targetStatusId !== existing.targetStatusId) {
      const name = await snapshotStatusName(input.targetStatusId);
      if (!name) return { status: "invalid", message: "Unknown Printavo status" };
      targetStatusId = input.targetStatusId;
      targetStatusName = name;
    }
  }

  const [row] = await db
    .update(pqStatusRulesTable)
    .set({
      priority: input.priority ?? existing.priority,
      enabled: input.enabled ?? existing.enabled,
      name: input.name !== undefined ? input.name?.trim() || null : existing.name,
      sourceStatusIds: [...new Set(next.sourceStatusIds)],
      decoGroup: next.decoGroup,
      specialMixedDeco: next.specialMixedDeco,
      dueComparator: next.dueComparator,
      dueBusinessDays: next.dueBusinessDays,
      targetStatusId,
      targetStatusName,
      mode: next.mode,
      updatedAt: new Date(),
    })
    .where(eq(pqStatusRulesTable.id, id))
    .returning();
  return { status: "ok", rule: toRuleDto(row) };
}

export type PqReorderResult =
  | { status: "ok"; rules: PqRuleDto[] }
  | { status: "invalid"; message: string };

export async function reorderPqStatusRules(
  orderedIds: string[],
): Promise<PqReorderResult> {
  return db.transaction(async (tx): Promise<PqReorderResult> => {
    const existing = await tx
      .select({ id: pqStatusRulesTable.id })
      .from(pqStatusRulesTable)
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
        .update(pqStatusRulesTable)
        .set({ priority: i + 1, updatedAt: now })
        .where(eq(pqStatusRulesTable.id, orderedIds[i]));
    }
    const rows = await tx
      .select()
      .from(pqStatusRulesTable)
      .orderBy(asc(pqStatusRulesTable.priority), asc(pqStatusRulesTable.createdAt));
    return { status: "ok", rules: rows.map(toRuleDto) };
  });
}

export async function deletePqStatusRule(id: string): Promise<"ok" | "not_found"> {
  const deleted = await db
    .delete(pqStatusRulesTable)
    .where(eq(pqStatusRulesTable.id, id))
    .returning({ id: pqStatusRulesTable.id });
  return deleted.length > 0 ? "ok" : "not_found";
}

/* ── Evaluation (after print) ────────────────────────────────────────── */

export interface PqRuleMatchItem {
  orderId: string;
  visualId: number | null;
  nickname: string | null;
  customerCompany: string | null;
  fromStatusId: string;
  fromStatusName: string | null;
  targetStatusId: string;
  targetStatusName: string;
  ruleId: string;
  ruleName: string | null;
  mode: PqRuleMode;
}

export interface PqEvaluation {
  askItems: PqRuleMatchItem[];
  autoItems: PqRuleMatchItem[];
  noChangeCount: number;
  alreadyInTargetCount: number;
  unmatchedCount: number;
}

export const MAX_EVALUATE_ORDERS = 200;

/**
 * Evaluate PQ rules for the just-printed orders. First enabled ask/auto
 * rule by priority wins per order ('off' rules never fire after print —
 * they are manual presets only and do not block lower rules). The due
 * window is anchored at NOW. Purchasing's needs-ordering gate is
 * intentionally NOT applied here.
 */
export async function evaluatePqRules(
  orderIds: string[],
  log: Logger,
): Promise<PqEvaluation> {
  const result: PqEvaluation = {
    askItems: [],
    autoItems: [],
    noChangeCount: 0,
    alreadyInTargetCount: 0,
    unmatchedCount: 0,
  };
  if (orderIds.length === 0) return result;

  const allRules = await db
    .select()
    .from(pqStatusRulesTable)
    .where(eq(pqStatusRulesTable.enabled, true))
    .orderBy(asc(pqStatusRulesTable.priority), asc(pqStatusRulesTable.createdAt));
  const rules = allRules.filter((r) => r.mode === "ask" || r.mode === "auto");
  if (rules.length === 0) {
    result.unmatchedCount = orderIds.length;
    return result;
  }

  const now = new Date();
  for (const orderId of [...new Set(orderIds)]) {
    const [order] = await db
      .select({
        printavoId: pvOrdersTable.printavoId,
        visualId: pvOrdersTable.visualId,
        nickname: pvOrdersTable.nickname,
        customerCompany: pvOrdersTable.customerCompany,
        statusId: pvOrdersTable.statusId,
        statusName: pvOrdersTable.statusName,
        customerDueAt: pvOrdersTable.customerDueAt,
      })
      .from(pvOrdersTable)
      .where(eq(pvOrdersTable.printavoId, orderId))
      .limit(1);
    if (!order || !order.statusId) {
      result.unmatchedCount += 1;
      continue;
    }

    const lines = await db
      .select({
        categoryName: pvLineItemsTable.categoryName,
        productStatus: pvLineItemsTable.productStatus,
        items: pvLineItemsTable.items,
      })
      .from(pvLineItemsTable)
      .where(eq(pvLineItemsTable.orderId, orderId));
    const comp = composeOrder(lines);
    const businessDaysOut = order.customerDueAt
      ? businessDaysUntilDue(now, order.customerDueAt)
      : null;

    const matched = rules.find((r) => {
      const sources = Array.isArray(r.sourceStatusIds)
        ? (r.sourceStatusIds as string[])
        : [];
      if (sources.length > 0 && !sources.includes(order.statusId as string)) {
        return false;
      }
      return ruleMatches(r, comp, businessDaysOut);
    });
    if (!matched) {
      result.unmatchedCount += 1;
      continue;
    }
    if (!matched.targetStatusId || !matched.targetStatusName) {
      result.noChangeCount += 1;
      continue;
    }
    if (matched.targetStatusId === order.statusId) {
      result.alreadyInTargetCount += 1;
      continue;
    }
    const item: PqRuleMatchItem = {
      orderId,
      visualId: order.visualId,
      nickname: order.nickname,
      customerCompany: order.customerCompany,
      fromStatusId: order.statusId,
      fromStatusName: order.statusName,
      targetStatusId: matched.targetStatusId,
      targetStatusName: matched.targetStatusName,
      ruleId: matched.id,
      ruleName: matched.name,
      mode: matched.mode as PqRuleMode,
    };
    if (item.mode === "auto") result.autoItems.push(item);
    else result.askItems.push(item);
  }
  log.info(
    {
      checked: orderIds.length,
      ask: result.askItems.length,
      auto: result.autoItems.length,
      noChange: result.noChangeCount,
      alreadyInTarget: result.alreadyInTargetCount,
      unmatched: result.unmatchedCount,
    },
    "pq rules evaluated",
  );
  return result;
}
