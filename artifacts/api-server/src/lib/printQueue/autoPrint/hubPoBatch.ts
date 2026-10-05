import { createHash } from "node:crypto";
import type { PoFileDto } from "../../purchasing/poFiles";
import { renderPoHtml } from "../../purchasing/poHtml";
import type { submitPdfPrintJob } from "./printNode";

export interface SuccessfullyPrintedOrder {
  orderId: string;
  visualId: string | number | null;
  isReprint?: boolean;
  priorPrintedAt?: Date | string | null;
  /**
   * Original snapshot ids independently verified to belong to this converted
   * order. A shared visual id alone is NEVER sufficient evidence.
   */
  verifiedSnapshotOrderIds?: readonly string[];
}

export interface HubPoBatchInput {
  runId: string;
  successfullyPrintedOrders: readonly SuccessfullyPrintedOrder[];
  printerId: string | number;
  printerName: string | null;
  dryRun: boolean;
  renderPdf: (html: string) => Promise<Buffer>;
}

export interface HubPoSnapshotMetadata {
  version: 1;
  capturedAt: string;
  sha256: string;
  po: PoFileDto;
  matchedOrders: SuccessfullyPrintedOrder[];
}

export interface HubPoReservation {
  runId: string;
  hubPoId: string;
  hubPoNumber: string;
  printavoOrderId: string;
  visualId: string | null;
  printerId: string;
  printerName: string | null;
  docType: "hub_po";
  copies: 1;
  status: "pending";
  snapshotMetadata: HubPoSnapshotMetadata;
}

export interface HubPoJobUpdate {
  status: "printed" | "failed" | "submission_unknown";
  errorMessage: string | null;
  printnodeJobId?: string;
  printedAt?: Date;
}

export interface HubPoBatchDependencies {
  loadRelevantPos: (orders: readonly SuccessfullyPrintedOrder[]) => Promise<PoFileDto[]>;
  /** Atomic durable insert; null means ANY existing reservation won this run/PO. */
  reserve: (job: HubPoReservation) => Promise<string | null>;
  updateJob: (id: string, update: HubPoJobUpdate) => Promise<void>;
  submit: typeof submitPdfPrintJob;
}

export interface HubPoBatchResult {
  printed: number;
  failed: number;
  unknown: number;
  skipped: number;
  warnings: string[];
}

