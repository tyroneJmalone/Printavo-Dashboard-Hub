import type { Logger } from "pino";
import { db, poFilesTable, pvOrdersTable, type PoFile as PoFileRow } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import {
  poPushLineItemQuery,
  lineItemUpdateMutation,
  productionFileCreateMutation,
  toLineItemSizeEnum,
  ORDERED_OR_LATER_STATUSES,
  type LineItemUpdateInput,
} from "@workspace/printavo";
import { getPrintavoClient, printavoConfigured } from "../printavoGateway";
import { publicPoHtmlUrl } from "../publicUrl";
import { refreshOrderDetail } from "../sync/detail";
import { newDetailAgg } from "../sync/detail";
import { newHtmlToken, type PoFileLineItem } from "./poFiles";
import { claimPush, releasePush } from "./pushRegistry";
import { evaluateAfterPush, type CreatedStatusSuggestion } from "./statusRules";
import { poAttachmentTargets } from "./internalInvoicePolicy";

/**
 * Push a PO to Printavo (P3c).
 *
 * Runs as an in-process background job (a synchronous route would blow the
 * ~48s proxy limit: every Printavo call is serialized through the shared
 * 620ms throttle, so a 20-line PO is ~41 requests ≈ 25s).
 *
 * Per PO cycle:
 *  1. fresh cycle only: regenerate html_token (old public links die)
 *  2. per linked line: query current position/status —
 *     already ordered/arrived/received → skip (idempotent);
 *     otherwise lineItemUpdate marking it `ordered`, pushing style/color/size
 *     changes when the PO line diverged from the invoice (Replace flow)
 *  3. productionFileCreate once per distinct invoice — NOT idempotent, so
 *     attached invoice ids are persisted immediately and never re-attached
 *  4. stamp pushed_to_printavo_at + re-lock (manually_unlocked=false) on the
 *     FIRST successful write, so even a partially-failed push locks the PO
 *  5. refresh each affected order's detail in Postgres so the needs-ordering
 *     scan reflects the new statuses right away
 *
 * State is persisted to po_files.push_state after every step; a retry of a
 * failed cycle re-runs only the unfinished steps (and keeps the html_token —
 * regenerating it mid-cycle would break attachments Printavo hasn't fetched
 * yet). Editing the PO's lines clears push_state → next push is fresh.
 */

export type PoPushLineStatus =
  | "pending"
  | "done"
  | "skipped_ordered"
  | "no_link"
  | "failed";

export interface PoPushLineState {
  /** Stable within a cycle: `${index}:${printavoLineItemId | "manual"}`. */
  key: string;
  printavoLineItemId: string | null;
  printavoOrderId: string | null;
  visualId: number | null;
  styleNumber: string;
  color: string | null;
  status: PoPushLineStatus;
  detail: string | null;
}

export interface PoPushState {
  status: "running" | "success" | "failed";
  startedAt: string;
  finishedAt: string | null;
  /** Run-level error (e.g. attach failures) — per-line errors live on lines. */
  error: string | null;
  lines: PoPushLineState[];
  /** Invoices that already got the PO document this cycle (never re-attach). */
  attachedInvoiceIds: string[];
  /** Orders whose Postgres detail was refreshed after status writes. */
  refreshedOrderIds: string[];
  /** Status suggestions the rules engine created after this push (each needs manual confirmation). */
  statusSuggestions: CreatedStatusSuggestion[];
}

export type StartPushResult =
  | "started"
  | "not_found"
  | "already_running"
  | "no_linked_lines"
  | "not_configured";

function lineKey(index: number, li: PoFileLineItem): string {
  return `${index}:${li.printavoLineItemId ?? "manual"}`;
}

