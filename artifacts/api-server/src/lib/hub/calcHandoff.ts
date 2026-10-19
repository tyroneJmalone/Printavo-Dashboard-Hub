/**
 * Hub Price Calculator — multi-style Printavo handoff.
 *
 * Two destinations:
 *   - existing: append ONE new line-item group (distinct garment lines + the
 *     shared imprints) to an invoice/quote derived from the local mirror.
 *   - new_quote: one quoteCreate for a mirror-verified customer + contact.
 *
 * Safety:
 *   - Everything is recomputed server-side (Hub matrices, categories, target,
 *     customer, LIVE Printavo matrix-column refs, group position) and hashed.
 *     The client must echo the reviewed hash; any drift fails closed.
 *   - The hash is a unique claim. The claim row is inserted before the single
 *     non-idempotent Printavo call. Repeated clicks reuse the row; ambiguous
 *     outcomes become `unknown` and are never retried automatically.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, hubCalcHandoffsTable, pvLineItemsTable, pvOrdersTable } from "@workspace/db";
import { accountReferencePageQuery, orderLineItemGroupPositionsQuery } from "@workspace/printavo";
import { getPrintavoClient } from "../printavoGateway";
import { listDecorationMatrices } from "../pricing/matrices";
import { verifySelectedCustomer, QuoteDraftValidationError } from "../quoteDrafts/service";
import {
  executeHandoff,
  HandoffConflictError,
  rowToResult,
  assertSameRequest,
  type HandoffResult,
  type HandoffRowLike,
  type HandoffSnapshot,
  type HandoffStore,
  type HandoffTarget,
} from "./calcHandoffExec";
import {
  parsePrintavoPricingMatrixReferences,
  PrintavoMatrixResolutionError,
  resolvePrintavoPricingColumns,
} from "../quoteDrafts/printavoMatrices";
import {
  assertReviewedPrices,
  buildHandoffLines,
  decorationDetails,
  HandoffValidationError,
  priceHandoff,
  snapshotHash,
  operationKey,
  requestDigest,
  isStrictIsoDate,
  type HandoffPricingInput,
} from "./calcHandoffPure";

export { HandoffValidationError } from "./calcHandoffPure";
export { HandoffConflictError } from "./calcHandoffExec";

export interface HandoffRequest extends HandoffPricingInput {
  targetKind: "existing" | "new_quote";
  orderId?: string | null;
  customerId?: string | null;
  contactId?: string | null;
  nickname?: string | null;
  dueDate?: string | null;
  reviewedUnitPrices?: Array<{ garmentId: string; unitPrice: number }>;
}

// ── Live reads ──────────────────────────────────────────────────────────

interface PricingMatrixPage {
  account: { pricingMatrices: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
}

async function fetchLivePrintavoMatrices(): Promise<unknown[]> {
  const out: unknown[] = [];
  let after: string | null = null;
  for (;;) {
    const res: PricingMatrixPage = await getPrintavoClient().query<PricingMatrixPage>(
      accountReferencePageQuery("pricing_matrix", after),
    );
    const page = res.account.pricingMatrices;
    out.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return out;
    if (!page.pageInfo.endCursor) {
      throw new PrintavoMatrixResolutionError("Printavo pricing-matrix pagination was incomplete.");
    }
    after = page.pageInfo.endCursor;
  }
}

async function resolveExistingTarget(orderId: string): Promise<HandoffTarget> {
  const [mirror] = await db
    .select({ visualId: pvOrdersTable.visualId, orderType: pvOrdersTable.orderType })
    .from(pvOrdersTable)
    .where(and(eq(pvOrdersTable.printavoId, orderId), inArray(pvOrdersTable.orderType, ["invoice", "quote"])))
    .limit(1);
  if (!mirror) {
    throw new HandoffValidationError(
      "The selected invoice/quote is no longer in the mirror (it may have been converted). Search for it again.",
    );
  }
  const orderType = mirror.orderType === "quote" ? "quote" : "invoice";
  const live = await getPrintavoClient().query<{
    order: {
      id: string;
      visualId: number | string;
      lineItemGroups: { nodes: Array<{ id: string; position: number | null }>; pageInfo: { hasNextPage: boolean } };
    } | null;
  }>(orderLineItemGroupPositionsQuery(orderId, orderType));
  if (!live.order || Number(live.order.visualId) !== mirror.visualId) {
    throw new HandoffValidationError(`Live Printavo ${orderType} #${mirror.visualId} was not found or changed.`);
  }
  if (live.order.lineItemGroups.pageInfo.hasNextPage) {
    throw new HandoffValidationError("This order has more than 100 line-item groups; no safe append position exists.");
  }
  const groupPosition = Math.max(-1, ...live.order.lineItemGroups.nodes.map((g) => g.position ?? -1)) + 1;
  return { kind: "existing", orderId, visualId: mirror.visualId, orderType, groupPosition };
}

async function resolveNewQuoteTarget(req: HandoffRequest): Promise<HandoffTarget> {
  if (!req.customerId || !req.contactId) {
    throw new HandoffValidationError("Select a Printavo customer and contact for the new quote.");
  }
  const nickname = (req.nickname ?? "").trim();
  if (!nickname || nickname.length > 120) throw new HandoffValidationError("Enter a quote nickname (up to 120 characters).");
  const dueDate = (req.dueDate ?? "").trim();
  if (!isStrictIsoDate(dueDate)) {
    throw new HandoffValidationError("Set a customer due date.");
  }
  let verified;
  try {
    // Only ids come from the client; names and the relationship are re-read.
    verified = await verifySelectedCustomer({
      customerId: req.customerId,
      contactId: req.contactId,
      companyName: "",
      contactName: null,
      contactEmail: null,
      matchType: "possible",
    });
  } catch (err) {
    if (err instanceof QuoteDraftValidationError) throw new HandoffValidationError(err.message);
    throw err;
  }
  if (!verified?.contactId) throw new HandoffValidationError("The selected customer has no verified contact.");
  return {
    kind: "new_quote",
    customerId: verified.customerId,
    companyName: verified.companyName,
    contactId: verified.contactId,
    contactName: verified.contactName,
    nickname,
    dueDate,
  };
}

async function loadCategoryNames(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.map((id) => id.trim()))];
  const rows = await db
    .select({ id: pvLineItemsTable.categoryId, name: pvLineItemsTable.categoryName })
    .from(pvLineItemsTable)
    .where(inArray(pvLineItemsTable.categoryId, unique));
  const names = new Map<string, string>();
  for (const row of rows) if (row.id && row.name) names.set(row.id, row.name);
  for (const id of unique) {
    if (!names.has(id)) throw new HandoffValidationError("A selected Printavo category is no longer available.");
  }
  return names;
}

/** Build the fully server-trusted snapshot. Read-only (no Printavo writes). */
export async function buildHandoffSnapshot(req: HandoffRequest): Promise<HandoffSnapshot> {
  const matrices = await listDecorationMatrices();
  const priced = priceHandoff(req, matrices);
  assertReviewedPrices(priced, req.reviewedUnitPrices);
  const categoryNames = await loadCategoryNames(req.garments.map((g) => g.categoryId));
  const lines = buildHandoffLines(priced, categoryNames);

  let resolved;
  try {
    resolved = resolvePrintavoPricingColumns(
      req.decorations.map((d) => ({ id: d.id, location: d.placement, matrixId: d.matrixId, matrixColumnIndex: d.columnIndex })),
      matrices,
      parsePrintavoPricingMatrixReferences(await fetchLivePrintavoMatrices()),
    );
  } catch (err) {
    if (err instanceof PrintavoMatrixResolutionError) throw new HandoffValidationError(err.message);
    throw new HandoffValidationError("Current Printavo pricing matrices could not be verified. Nothing was sent.");
  }
  const byId = new Map(matrices.map((m) => [m.id, m]));
  const imprints = req.decorations.map((d, i) => {
    const m = byId.get(d.matrixId)!;
    return {
      details: decorationDetails(d),
      matrixName: m.name,
      columnLabel: m.data.xValues[d.columnIndex]!.label,
      pricingMatrixColumnId: resolved[i]!.pricingMatrixColumnId,
    };
  });

  const target =
    req.targetKind === "existing"
      ? await (async () => {
          if (!req.orderId) throw new HandoffValidationError("Select a destination invoice or quote.");
          return resolveExistingTarget(req.orderId);
        })()
      : req.targetKind === "new_quote"
        ? await resolveNewQuoteTarget(req)
        : (() => {
            throw new HandoffValidationError("Choose a destination.");
          })();

  return {
    target,
    mode: priced.mode,
    markup: req.markup,
    rangeKey: priced.mode === "compare" ? req.rangeKey : null,
    combinedQuantity: priced.combinedQuantity,
    decorationCostPerPiece: priced.decorationCostPerPiece,
    lines,
    imprints,
  };
}

