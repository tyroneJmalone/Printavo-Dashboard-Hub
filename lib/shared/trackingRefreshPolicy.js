/** Refresh eligibility, not proof that every ordered unit was delivered. */
export function trackingRefreshFinished(order) {
  const statuses = (order.vendorStatus ?? "").split(",").map(s => s.trim().toLowerCase());
  if (statuses.length > 0 && statuses.every(s => s === "complete" || s === "completed")) return true;
  return Array.isArray(order.tracking) && order.tracking.length > 0 &&
    order.tracking.every(entry => entry && entry.carrierStatus === "DELIVERED");
}
