import {
  liveOrderStatusMatches,
  type LiveOrderStatus,
} from "./liveDiscovery";

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