// ── DB store ─────────────────────────────────────────────────────────────

const rowSelect = {
  id: hubCalcHandoffsTable.id,
  status: hubCalcHandoffsTable.status,
  targetKind: hubCalcHandoffsTable.targetKind,
  orderId: hubCalcHandoffsTable.orderId,
  visualId: hubCalcHandoffsTable.visualId,
  requestDigest: hubCalcHandoffsTable.requestDigest,
  resultOrderId: hubCalcHandoffsTable.resultOrderId,
  resultVisualId: hubCalcHandoffsTable.resultVisualId,
  resultPublicUrl: hubCalcHandoffsTable.resultPublicUrl,
  resultGroupId: hubCalcHandoffsTable.resultGroupId,
  resultLineItemIds: hubCalcHandoffsTable.resultLineItemIds,
  error: hubCalcHandoffsTable.error,
};

export const dbHandoffStore: HandoffStore = {
  async find(key) {
    const [row] = await db.select(rowSelect).from(hubCalcHandoffsTable).where(eq(hubCalcHandoffsTable.operationKey, key)).limit(1);
    return row ?? null;
  },
  async findByRequestDigest(digest) {
    const [row] = await db
      .select(rowSelect)
      .from(hubCalcHandoffsTable)
      .where(eq(hubCalcHandoffsTable.requestDigest, digest))
      .orderBy(desc(hubCalcHandoffsTable.createdAt))
      .limit(1);
    return row ?? null;
  },
  async claim({ operationKey: key, snapshotHash: hash, requestDigest: digest, snapshot, actorEmail }) {
    const target = snapshot.target;
    const [row] = await db
      .insert(hubCalcHandoffsTable)
      .values({
        snapshotHash: hash,
        operationKey: key,
        requestDigest: digest,
        snapshot,
        targetKind: target.kind,
        mode: snapshot.mode,
        orderId: target.kind === "existing" ? target.orderId : null,
        visualId: target.kind === "existing" ? target.visualId : null,
        status: "attempting",
        attemptedAt: new Date(),
        actorEmail,
      })
      .onConflictDoNothing({ target: hubCalcHandoffsTable.operationKey })
      .returning(rowSelect);
    return row ?? null;
  },
  async markOk(id, result) {
    await db
      .update(hubCalcHandoffsTable)
      .set({ ...result, status: "ok", error: null, updatedAt: new Date() })
      .where(and(eq(hubCalcHandoffsTable.id, id), eq(hubCalcHandoffsTable.status, "attempting")));
  },
  async markUnknown(id, error) {
    await db
      .update(hubCalcHandoffsTable)
      .set({ status: "unknown", error, updatedAt: new Date() })
      .where(and(eq(hubCalcHandoffsTable.id, id), eq(hubCalcHandoffsTable.status, "attempting")));
  },
  async release(id) {
    const rows = await db
      .delete(hubCalcHandoffsTable)
      .where(and(eq(hubCalcHandoffsTable.id, id), eq(hubCalcHandoffsTable.status, "attempting")))
      .returning({ id: hubCalcHandoffsTable.id });
    return rows.length > 0;
  },
};