function matches(po: PoFileDto, order: SuccessfullyPrintedOrder): boolean {
  // Reprints must not bring back the original PO. Editing or submitting an
  // existing PO does not make it new; compare immutable creation time only.
  if (order.isReprint) {
    const prior = order.priorPrintedAt == null ? NaN : new Date(order.priorPrintedAt).getTime();
    const created = new Date(po.createdAt).getTime();
    if (!Number.isFinite(prior) || !Number.isFinite(created) || created <= prior) return false;
  }
  return po.lineItems.some((line) => {
    if (!line.printavoOrderId) return false;
    if (line.printavoOrderId === order.orderId) return true;
    return order.visualId != null
      && line.visualId != null
      && String(line.visualId) === String(order.visualId)
      && !!order.verifiedSnapshotOrderIds?.includes(line.printavoOrderId);
  });
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Lazy imports let offline tests inject every IO boundary without a live DB. */
async function productionDependencies(): Promise<HubPoBatchDependencies> {
  const [{ db, poFilesTable, pqPrintJobsTable }, { eq, sql }, { getPoFile }, { submitPdfPrintJob }] =
    await Promise.all([
      import("@workspace/db"),
      import("drizzle-orm"),
      import("../../purchasing/poFiles"),
      import("./printNode"),
    ]);
  return {
    async loadRelevantPos(orders) {
      const snapshotIds = [...new Set(orders.flatMap((order) =>
        [order.orderId, ...(order.verifiedSnapshotOrderIds ?? [])],
      ))];
      if (!snapshotIds.length) return [];
      // po_files has no soft-delete/active flag. Deleted rows are absent.
      // Snapshot Printavo ids survive pv_* refreshes and must not be joined
      // against mutable live purchasing/Printavo entities.
      const rows = await db.select({ id: poFilesTable.id }).from(poFilesTable).where(sql`
        exists (
          select 1 from jsonb_array_elements(${poFilesTable.lineItems}) as line
          where line->>'printavoOrderId' in (${sql.join(snapshotIds.map((id) => sql`${id}`), sql`, `)})
        )
      `);
      const snapshots: PoFileDto[] = [];
      for (const row of rows) {
        const snapshot = await getPoFile(row.id);
        if (snapshot) snapshots.push(snapshot);
      }
      // The caller rechecks relationships in these exact snapshots, so edits
      // between candidate selection and getPoFile cannot admit unrelated POs.
      return snapshots;
    },
    async reserve(job) {
      const [row] = await db.insert(pqPrintJobsTable).values(job)
        .onConflictDoNothing().returning({ id: pqPrintJobsTable.id });
      return row?.id ?? null;
    },
    async updateJob(id, update) {
      const rows = await db.update(pqPrintJobsTable).set(update)
        .where(eq(pqPrintJobsTable.id, id)).returning({ id: pqPrintJobsTable.id });
      if (rows.length !== 1) throw new Error("Hub PO audit reservation disappeared");
    },
    submit: submitPdfPrintJob,
  };
}

/**
 * Print a single copy of each saved PO related to workorders actually accepted
 * in this run. No retries: even pending/failed/unknown reservations block a
 * same-run repeat. In particular a process crash after submission cannot cause
 * an automatic duplicate. Does not change workorder counts or any PO entity.
 */
export async function runHubPoBatch(
  input: HubPoBatchInput,
  injected?: HubPoBatchDependencies,
): Promise<HubPoBatchResult> {
  const result: HubPoBatchResult = { printed: 0, failed: 0, unknown: 0, skipped: 0, warnings: [] };
  if (!input.successfullyPrintedOrders.length) return result;
  if (!input.dryRun && (!Number.isSafeInteger(Number(input.printerId)) || Number(input.printerId) <= 0)) {
    result.failed++;
    result.warnings.push("Hub PO batch refused: printer id must be a positive integer");
    return result;
  }
  let deps: HubPoBatchDependencies;
  let snapshots: PoFileDto[];
  try {
    deps = injected ?? await productionDependencies();
    snapshots = await deps.loadRelevantPos(input.successfullyPrintedOrders);
  } catch (error) {
    result.failed++;
    result.warnings.push(`Hub PO lookup failed: ${errorText(error)}`);
    return result;
  }
  const seen = new Set<string>();
  // Clone the whole query result before any asynchronous reservation/render.
  const frozen = freeze(structuredClone(snapshots));
  for (const po of frozen) {
    if (seen.has(po.id)) continue;
    seen.add(po.id);
    const matchedOrders = input.successfullyPrintedOrders.filter((order) => matches(po, order));
    if (!matchedOrders.length) continue;
    if (input.dryRun) {
      result.skipped++;
      continue;
    }
    let jobId: string | null = null;
    let submissionStarted = false;
    try {
      const snapshotMetadata: HubPoSnapshotMetadata = freeze({
        version: 1 as const,
        capturedAt: new Date().toISOString(),
        sha256: createHash("sha256").update(JSON.stringify(po)).digest("hex"),
        po,
        matchedOrders: structuredClone(matchedOrders),
      });
      jobId = await deps.reserve({
        runId: input.runId,
        hubPoId: po.id,
        hubPoNumber: po.poNumber,
        printavoOrderId: matchedOrders[0].orderId,
        visualId: matchedOrders[0].visualId == null ? null : String(matchedOrders[0].visualId),
        printerId: String(input.printerId),
        printerName: input.printerName,
        docType: "hub_po",
        copies: 1,
        status: "pending",
        snapshotMetadata,
      });
      if (!jobId) {
        result.skipped++;
        continue;
      }
      const pdf = await input.renderPdf(renderPoHtml(po));
      if (!pdf.length) throw new Error("Hub PO renderer returned an empty PDF");
      // Durable uncertainty marker MUST commit before the network attempt.
      await deps.updateJob(jobId, {
        status: "submission_unknown",
        errorMessage: "Submission reserved; acceptance not yet confirmed. Do not automatically retry.",
      });
      submissionStarted = true;
      const printnodeJobId = await deps.submit({
        printerId: Number(input.printerId),
        title: `Hub PO ${po.poNumber}`,
        pdfBase64: pdf.toString("base64"),
        copies: 1,
        source: "Printavo Hub auto-print",
      });
      if (!Number.isSafeInteger(printnodeJobId) || printnodeJobId <= 0) {
        throw new Error("PrintNode did not return a valid acceptance id");
      }
      await deps.updateJob(jobId, {
        status: "printed",
        errorMessage: null,
        printnodeJobId: String(printnodeJobId),
        printedAt: new Date(),
      });
      result.printed++;
    } catch (error) {
      const status = submissionStarted ? "submission_unknown" : "failed";
      if (submissionStarted) result.unknown++;
      else result.failed++;
      const message = `Hub PO ${po.poNumber}: ${errorText(error)}${submissionStarted ? " — acceptance unknown; automatic retry blocked" : ""}`;
      result.warnings.push(message);
      if (jobId) {
        try {
          await deps.updateJob(jobId, { status, errorMessage: message });
        } catch (auditError) {
          // The durable pending/unknown reservation still prevents resubmission.
          result.warnings.push(`Hub PO ${po.poNumber} audit update failed: ${errorText(auditError)}`);
        }
      }
    }
  }
  return result;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}