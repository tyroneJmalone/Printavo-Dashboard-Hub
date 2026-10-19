/**
 * Hub Price Calculator — Printavo push logic (invoices AND quotes).
 *
 * The target order type is derived from the local pv_orders mirror (never
 * from the client) and selects invoiceUpdate vs quoteUpdate for the note
 * write. Quote→invoice conversion replaces the mirror row under a new
 * Printavo id, so a stale target fails closed with a re-select message.
 *
 * Safety rules:
 * 1. noteAttemptedAt / fileAttemptedAt are set atomically via conditional
 *    UPDATE … WHERE <col> IS NULL before any client.mutate call. If the
 *    timestamp was already set (by a prior attempt), the mutation is never
 *    re-issued. The note can recover to note_ok via a live read if the
 *    exact block is already in the invoice; the file is permanently locked
 *    for manual verification (productionFileCreate is not idempotent).
 * 2. The GCS object is verified (exists + size + content-type) before any
 *    Printavo write.
 * 3. The live invoice visualId is compared to the request before mutating.
 * 4. Submitted priceRows must match the snapshot stored in the upload row.
 * 5. Repeated identical confirmed requests are idempotent.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, hubCalcUploadsTable, pvOrdersTable } from "@workspace/db";
import { getPrintavoClient } from "../printavoGateway";
import {
  invoiceByIdQuery,
  invoiceUpdateMutation,
  quoteByIdQuery,
  quoteUpdateMutation,
  productionFileCreateMutation,
} from "@workspace/printavo";
import { hubCalcPngPublicUrl, verifyAndConfirmPngUploaded } from "./pngStorage";
import {
  lineItemSnapshotsEqual,
  pushCalculatorLineItem,
  type LineItemPushOutcome,
} from "./calcLineItems";
import {
  normalizeNoteSections,
  noteSectionsEqual,
  type HubCalculatorLineItemInput,
  type NoteSection,
} from "./pureHelpers";
import { resolveConfirmedHandoffQuote } from "./pushTarget";
import { CalcPushError } from "./calcPushError";
export { CalcPushError } from "./calcPushError";

// ── Types ────────────────────────────────────────────────────────────────

export type CalcPushStatus =
  | "note_ok"
  | "file_ok"
  | "note_failed"
  | "file_failed"
  | "file_locked"
  | "partial";

export interface CalcPushResult {
  uploadId: string;
  status: CalcPushStatus;
  noteOutcome: { ok: boolean; locked?: boolean; error?: string };
  fileOutcome: { ok: boolean; locked?: boolean; productionFileId?: string; error?: string };
  lineItemOutcome: LineItemPushOutcome;
}

export interface CalcPushRequest {
  uploadId: string;
  invoiceId: string;
  visualId: number;
  rangeKey: string;
  priceRows: Array<{ qty: number; unitPrice: number }>;
  noteSections?: NoteSection[] | null;
  quoteNumber: string;
  lineItem?: HubCalculatorLineItemInput | null;
}

async function assertFinalizedPngReady(uploadId: string): Promise<void> {
  const result = await verifyAndConfirmPngUploaded(uploadId);
  if (!result.ok) {
    throw new CalcPushError(`PNG upload verification failed: ${result.reason}`, "upload_not_ready");
  }
}

// ── Note block pure helpers (exported for tests) ─────────────────────────

/**
 * Build the opening block marker.
 * Format: [Hub Price Calculator Q<quoteNumber>]
 * The range lives inside the block so changing ranges refreshes the same
 * calculator block for a quote instead of accumulating stale blocks.
 */
export function blockMarker(
  quoteNumber: string,
  _rangeKey: string,
): string {
  if (!/^\d{1,20}$/.test(quoteNumber)) {
    throw new Error("A 1–20 digit Printavo quote number is required");
  }
  return `[Hub Price Calculator Q${quoteNumber}]`;
}

/**
 * Multi-style variant: ONE block (same marker, so one safe splice replaces
 * any earlier single- or multi-style block for this order).
 */