// ── Public entry points ────────────────────────────────────────────────

export async function previewHandoff(req: HandoffRequest) {
  const snapshot = await buildHandoffSnapshot(req);
  const hash = snapshotHash(snapshot);
  // Look up by the stable operation key so a completed or locked append is
  // still surfaced after the group count (and so the full hash) has moved.
  const existing = await dbHandoffStore.find(operationKey(snapshot));
  return { snapshot, snapshotHash: hash, existing: existing ? rowToResult(existing, true) : null };
}

export async function commitHandoff(
  req: HandoffRequest & { expectedSnapshotHash: string },
  actorEmail: string | null,
): Promise<HandoffResult> {
  const digest = requestDigest(req);
  // Fast path is bound to the exact canonical request, never to a client hash.
  const prior = await dbHandoffStore.findByRequestDigest(digest);
  if (prior?.status === "ok") return rowToResult(prior, true);
  if (prior) {
    throw new HandoffConflictError(
      prior.status === "unknown"
        ? `A previous attempt is locked with an uncertain result. Verify Printavo manually. ${prior.error ?? ""}`.trim()
        : "This exact handoff is already being sent. Do not retry.",
    );
  }
  const snapshot = await buildHandoffSnapshot(req);
  const key = operationKey(snapshot);
  const held = await dbHandoffStore.find(key);
  if (held) {
    assertSameRequest(held, digest);
    throw new HandoffConflictError("This handoff is already recorded. Refresh before acting again.");
  }
  const hash = snapshotHash(snapshot);
  if (hash !== req.expectedSnapshotHash) {
    throw new HandoffConflictError(
      "Pricing, matrices, categories, customer, or the destination changed since preview. Preview again before sending.",
    );
  }
  return executeHandoff({
    snapshot,
    operationKey: key,
    snapshotHash: hash,
    requestDigest: digest,
    actorEmail,
    store: dbHandoffStore,
    mutate: (mutation) => getPrintavoClient().mutate(mutation),
  });
}