function initialLines(lineItems: PoFileLineItem[]): PoPushLineState[] {
  return lineItems.map((li, idx) => ({
    key: lineKey(idx, li),
    printavoLineItemId: li.printavoLineItemId,
    printavoOrderId: li.printavoOrderId,
    visualId: li.visualId,
    styleNumber: li.styleNumber,
    color: li.vendorCatalogColor ?? li.color,
    status: li.printavoLineItemId ? "pending" : "no_link",
    detail: li.printavoLineItemId
      ? null
      : "Manually added line — not linked to a Printavo line item",
  }));
}

export async function startPoPush(
  poFileId: string,
  logger: Logger,
): Promise<StartPushResult> {
  if (!printavoConfigured()) return "not_configured";
  if (!claimPush(poFileId)) return "already_running";

  let started = false;
  try {
    const outcome = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(poFilesTable)
        .where(eq(poFilesTable.id, poFileId))
        .for("update")
        .limit(1);
      const row = rows[0];
      if (!row) return "not_found" as const;
      // Vendor-locked POs CAN be pushed — Tyler's flow is: submit to vendor
      // first, then push to Printavo. The vendor lock freezes edits, not pushes.

      const lineItems = row.lineItems as unknown as PoFileLineItem[];
      if (!lineItems.some((li) => li.printavoLineItemId)) {
        return "no_linked_lines" as const;
      }

      const prior = (row.pushState as PoPushState | null) ?? null;
      // Retry resumes a failed (or restart-interrupted) cycle; anything else
      // starts fresh. Fresh cycles rotate the public HTML token — mid-cycle
      // rotation would kill links Printavo may not have fetched yet.
      const resume = prior !== null && prior.status !== "success";

      let lines: PoPushLineState[];
      if (resume) {
        const priorByKey = new Map(prior.lines.map((l) => [l.key, l]));
        lines = initialLines(lineItems).map((fresh) => {
          const old = priorByKey.get(fresh.key);
          if (old && (old.status === "done" || old.status === "skipped_ordered")) {
            return old;
          }
          return fresh;
        });
      } else {
        lines = initialLines(lineItems);
      }

      const state: PoPushState = {
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        lines,
        attachedInvoiceIds: resume ? prior.attachedInvoiceIds : [],
        refreshedOrderIds: resume ? prior.refreshedOrderIds : [],
        statusSuggestions: resume ? (prior.statusSuggestions ?? []) : [],
      };

      await tx
        .update(poFilesTable)
        .set({
          pushState: state,
          ...(resume ? {} : { htmlToken: newHtmlToken() }),
          updatedAt: new Date(),
        })
        .where(eq(poFilesTable.id, poFileId));
      return "started" as const;
    });

    if (outcome !== "started") return outcome;
    started = true;
    void runPush(poFileId, logger).finally(() => releasePush(poFileId));
    return "started";
  } finally {
    if (!started) releasePush(poFileId);
  }
}

/* ── background runner ──────────────────────────────────────────────── */

interface PushLineItemNode {
  id: string;
  position: number;
  productStatus: string | null;
  itemNumber: string | null;
  color: string | null;
  sizes: Array<{ size: string; count: number }>;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Printavo enum ("size_2xl") → Hub-normalized label ("2XL"). */
function normalizeEnumSize(enumValue: string): string {
  return enumValue.replace(/^size_/, "").toUpperCase();
}

/** Aggregate a line's PO quantities by normalized size label (qty > 0 only). */
function poSizeCounts(li: PoFileLineItem): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of li.sizes) {
    if (s.qty <= 0) continue;
    const label = s.size.trim().toUpperCase();
    counts.set(label, (counts.get(label) ?? 0) + s.qty);
  }
  return counts;
}

