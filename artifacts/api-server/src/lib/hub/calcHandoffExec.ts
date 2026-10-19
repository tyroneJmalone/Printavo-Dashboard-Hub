/**
 * Multi-style handoff — one-attempt execution core (no DB/gateway imports, so
 * it is unit-testable with an in-memory store and a mocked transport).
 */
import { PrintavoApiError, calculatorHandoffGroupCreateMutation, quoteCreateMutation } from "@workspace/printavo";
import type { HubCalcHandoff } from "@workspace/db";
import { HandoffValidationError, type HandoffLine } from "./calcHandoffPure";

export class HandoffConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HandoffConflictError";
  }
}

export type HandoffTarget =
  | { kind: "existing"; orderId: string; visualId: number; orderType: "invoice" | "quote"; groupPosition: number }
  | {
      kind: "new_quote";
      customerId: string;
      companyName: string;
      contactId: string;
      contactName: string | null;
      nickname: string;
      dueDate: string;
    };

export interface HandoffSnapshot {
  target: HandoffTarget;
  mode: "compare" | "mixed";
  markup: number;
  rangeKey: string | null;
  combinedQuantity: number | null;
  decorationCostPerPiece: number | null;
  lines: HandoffLine[];
  imprints: Array<{ details: string; matrixName: string; columnLabel: string; pricingMatrixColumnId: string }>;
}

export interface HandoffResult {
  handoffId: string;
  status: "ok" | "attempting" | "unknown";
  deduped: boolean;
  targetKind: "existing" | "new_quote";
  orderId: string | null;
  visualId: number | null;
  publicUrl: string | null;
  printavoUrl: string | null;
  lineItemGroupId: string | null;
  lineItemIds: string[];
  error: string | null;
}

export function newYorkDueAt(date: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    timeZoneName: "longOffset",
  }).formatToParts(new Date(`${date}T12:00:00Z`));
  const zone = parts.find((part) => part.type === "timeZoneName")?.value;
  const match = zone?.match(/^GMT([+-]\d{2}:\d{2})$/);
  if (!match) throw new HandoffValidationError("Could not resolve the America/New_York due-time offset.");
  return `${date}T17:00:00${match[1]}`;
}

/** Same narrow rule as quote drafts: HTTP 200, no data, only input-field validation errors. */
export function isDefinitiveGraphqlValidationRejection(err: unknown): boolean {
  if (!(err instanceof PrintavoApiError) || err.httpStatus !== 200 || err.partialData !== undefined || !err.graphqlErrors?.length) {
    return false;
  }
  return err.graphqlErrors.every((e) => {
    const message = e && typeof e === "object" ? (e as { message?: unknown }).message : undefined;
    return typeof message === "string" && /^InputObject '.+' doesn't accept argument '.+'$/.test(message);
  });
}

export function buildHandoffMutation(snapshot: HandoffSnapshot, handoffId: string): string {
  const imprints = snapshot.imprints.map((i) => ({ details: i.details, pricingMatrixColumnId: i.pricingMatrixColumnId }));
  if (snapshot.target.kind === "existing") {
    return calculatorHandoffGroupCreateMutation(snapshot.target.orderId, {
      position: snapshot.target.groupPosition,
      lineItems: snapshot.lines.map((line, index) => ({
        position: index,
        categoryId: line.categoryId,
        itemNumber: line.itemNumber,
        color: line.color,
        description: line.description,
        price: line.price,
        sizes: line.sizes,
      })),
      imprints,
    });
  }
  const t = snapshot.target;
  const modeNote =
    snapshot.mode === "compare"
      ? "Compare styles: each line carries a quantity price schedule. No quantities have been ordered."
      : `Mixed order: combined ${snapshot.combinedQuantity} pcs set the shared decoration tier.`;
  return quoteCreateMutation({
    contactId: t.contactId,
    customerDueAt: t.dueDate,
    dueAt: newYorkDueAt(t.dueDate),
    nickname: t.nickname,
    productionNote: [modeNote, `Created from Hub Price Calculator handoff ${handoffId}.`].join("\n\n"),
    lineItemGroups: [
      {
        position: 1,
        lineItems: snapshot.lines.map((line, index) => ({
          position: index + 1,
          categoryId: line.categoryId,
          itemNumber: line.itemNumber,
          description: line.description,
          color: line.color,
          price: line.price,
          markupPercentage: snapshot.markup * 100,
          productStatus: null,
          sizes: line.sizes,
        })),
        imprints,
      },
    ],
  });
}

// ── Claim / execute (dependency-injected for tests) ─────────────────────

export interface HandoffStore {
  find(operationKey: string): Promise<HandoffRowLike | null>;
  findByRequestDigest(digest: string): Promise<HandoffRowLike | null>;
  claim(row: {
    operationKey: string;
    snapshotHash: string;
    requestDigest: string;
    snapshot: HandoffSnapshot;
    actorEmail: string | null;
  }): Promise<HandoffRowLike | null>;
  markOk(id: string, result: Partial<HandoffRowLike>): Promise<void>;
  markUnknown(id: string, error: string): Promise<void>;
  release(id: string): Promise<boolean>;
}

export type HandoffRowLike = Pick<
  HubCalcHandoff,
  "id" | "requestDigest" | "status" | "targetKind" | "orderId" | "visualId" | "resultOrderId" | "resultVisualId" | "resultPublicUrl" | "resultGroupId" | "resultLineItemIds" | "error"
