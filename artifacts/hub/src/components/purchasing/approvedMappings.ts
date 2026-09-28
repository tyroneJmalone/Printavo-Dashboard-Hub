import {
  approvePurchasingMapping,
  getPurchasingApprovedMapping,
  type GetPurchasingApprovedMappingParams,
  type PurchasingApprovedMapping,
  type PurchasingMappingApproval,
} from "@workspace/api-client-react";

export type ApprovedPurchasingMapping = PurchasingApprovedMapping;
export type PurchasingMappingSource = GetPurchasingApprovedMappingParams;

/** Stored approval is not a live offer. Validate style identity and color against a current lookup. */
export async function getApprovedPurchasingMapping(
  source: PurchasingMappingSource,
): Promise<ApprovedPurchasingMapping | null> {
  return getPurchasingApprovedMapping(source);
}

/** Invoke only following explicit staff approval, never from auto-match or hydration. */
export async function saveApprovedPurchasingMapping(
  approval: PurchasingMappingApproval,
): Promise<ApprovedPurchasingMapping> {
  // Intentionally let errors propagate so callers show a visible save failure.
  return approvePurchasingMapping(approval);
}