export function buildMultiNoteBlock(
  quoteNumber: string,
  rangeKey: string,
  sections: NoteSection[],
): string {
  const open = blockMarker(quoteNumber, rangeKey);
  const close = open.replace("[Hub Price Calculator", "[/Hub Price Calculator");
  const normalized = normalizeNoteSections(sections);
  const body: string[] = [];
  if (normalized[0]?.kind === "order") {
    const combined = normalized.reduce((sum, s) => sum + s.rows[0]!.qty, 0);
    body.push(`Mixed order: ${combined} pcs combined`, "Style\tPcs\tUnit Price");
    for (const s of normalized) body.push(`${s.label}\t${s.rows[0]!.qty}\t$${s.rows[0]!.unitPrice.toFixed(2)}`);
  } else {
    const rangeLabel = rangeKey === "all" ? "All" : rangeKey.replace("-", "–");
    body.push(`Range: ${rangeLabel}`, `Compare styles: ${normalized.length}`);
    for (const s of normalized) {
      body.push("", s.label, "QTY\tUnit Price", ...s.rows.map((r) => `${r.qty}+\t$${r.unitPrice.toFixed(2)}`));
    }
  }
  return [open, ...body, close].join("\n");
}

/**
 * Build the note block. Display only QTY and Unit Price (no total).
 * Includes a deterministic range label and optional quote number.
 */
export function buildNoteBlock(
  quoteNumber: string,
  rangeKey: string,
  priceRows: Array<{ qty: number; unitPrice: number }>,
): string {
  const open = blockMarker(quoteNumber, rangeKey);
  const close = open.replace("[Hub Price Calculator", "[/Hub Price Calculator");
  const rangeLabel = rangeKey === "all" ? "All" : rangeKey.replace("-", "–");
  const lines = priceRows.map((r) => `${r.qty}+\t$${r.unitPrice.toFixed(2)}`);
  return [open, `Range: ${rangeLabel}`, "QTY\tUnit Price", ...lines, close].join(
    "\n",
  );
}

export class MalformedHubNoteBlockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedHubNoteBlockError";
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replace or insert the Hub Price Calculator block in the existing note.
 * Identified by the opening marker; appends if no matching block exists.
 * Preserves all content outside the block.
 */
export function spliceNoteBlock(
  existingNote: string | null | undefined,
  newBlock: string,
  quoteNumber: string,
  rangeKey: string,
): string {
  const note = existingNote ?? "";
  const openMarker = blockMarker(quoteNumber, rangeKey);
  const closeVariant = openMarker.replace(
    "[Hub Price Calculator",
    "[/Hub Price Calculator",
  );

  const tokenPattern = new RegExp(
    `(^|\\n)(${escapeRegExp(openMarker)}|${escapeRegExp(closeVariant)})(?=\\r?(?:\\n|$))`,
    "g",
  );
  const blocks: Array<{ start: number; end: number }> = [];
  let openStart: number | null = null;
  let token: RegExpExecArray | null;

  while ((token = tokenPattern.exec(note)) !== null) {
    const marker = token[2]!;
    const markerStart = token.index + token[1]!.length;
    const markerEnd = markerStart + marker.length;

    if (marker === openMarker) {
      if (openStart !== null) {
        throw new MalformedHubNoteBlockError(
          `Production Notes contain nested or duplicate unclosed Hub blocks for quote ${quoteNumber}. No notes were changed.`,
        );
      }
      openStart = markerStart;
      continue;
    }

    if (openStart === null) {
      throw new MalformedHubNoteBlockError(
        `Production Notes contain an unmatched Hub closing marker for quote ${quoteNumber}. No notes were changed.`,
      );
    }
    blocks.push({ start: openStart, end: markerEnd });
    openStart = null;
  }

  if (openStart !== null) {
    throw new MalformedHubNoteBlockError(
      `Production Notes contain an unclosed Hub block for quote ${quoteNumber}. No notes were changed.`,
    );
  }

  if (blocks.length === 0) {
    if (!note) return newBlock;
    return `${note}${note.endsWith("\n") ? "\n" : "\n\n"}${newBlock}`;
  }

  let result = "";
  let cursor = 0;
  blocks.forEach((block, index) => {
    result += note.slice(cursor, block.start);
    if (index === 0) result += newBlock;
    cursor = block.end;
  });
  result += note.slice(cursor);
  return result;
}

/** True when the exact block text already appears in the note. */
export function noteContainsBlock(
  note: string | null | undefined,
  newBlock: string,
): boolean {
  if (!note) return false;
  return note.includes(newBlock);
}

/**
 * Compare two priceRows arrays for equality (same qtys + unitPrices,
 * order-independent).
 */