>;

export type HandoffMutate = (mutation: string) => Promise<unknown>;

export function rowToResult(row: HandoffRowLike, deduped: boolean): HandoffResult {
  const visualId = row.resultVisualId ?? row.visualId ?? null;
  return {
    handoffId: row.id,
    status: row.status,
    deduped,
    targetKind: row.targetKind === "new_quote" ? "new_quote" : "existing",
    orderId: row.resultOrderId ?? row.orderId ?? null,
    visualId,
    publicUrl: row.resultPublicUrl ?? null,
    printavoUrl: row.status === "ok" && visualId !== null ? `https://www.printavo.com/invoices/${visualId}` : null,
    lineItemGroupId: row.resultGroupId ?? null,
    lineItemIds: row.resultLineItemIds ?? [],
    error: row.error ?? null,
  };
}

/** A stored operation may only be answered for the exact request that claimed it. */
export function assertSameRequest(row: HandoffRowLike, digest: string): void {
  if (row.requestDigest !== digest) {
    throw new HandoffConflictError(
      row.status === "ok"
        ? "This content was already sent to this destination by a different request. Verify Printavo before sending again."
        : "A different request holds this handoff. Verify Printavo manually before doing anything else.",
    );
  }
}

/** Validate the success payload; anything malformed is treated as uncertain. */
export function extractHandoffResult(
  snapshot: HandoffSnapshot,
  response: unknown,
): Partial<HandoffRowLike> | null {
  const isId = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  if (snapshot.target.kind === "existing") {
    const created = (response as { lineItemGroupCreate?: { id?: unknown; lineItems?: { nodes?: Array<{ id?: unknown }> } } } | null)
      ?.lineItemGroupCreate;
    const ids = created?.lineItems?.nodes?.map((n) => n?.id) ?? [];
    if (!isId(created?.id)) return null;
    if (ids.length !== snapshot.lines.length || !ids.every(isId) || new Set(ids).size !== ids.length) return null;
    return {
      resultOrderId: snapshot.target.orderId,
      resultVisualId: snapshot.target.visualId,
      resultGroupId: created.id,
      resultLineItemIds: ids as string[],
    };
  }
  const created = (response as { quoteCreate?: { id?: unknown; visualId?: unknown; publicUrl?: unknown } } | null)?.quoteCreate;
  const visualId = Number(created?.visualId);
  if (!isId(created?.id) || !Number.isInteger(visualId) || visualId <= 0) return null;
  return {
    resultOrderId: created.id,
    resultVisualId: visualId,
    resultPublicUrl: typeof created.publicUrl === "string" ? created.publicUrl : null,
  };
}

export async function executeHandoff(opts: {
  snapshot: HandoffSnapshot;
  operationKey: string;
  snapshotHash: string;
  requestDigest: string;
  actorEmail: string | null;
  store: HandoffStore;
  mutate: HandoffMutate;
}): Promise<HandoffResult> {
  const { snapshot, store } = opts;
  const claimed = await store.claim({
    operationKey: opts.operationKey,
    snapshotHash: opts.snapshotHash,
    requestDigest: opts.requestDigest,
    snapshot,
    actorEmail: opts.actorEmail,
  });
  if (!claimed) {
    const existing = await store.find(opts.operationKey);
    if (!existing) throw new HandoffConflictError("Another request is handling this handoff. Refresh before acting again.");
    assertSameRequest(existing, opts.requestDigest);
    if (existing.status === "ok") return rowToResult(existing, true);
    throw new HandoffConflictError(
      existing.status === "unknown"
        ? `A previous attempt returned an uncertain result and is locked. Verify Printavo manually. ${existing.error ?? ""}`.trim()
        : "This exact handoff is already being sent. Do not retry; refresh in a moment.",
    );
  }

  let response: unknown;
  try {
    response = await opts.mutate(buildHandoffMutation(snapshot, claimed.id));
  } catch (err) {
    if (isDefinitiveGraphqlValidationRejection(err)) {
      const released = await store.release(claimed.id);
      if (!released) {
        throw new HandoffConflictError("Printavo rejected the request before writing, but the claim could not be released. Verify before retrying.");
      }
      throw new HandoffValidationError("Printavo rejected the request before writing anything. Review and try again.");
    }
    const message = err instanceof Error ? err.message : String(err);
    await store.markUnknown(
      claimed.id,
      `Printavo returned an uncertain result. Locked to prevent duplicates; verify manually. ${message.slice(0, 800)}`,
    );
    throw new HandoffConflictError("Printavo returned an uncertain result. This handoff is locked; verify Printavo manually before doing anything else.");
  }

  const patch = extractHandoffResult(snapshot, response);
  if (!patch) {
    await store.markUnknown(
      claimed.id,
      "Printavo responded without the expected created ids. Locked to prevent duplicates; verify manually.",
    );
    throw new HandoffConflictError("Printavo's response was incomplete. This handoff is locked; verify Printavo manually.");
  }
  // The write landed; never mark it unknown from here. A failed persist leaves
  // the row `attempting`, which stays locked (no duplicate possible).
  await store.markOk(claimed.id, patch);
  return rowToResult({ ...claimed, ...patch, status: "ok", error: null }, false);
}