function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Decide whether the invoice line's sizes need updating to match the PO
 * (Replace/edit flow). Returns the sizes input when they differ and every PO
 * size maps to Printavo's enum; a note when they differ but can't be pushed
 * (e.g. the cart's synthetic OSFA row); nothing when they already match.
 */
function buildSizesUpdate(
  poLine: PoFileLineItem,
  node: PushLineItemNode,
): { sizes?: Array<{ size: string; count: number }>; note?: string } {
  const want = poSizeCounts(poLine);
  if (want.size === 0) return {};
  const have = new Map<string, number>();
  for (const s of node.sizes) {
    const label = normalizeEnumSize(s.size);
    have.set(label, (have.get(label) ?? 0) + s.count);
  }
  if (sameCounts(want, have)) return {};
  const mapped: Array<{ size: string; count: number }> = [];
  for (const [label, qty] of want) {
    const enumValue = toLineItemSizeEnum(label);
    if (!enumValue) {
      return {
        note: `PO sizes differ from the invoice, but "${label}" is not a size Printavo accepts — invoice sizes left unchanged`,
      };
    }
    mapped.push({ size: enumValue, count: qty });
  }
  return { sizes: mapped };
}

async function persistState(poFileId: string, state: PoPushState): Promise<void> {
  await db
    .update(poFilesTable)
    .set({ pushState: state, updatedAt: new Date() })
    .where(eq(poFilesTable.id, poFileId));
}

async function runPush(poFileId: string, logger: Logger): Promise<void> {
  const log = logger.child({ poFileId, job: "poPush" });
  let state: PoPushState | null = null;
  try {
    const rows = await db
      .select()
      .from(poFilesTable)
      .where(eq(poFilesTable.id, poFileId))
      .limit(1);
    const row: PoFileRow | undefined = rows[0];
    if (!row || !row.pushState) return;
    state = row.pushState as PoPushState;
    const lineItems = row.lineItems as unknown as PoFileLineItem[];
    const client = getPrintavoClient();

    // Stamp + re-lock on the FIRST successful write of THIS run, so even a
    // partial push locks the PO (and a re-push after unlock re-locks it).
    let stamped = false;
    const onFirstWrite = async (): Promise<void> => {
      if (stamped) return;
      stamped = true;
      await db
        .update(poFilesTable)
        .set({
          pushedToPrintavoAt: new Date(),
          manuallyUnlocked: false,
          updatedAt: new Date(),
        })
        .where(eq(poFilesTable.id, poFileId));
    };

    /* 1 — mark linked lines ordered (skip already-ordered: idempotent) */
    for (let i = 0; i < state.lines.length; i++) {
      const line = state.lines[i];
      if (line.status !== "pending" || !line.printavoLineItemId) continue;
      const poLine = lineItems[i];
      try {
        const data = await client.query<{ lineItem: PushLineItemNode | null }>(
          poPushLineItemQuery(line.printavoLineItemId),
        );
        const node = data.lineItem;
        if (!node) {
          line.status = "failed";
          line.detail = "Line item no longer exists in Printavo — was it deleted?";
        } else if (ORDERED_OR_LATER_STATUSES.has(node.productStatus ?? "")) {
          line.status = "skipped_ordered";
          line.detail = `Already "${node.productStatus}" in Printavo — left untouched`;
        } else {
          const input: LineItemUpdateInput = {
            position: node.position,
            productStatus: "ordered",
          };
          const changed: string[] = [];
          if (poLine?.styleNumber && poLine.styleNumber !== (node.itemNumber ?? "")) {
            input.itemNumber = poLine.styleNumber;
            changed.push("style");
          }
          if (poLine?.color && poLine.color !== (node.color ?? "")) {
            input.color = poLine.color;
            changed.push("color");
          }
          let note: string | undefined;
          if (poLine) {
            const sizesUpdate = buildSizesUpdate(poLine, node);
            if (sizesUpdate.sizes) {
              input.sizes = sizesUpdate.sizes;
              changed.push("sizes");
            }
            note = sizesUpdate.note;
          }
          await client.query(lineItemUpdateMutation(line.printavoLineItemId, input));
          await onFirstWrite();
          line.status = "done";
          const parts = ["Marked ordered"];
          if (changed.length > 0) parts.push(`updated ${changed.join(", ")} on the invoice`);
          if (note) parts.push(note);
          line.detail = parts.join("; ");
        }
      } catch (err) {
        line.status = "failed";
        line.detail = errMessage(err);
        log.error({ err, lineKey: line.key }, "PO push: line item update failed");
      }
      await persistState(poFileId, state);
    }

    /* 2 — attach the PO document once per distinct invoice */
    const fileUrl = publicPoHtmlUrl(row.htmlToken, row.poNumber);
    const orderIds = [...new Set(state.lines.flatMap((line) => line.printavoOrderId ? [line.printavoOrderId] : []))];
    // Older snapshots may lack a visual number; also check the current mirror.
    const knownOrders = orderIds.length
      ? await db.select({ id: pvOrdersTable.printavoId, visualId: pvOrdersTable.visualId })
        .from(pvOrdersTable).where(inArray(pvOrdersTable.printavoId, orderIds))
      : [];
    const attachTargets = poAttachmentTargets(state.lines, state.attachedInvoiceIds, knownOrders);
    const attachErrors: string[] = [];
    for (const [invoiceId, visualId] of attachTargets) {
      try {
        await client.query(productionFileCreateMutation(invoiceId, fileUrl));
        state.attachedInvoiceIds.push(invoiceId);
        // Persist IMMEDIATELY — productionFileCreate is not idempotent, and a
        // retry must never attach the same document twice.
        await persistState(poFileId, state);
        await onFirstWrite();
      } catch (err) {
        attachErrors.push(
          `order ${visualId ? `#${visualId}` : invoiceId}: ${errMessage(err)}`,
        );
        log.error({ err, invoiceId }, "PO push: productionFileCreate failed");
      }
    }

    /* 3 — refresh affected orders in Postgres (best-effort; the 5-minute
       sync sweep catches anything missed here) */
    const toRefresh = new Set<string>();
    for (const line of state.lines) {
      if (
        line.status === "done" &&
        line.printavoOrderId &&
        !state.refreshedOrderIds.includes(line.printavoOrderId)
      ) {
        toRefresh.add(line.printavoOrderId);
      }
    }
    for (const orderId of toRefresh) {
      try {
        await refreshOrderDetail(orderId, "invoices", newDetailAgg(), log);
        state.refreshedOrderIds.push(orderId);
      } catch (err) {
        log.warn(
          { err, orderId },
          "PO push: post-push order refresh failed (sync sweep will catch up)",
        );
      }
    }

    /* 4 — finalize */
    const failedLines = state.lines.filter((l) => l.status === "failed").length;
    state.status = failedLines > 0 || attachErrors.length > 0 ? "failed" : "success";
    state.error =
      attachErrors.length > 0
        ? `Couldn't attach the PO document to ${attachErrors.join("; ")}`
        : null;
    state.finishedAt = new Date().toISOString();
    await persistState(poFileId, state);
    log.info(
      {
        status: state.status,
        failedLines,
        attached: state.attachedInvoiceIds.length,
        refreshed: state.refreshedOrderIds.length,
      },
      "PO push finished",
    );

    /* 5 — status rules (P3d): evaluate refreshed orders whose need_ordering
       items are now all ordered. Suggestions only — nothing is written to
       Printavo until Tyler confirms. Best-effort, never fails the push.
       Created suggestions are recorded on the push state so the PO Log's
       push confirmation panel can surface them. */
    const createdSuggestions = await evaluateAfterPush(
      state.refreshedOrderIds,
      new Date(state.finishedAt),
      log,
    );
    if (createdSuggestions.length > 0 || state.statusSuggestions.length === 0) {
      state.statusSuggestions = createdSuggestions;
      await persistState(poFileId, state);
    }
  } catch (err) {
    log.error({ err }, "PO push crashed");
    if (state) {
      state.status = "failed";
      state.error = errMessage(err);
      state.finishedAt = new Date().toISOString();
      await persistState(poFileId, state).catch(() => undefined);
    }
  }
}