export function priceRowsEqual(
  a: Array<{ qty: number; unitPrice: number }>,
  b: Array<{ qty: number; unitPrice: number }>,
): boolean {
  if (a.length !== b.length) return false;
  const sorted = (rows: typeof a) =>
    [...rows].sort((x, y) => x.qty - y.qty);
  const sa = sorted(a);
  const sb = sorted(b);
  return sa.every(
    (r, i) => r.qty === sb[i]!.qty && r.unitPrice === sb[i]!.unitPrice,
  );
}

// ── Live order fetch (invoice or quote) ─────────────────────────────────

export type HubPushOrderType = "invoice" | "quote";

async function fetchLiveOrder(
  orderId: string,
  orderType: HubPushOrderType,
): Promise<{ productionNote: string | null; visualId: number } | null> {
  const client = getPrintavoClient();
  if (orderType === "quote") {
    // NOTE: Quote.visualId is a String in the Printavo schema — normalize.
    const result = await client.query<{
      quote: { id: string; visualId: number | string; productionNote: string | null } | null;
    }>(quoteByIdQuery(orderId));
    if (!result.quote) return null;
    return {
      productionNote: result.quote.productionNote ?? null,
      visualId: Number(result.quote.visualId),
    };
  }
  const result = await client.query<{
    invoice: { id: string; visualId: number | string; productionNote: string | null } | null;
  }>(invoiceByIdQuery(orderId));
  if (!result.invoice) return null;
  return {
    productionNote: result.invoice.productionNote ?? null,
    visualId: Number(result.invoice.visualId),
  };
}

// ── Local mirror lookup (visualId + order type) ──────────────────────────

