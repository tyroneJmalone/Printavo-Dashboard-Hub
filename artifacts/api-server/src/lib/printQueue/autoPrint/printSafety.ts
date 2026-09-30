import {
  liveOrderStatusMatches,
  type LiveOrderStatus,
} from "./liveDiscovery";
import { isInternalReplacementInvoice } from "../../purchasing/internalInvoicePolicy";

export const INTERNAL_REPLACEMENT_WORKORDER_SKIP_REASON =
  "internal_replacements_invoice_no_workorder";

/** Partition before applying the per-run cap so the internal invoice cannot take a slot. */
export function selectAutoPrintWorkorders<T>(
  prioritized: readonly T[],
  limit: number,
  visualIdOf: (order: T) => number | string | null | undefined,
): { selected: T[]; excluded: T[]; deferred: T[] } {
  const eligible: T[] = [];
  const excluded: T[] = [];
  for (const order of prioritized) {
    (isInternalReplacementInvoice(visualIdOf(order)) ? excluded : eligible).push(order);
  }
  return { selected: eligible.slice(0, limit), excluded, deferred: eligible.slice(limit) };
}

export interface PrintSafetyCheck {
  dryRun: boolean;
  observedStatus: LiveOrderStatus | null;
  expected: {
    orderId: string;
    visualId: number;
    sourceStatusId: string;
  };
}

export interface PrintSafetyResult {
  allowed: boolean;
  reason: string | null;
}

/**
 * Single side-effect gate for PrintNode. Dry runs never pass this gate, and a
 * real run requires the exact live id + visual id + source status immediately
 * before submission.
 */
export function checkPrintSafety(
  input: PrintSafetyCheck,
): PrintSafetyResult {
  if (isInternalReplacementInvoice(input.expected.visualId) ||
      isInternalReplacementInvoice(input.observedStatus?.visualId)) {
    return {
      allowed: false,
      reason: "Internal replacements invoice #22787 needs no AutoPrint workorder",
    };
  }
  if (input.dryRun) {
    return { allowed: false, reason: "Dry run — PrintNode submission disabled" };
  }
  if (
    !liveOrderStatusMatches(input.observedStatus, input.expected)
  ) {
    return {
      allowed: false,
      reason:
        "Live order identity/status changed or could not be verified; PrintNode submission refused",
    };
  }
  return { allowed: true, reason: null };
}