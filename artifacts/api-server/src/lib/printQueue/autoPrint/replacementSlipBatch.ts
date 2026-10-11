import type { AnyReplacementSlipSnapshot } from "./replacementSlip";
import { renderReplacementSlipHtml } from "./replacementSlip";
import type { submitPdfPrintJob } from "./printNode";

interface SlipJob { id: string; snapshotMetadata: unknown }
export interface ReplacementSlipDependencies {
  claim: (runId: string, printerId: string, printerName: string | null) => Promise<SlipJob[]>;
  update: (id: string, patch: { status: string; errorMessage: string | null; printnodeJobId?: string; printedAt?: Date }) => Promise<void>;
  render: (html: string) => Promise<Buffer>;
  submit: typeof submitPdfPrintJob;
}

/** Durable claim and uncertainty marker precede any irreversible printer request. */
export async function runReplacementSlipBatch(
  input: { runId: string; printerId: string | null; printerName: string | null; dryRun: boolean; production: boolean },
  deps: ReplacementSlipDependencies,
) {
  const result = { printed: 0, failed: 0, warnings: [] as string[] };
  if (!input.production || input.dryRun || !input.printerId) return result;
  if (!Number.isSafeInteger(Number(input.printerId)) || Number(input.printerId) <= 0) {
    throw new Error("Replacement slip printer id must be a positive integer");
  }
  const jobs = await deps.claim(input.runId, input.printerId, input.printerName);
  for (const job of jobs) {
    let submitting = false;
    try {
      const snapshot = job.snapshotMetadata as AnyReplacementSlipSnapshot;
      if (![1, 2].includes(snapshot?.version) || !snapshot.orderId || !snapshot.po?.lineItems?.length ||
          snapshot.po.lineItems.some(line => line.visualId !== 22787 || line.printavoOrderId !== snapshot.orderId || !line.printavoLineItemId)) {
        throw new Error("Invalid replacement slip snapshot");
      }
      const pdf = await deps.render(renderReplacementSlipHtml(snapshot));
      if (!pdf.length) throw new Error("Replacement slip PDF is empty");
      await deps.update(job.id, { status: "submission_unknown", errorMessage: "Printer acceptance not yet confirmed. Do not automatically resend." });
      submitting = true;
      const id = await deps.submit({ printerId: Number(input.printerId), copies: 1,
        title: `Replacement #22787 — PO ${snapshot.po.poNumber}`, pdfBase64: pdf.toString("base64"), source: "Printavo Hub auto-print" });
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid printer acceptance id");
      await deps.update(job.id, { status: "printed", errorMessage: null, printnodeJobId: String(id), printedAt: new Date() });
      result.printed++;
    } catch (err) {
      result.failed++;
      const message = `Replacement slip ${job.id}: ${err instanceof Error ? err.message : String(err)}`;
      result.warnings.push(message);
      try { await deps.update(job.id, { status: submitting ? "submission_unknown" : "failed", errorMessage: message }); }
      catch { result.warnings.push(`Replacement slip ${job.id}: audit update failed; reservation remains blocked`); }
    }
  }
  return result;
}