async function fetchMirrorOrder(
  orderId: string,
): Promise<{ visualId: number; orderType: HubPushOrderType } | null> {
  const [row] = await db
    .select({
      visualId: pvOrdersTable.visualId,
      orderType: pvOrdersTable.orderType,
    })
    .from(pvOrdersTable)
    .where(
      and(
        eq(pvOrdersTable.printavoId, orderId),
        inArray(pvOrdersTable.orderType, ["invoice", "quote"]),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    visualId: row.visualId,
    orderType: row.orderType === "quote" ? "quote" : "invoice",
  };
}

// ── Main push ────────────────────────────────────────────────────────────

export async function pushCalcToInvoice(
  req: CalcPushRequest,
): Promise<CalcPushResult> {
  // ── 1. Load and validate the upload row ────────────────────────────────
  const [upload] = await db
    .select()
    .from(hubCalcUploadsTable)
    .where(eq(hubCalcUploadsTable.id, req.uploadId))
    .limit(1);

  if (!upload) throw new CalcPushError("Upload row not found", "not_found");

  if (upload.invoiceId !== req.invoiceId || upload.visualId !== req.visualId) {
    throw new CalcPushError(
      "Request invoiceId/visualId does not match upload row",
      "invalid",
    );
  }
  if (upload.rangeKey !== req.rangeKey) {
    throw new CalcPushError("Request rangeKey does not match upload row", "invalid");
  }
  const requestedQuoteNumber = req.quoteNumber.trim();
  if (!/^\d{1,20}$/.test(requestedQuoteNumber) || !upload.quoteNumber) {
    throw new CalcPushError(
      "A 1–20 digit Printavo quote number is required",
      "invalid",
    );
  }
  if (requestedQuoteNumber !== upload.quoteNumber) {
    throw new CalcPushError(
      "Request quoteNumber does not match upload row",
      "invalid",
    );
  }

  // ── 2. Verify submitted rows match stored snapshot ─────────────────────
  const storedRows = (upload.priceRows as Array<{ qty: number; unitPrice: number }> | null) ?? [];
  if (!priceRowsEqual(req.priceRows, storedRows)) {
    throw new CalcPushError(
      "Submitted priceRows do not match the stored upload snapshot — use the upload row's priceRows",
      "invalid",
    );
  }
  const storedSections = (upload.noteSections as NoteSection[] | null) ?? null;
  if (!noteSectionsEqual(req.noteSections ?? null, storedSections)) {
    throw new CalcPushError(
      "Submitted noteSections do not match the stored upload snapshot",
      "invalid",
    );
  }
  const storedLineItem =
    (upload.lineItemSnapshot as HubCalculatorLineItemInput | null) ?? null;
  if (!lineItemSnapshotsEqual(req.lineItem, storedLineItem)) {
    throw new CalcPushError(
      "Submitted lineItem does not match the stored upload snapshot",
      "invalid",
    );
  }

  // ── 3. Validate order (invoice or quote) against local mirror ──────────
  // A quote this Hub just created via handoff may not be mirrored yet; its
  // confirmed (id, visualId) from the handoff row is re-verified live.
  const mirror =
    (await fetchMirrorOrder(req.invoiceId)) ??
    (await resolveConfirmedHandoffQuote(req.invoiceId, req.visualId));
  if (mirror === null) {
    // The id may be stale because Printavo quote→invoice conversion replaces
    // the quote row with an invoice row under a NEW Printavo id (same visual
    // number). Detect that and tell the user to re-select — never silently
    // redirect a write to an order they did not pick.
    const [replacement] = await db
      .select({ orderType: pvOrdersTable.orderType })
      .from(pvOrdersTable)
      .where(
        and(
          eq(pvOrdersTable.visualId, req.visualId),
          inArray(pvOrdersTable.orderType, ["invoice", "quote"]),
        ),
      )
      .limit(1);
    if (replacement) {
      throw new CalcPushError(
        `#${req.visualId} was converted to an ${replacement.orderType} in Printavo since it was selected — search for #${req.visualId} again and push to the ${replacement.orderType}.`,
        "not_found",
      );
    }
    throw new CalcPushError(
      `Invoice or quote "${req.invoiceId}" not found in local mirror`,
      "not_found",
    );
  }
  if (mirror.visualId !== req.visualId) {
    throw new CalcPushError(
      `Mirror visualId ${mirror.visualId} does not match request visualId ${req.visualId}`,
      "invalid",
    );
  }
  const orderType: HubPushOrderType = mirror.orderType;

  // ── 4. Finalize and verify the staged PNG before any Printavo work ─────
  await assertFinalizedPngReady(req.uploadId);

  // ── 5. Build the note block ────────────────────────────────────────────
  const effectiveQuoteNumber = upload.quoteNumber;
  const newBlock = storedSections
    ? buildMultiNoteBlock(effectiveQuoteNumber, req.rangeKey, storedSections)
    : buildNoteBlock(effectiveQuoteNumber, req.rangeKey, req.priceRows);

  // ── 6. Check fully-done idempotency ───────────────────────────────────
  const fileAlreadyAttached = Boolean(upload.productionFileId);
  let confirmedNoteMissing = false;
  if (fileAlreadyAttached) {
    // Live read to confirm note is present too
    const live = await fetchLiveOrder(req.invoiceId, orderType);
    const liveVisualId = live?.visualId;
    if (liveVisualId !== undefined && liveVisualId !== req.visualId) {
      throw new CalcPushError(
        `Live ${orderType} visualId ${liveVisualId} does not match request ${req.visualId}`,
        "invalid",
      );
    }
    const noteAlreadyPresent = noteContainsBlock(live?.productionNote, newBlock);
    const lineItemAlreadyComplete =
      !storedLineItem || Boolean(upload.lineItemGroupId && upload.lineItemId);
    if (noteAlreadyPresent && lineItemAlreadyComplete) {
      return {
        uploadId: req.uploadId,
        status: "file_ok",
        noteOutcome: { ok: true },
        fileOutcome: { ok: true, productionFileId: upload.productionFileId! },
        lineItemOutcome: storedLineItem
          ? {
              requested: true,
              ok: true,
              lineItemGroupId: upload.lineItemGroupId!,
              lineItemId: upload.lineItemId!,
            }
          : { requested: false, ok: false },
      };
    }
    // The file is confirmed, but the deterministic note block is missing.
    // Route this through the note lock/recovery rules without ever re-attaching.
    confirmedNoteMissing = true;
  }

  const client = getPrintavoClient();

  // ── 7. Note attempt-lock + mutation ───────────────────────────────────
  let noteOk = confirmedNoteMissing ? false : upload.noteOk;
  let noteError: string | undefined;
  let noteLocked = false;

  if (!noteOk) {
    // Check: was a prior note attempt made without success?
    if (upload.noteAttemptedAt !== null) {
      // Prior attempt exists without noteOk — try a live read to recover
      const live = await fetchLiveOrder(req.invoiceId, orderType);
      if (live && noteContainsBlock(live.productionNote, newBlock)) {
        // Block already in live note — recover
        noteOk = true;
        await db
          .update(hubCalcUploadsTable)
          .set({ noteOk: true, status: "note_ok", updatedAt: new Date() })
          .where(eq(hubCalcUploadsTable.id, req.uploadId));
      } else {
        // Lock: prior attempt didn't land, outcome ambiguous
        noteLocked = true;
        noteError = upload.noteError ?? "Note mutation was previously attempted without confirmed success";
      }
    } else {
      // Atomically claim the note mutation
      const liveInvoice = await fetchLiveOrder(req.invoiceId, orderType);
      if (!liveInvoice) {
        throw new CalcPushError(
          `Live Printavo ${orderType} was not found`,
          "not_found",
        );
      }

      // Verify live visualId
      if (liveInvoice.visualId !== req.visualId) {
        throw new CalcPushError(
          `Live ${orderType} visualId ${liveInvoice.visualId} does not match request ${req.visualId}`,
          "invalid",
        );
      }

      // Check if block already present (idempotent note)
      if (noteContainsBlock(liveInvoice.productionNote, newBlock)) {
        noteOk = true;
        await db
          .update(hubCalcUploadsTable)
          .set({ noteOk: true, status: "note_ok", updatedAt: new Date() })
          .where(eq(hubCalcUploadsTable.id, req.uploadId));
      } else {
        try {
          spliceNoteBlock(
            liveInvoice.productionNote,
            newBlock,
            effectiveQuoteNumber,
            req.rangeKey,
          );
        } catch (err) {
          if (!(err instanceof MalformedHubNoteBlockError)) throw err;
          noteLocked = true;
          noteError = err.message;
          await db
            .update(hubCalcUploadsTable)
            .set({
              status: "note_failed",
              noteError,
              noteErrorAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(hubCalcUploadsTable.id, req.uploadId));
        }
      }

      if (!noteOk && !noteLocked) {
        // Atomically claim: set note_attempted_at only if still null
        const claimResult = await db
          .update(hubCalcUploadsTable)
          .set({ noteAttemptedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(hubCalcUploadsTable.id, req.uploadId),
              isNull(hubCalcUploadsTable.noteAttemptedAt),
            ),
          )
          .returning({ id: hubCalcUploadsTable.id });

        if (claimResult.length === 0) {
          // Lost the race — another request claimed it
          throw new CalcPushError(
            "Note mutation is being attempted by another request",
            "conflict",
          );
        }

        const splicedNote = spliceNoteBlock(
          liveInvoice.productionNote,
          newBlock,
          effectiveQuoteNumber,
          req.rangeKey,
        );

        try {
          await assertFinalizedPngReady(req.uploadId);
          if (orderType === "quote") {
            await client.mutate<{
              quoteUpdate: { id: string; productionNote: string | null };
            }>(quoteUpdateMutation(req.invoiceId, { productionNote: splicedNote }));
          } else {
            await client.mutate<{
              invoiceUpdate: { id: string; productionNote: string | null };
            }>(invoiceUpdateMutation(req.invoiceId, { productionNote: splicedNote }));
          }

          noteOk = true;
          await db
            .update(hubCalcUploadsTable)
            .set({ noteOk: true, status: "note_ok", updatedAt: new Date() })
            .where(eq(hubCalcUploadsTable.id, req.uploadId));
        } catch (err) {
          if (err instanceof CalcPushError && err.kind === "upload_not_ready") {
            await db
              .update(hubCalcUploadsTable)
              .set({ noteAttemptedAt: null, updatedAt: new Date() })
              .where(eq(hubCalcUploadsTable.id, req.uploadId));
            throw err;
          }
          noteError = err instanceof Error ? err.message : String(err);
          await db
            .update(hubCalcUploadsTable)
            .set({
              status: "note_failed",
              noteError,
              noteErrorAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(hubCalcUploadsTable.id, req.uploadId));
          noteLocked = true;
          try {
            const verification = await fetchLiveOrder(req.invoiceId, orderType);
            if (
              verification &&
              noteContainsBlock(verification.productionNote, newBlock)
            ) {
              noteOk = true;
              noteLocked = false;
              await db
                .update(hubCalcUploadsTable)
                .set({ noteOk: true, status: "note_ok", updatedAt: new Date() })
                .where(eq(hubCalcUploadsTable.id, req.uploadId));
            }
          } catch {
            // The original mutation result remains ambiguous and locked.
          }
        }
      }
    }
  }

  // ── 8. File attempt-lock + mutation ───────────────────────────────────
  let fileOk = fileAlreadyAttached;
  let fileError: string | undefined;
  let fileLocked = false;
  let productionFileId: string | undefined = upload.productionFileId ?? undefined;

  if (!fileAlreadyAttached && noteOk && !noteLocked) {
    // Check: was a prior file attempt made without a productionFileId?
    if (upload.fileAttemptedAt !== null) {
      // Prior attempt without confirmed id — permanently locked for manual check
      fileLocked = true;
      fileError =
        upload.fileError ??
        "productionFileCreate was previously attempted with ambiguous outcome — manual verification required";
    } else if (!(await fetchLiveOrder(req.invoiceId, orderType))) {
      // Revalidate the live target before consuming the single file attempt.
      // A quote can be converted (or an order deleted) between the note write
      // and the file attach; attempting productionFileCreate against the dead
      // parent would permanently lock this upload for no benefit. Leave the
      // attempt unclaimed so a re-selected push can proceed cleanly.
      fileError = `Production file was not attempted: the live Printavo ${orderType} was not found (it may have been converted or deleted). Search for #${req.visualId} again and push to the current order.`;
    } else {
      // Atomically claim the file mutation
      const claimResult = await db
        .update(hubCalcUploadsTable)
        .set({ fileAttemptedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(hubCalcUploadsTable.id, req.uploadId),
            isNull(hubCalcUploadsTable.fileAttemptedAt),
          ),
        )
        .returning({ id: hubCalcUploadsTable.id });

      if (claimResult.length === 0) {
        // Lost the race
        throw new CalcPushError(
          "File attach is being attempted by another request",
          "conflict",
        );
      }

      const publicUrl = hubCalcPngPublicUrl(upload.publicToken, upload.publicFilename);

      // If the DB write after mutate fails, the row retains fileAttemptedAt
      // without productionFileId — permanently locked on the next call.
      try {
        await assertFinalizedPngReady(req.uploadId);
        const fileResult = await client.mutate<{
          productionFileCreate: { id: string; fileUrl: string };
        }>(productionFileCreateMutation(req.invoiceId, publicUrl));

        productionFileId = fileResult.productionFileCreate.id;
        fileOk = true;

        // Persist IMMEDIATELY — productionFileCreate is not idempotent
        await db
          .update(hubCalcUploadsTable)
          .set({
            status: "file_ok",
            productionFileId,
            updatedAt: new Date(),
          })
          .where(eq(hubCalcUploadsTable.id, req.uploadId));
      } catch (err) {
        if (err instanceof CalcPushError && err.kind === "upload_not_ready") {
          await db
            .update(hubCalcUploadsTable)
            .set({ fileAttemptedAt: null, updatedAt: new Date() })
            .where(eq(hubCalcUploadsTable.id, req.uploadId));
          throw err;
        }
        fileError = err instanceof Error ? err.message : String(err);
        fileLocked = true;
        await db
          .update(hubCalcUploadsTable)
          .set({
            status: "file_locked",
            fileError,
            fileErrorAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(hubCalcUploadsTable.id, req.uploadId));
      }
    }
  } else if (!fileAlreadyAttached && !noteOk) {
    fileError =
      "Production file was not attempted because the Production Notes update was not confirmed.";
  }

  // ── 9. Optional invoice-only line item (independent one-attempt write) ──
  const lineItemOutcome = await pushCalculatorLineItem({
    uploadId: req.uploadId,
    invoiceId: req.invoiceId,
    visualId: req.visualId,
    snapshot: storedLineItem,
    priceRows: req.priceRows,
    attemptedAt: upload.lineItemAttemptedAt,
    existingGroupId: upload.lineItemGroupId,
    existingLineItemId: upload.lineItemId,
    existingError: upload.lineItemError,
  });

  // ── 10. Final status ───────────────────────────────────────────────────
  const finalStatus: CalcPushStatus =
    noteLocked
      ? "note_failed"
      : fileLocked
        ? "file_locked"
        : noteOk && fileOk
          ? "file_ok"
          : noteOk && !fileOk
            ? "partial"
            : "note_failed";

  return {
    uploadId: req.uploadId,
    status: finalStatus,
    noteOutcome: { ok: noteOk, locked: noteLocked || undefined, error: noteError },
    fileOutcome: {
      ok: fileOk,
      locked: fileLocked || undefined,
      productionFileId,
      error: fileError,
    },
    lineItemOutcome,
  };
}
