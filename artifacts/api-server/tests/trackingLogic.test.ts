import assert from "node:assert/strict";
import test from "node:test";
import { carrierCode, normalizeCarrierTracking, shouldCheckCarrier, mayRequestCarrier, mergeVendorTracking, deliverySummary, withCarrierDeadline, isStaleCarrierUpdate } from "../src/lib/purchasing/trackingLogic";
import type { VendorTrackingEntry } from "../src/lib/purchasing/vendorSubmit";

const packageA: VendorTrackingEntry = { orderNumber: "A", carrier: "UPS", trackingNumber: "1Z123", shipMethod: null, shipmentDate: "2026-07-01" };
const packageB: VendorTrackingEntry = { ...packageA, trackingNumber: "1Z456", orderNumber: "B" };
const checkedAt = "2026-07-03T12:00:00Z";

test("authoritative Shippo origin, ETA and delivered event, never vendor ship date", () => {
  const transit = normalizeCarrierTracking(packageA, {
    address_from: { city: "Reno", state: "NV", country: "US" },
    eta: "2026-07-06T17:00:00Z",
    tracking_status: { status: "TRANSIT", status_date: "2026-07-03T10:00:00Z", status_details: "On route", location: { city: "Denver", state: "CO" } },
  }, checkedAt);
  assert.equal(transit.origin, "Reno, NV, US");
  assert.equal(transit.carrierLocation, "Denver, CO");
  assert.equal(transit.eta, "2026-07-06T17:00:00Z");
  assert.equal(transit.deliveredAt, null);
  assert.equal(transit.shipmentDate, packageA.shipmentDate);
  const delivered = normalizeCarrierTracking(transit, { tracking_status: { status: "DELIVERED", status_date: "2026-07-05T13:00:00Z" } }, checkedAt);
  assert.equal(delivered.deliveredAt, "2026-07-05T13:00:00Z");
  assert.equal(delivered.origin, transit.origin);
});

test("split packages retain previous carrier data and correctly count partial delivery", () => {
  const delivered = { ...packageA, carrierStatus: "DELIVERED", deliveredAt: checkedAt };
  const merged = mergeVendorTracking([delivered, packageB], [{ ...packageB, shipMethod: "Ground" }]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].deliveredAt, checkedAt);
  assert.equal(merged[1].shipMethod, "Ground");
  assert.equal(deliverySummary(merged), "1/2 known shipments delivered");
});

test("older in-flight carrier responses cannot replace newer check or event", () => {
  const later = "2026-07-04T12:00:00Z";
  const current = { ...packageA, carrierCheckedAt: later, carrierStatusDate: later, carrierStatus: "DELIVERED" };
  assert.equal(isStaleCarrierUpdate(current, { ...packageA, carrierCheckedAt: checkedAt, carrierStatusDate: checkedAt }), true);
  assert.equal(isStaleCarrierUpdate(current, { ...packageA, carrierCheckedAt: later, carrierStatusDate: checkedAt }), true);
  assert.equal(isStaleCarrierUpdate(current, { ...packageA, carrierCheckedAt: later, carrierStatusDate: later }), false);
  assert.equal(isStaleCarrierUpdate(current, { ...packageA, carrierCheckedAt: later, carrierError: "HTTP 429" }), false);
});

test("Shippo SDK deadline aborts a stuck request and releases the awaiting caller", async () => {
  let aborted = false;
  await assert.rejects(withCarrierDeadline(
    async (signal) => new Promise<never>(() => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    }),
    15,
  ), /timed out after 15ms/);
  assert.equal(aborted, true);
  assert.equal(await withCarrierDeadline(async () => "cached response", 100), "cached response");
});

test("carrier gating and cache/backoff prevent repeated requests", () => {
  const now = Date.parse(checkedAt);
  assert.equal(carrierCode(null, "unrecognized"), null);
  assert.equal(carrierCode("UPS Ground", "123"), "ups");
  assert.equal(mayRequestCarrier(false, packageA, now), false);
  assert.equal(mayRequestCarrier(true, packageA, now), true);
  assert.equal(mayRequestCarrier(true, { ...packageA, carrier: null, trackingNumber: "123" }, now), false);
  assert.equal(shouldCheckCarrier(packageA, now), true);
  assert.equal(shouldCheckCarrier({ ...packageA, carrierCheckedAt: checkedAt }, now + 1000), false);
  assert.equal(shouldCheckCarrier({ ...packageA, carrierCheckedAt: checkedAt }, now + 7 * 3600_000), true);
  assert.equal(shouldCheckCarrier({ ...packageA, carrierCheckedAt: checkedAt, carrierError: "HTTP 429" }, now + 7 * 3600_000), false);
  assert.equal(shouldCheckCarrier({ ...packageA, carrierCheckedAt: checkedAt, carrierError: "HTTP 429" }, now + 25 * 3600_000), true);
  assert.equal(shouldCheckCarrier({ ...packageA, carrierStatus: "DELIVERED" }, now + 25 * 3600_000), false);
});