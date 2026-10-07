import { test } from "node:test";
import assert from "node:assert/strict";
import { decorationProduction, colorCount, stitchMidpoint, imprintMethod } from "../src/lib/reports/decorationProduction";
import type { ReportOrder, ReportGroup } from "../src/lib/reports/dataset";

const group = (id: string, qty: number, tiers: string[], method = "Screen Printing", price = 38): ReportGroup => ({
  id, lineItems: [{ itemNumber: "shirt", color: "Red", brand: null, categoryName: method, items: qty, price, priceKnown: true }],
  imprints: tiers.map((columnName, n) => ({ id: `${id}-${n}`, details: n ? "Back" : "Front", matrixName: method, typeOfWork: method, columnName })),
});
const order = (id: string, groups: ReportGroup[], changes: Partial<ReportOrder> = {}): ReportOrder => ({
  id, visualId: Number(id), orderType: "invoice", customerName: "Customer", nickname: "Job",
  detailSyncState: "complete", groups, qty: 0, total: 0, ownerEmail: null, statusName: "Complete",
  createdAt: null, invoiceAt: null, productionDueAt: null, dueAt: null, activityCount: 0,
  latestActivityAt: null, activityBreakdown: {} as ReportOrder["activityBreakdown"], ...changes,
});

test("100 shirts, 3-color front and 1-color back: 200 imprints, 400 impressions, 4 screens", () => {
  const r = decorationProduction([order("1", [group("a", 100, ["3 color", "1 color"])])], "print");
  assert.equal(r.summary.quantity, 100);
  assert.equal(r.summary.imprints, 200);
  assert.equal(r.summary.workUnits, 400);
  assert.equal(r.summary.estimatedScreens, 4);
  assert.equal(r.summary.averageItemPrice, 38);
  assert.equal(r.jobs[0].groups[0].locations[0].complexity, 3);
  assert.equal(r.jobs[0].groups[0].locations[1].workUnits, 100);
  assert.deepEqual(r.complexityBreakdown.map(b => [b.complexity, b.totals.quantity, b.totals.workUnits]), [[1, 100, 100], [3, 100, 300]]);
});

test("embroidery preserves each tier midpoint, never averages locations", () => {
  const r = decorationProduction([order("1", [group("a", 45, ["6k-8k", "2K–4K"], "Embroidery")])], "embroidery");
  assert.deepEqual(r.jobs[0].groups[0].locations.map(l => l.complexity), [7000, 3000]);
  assert.equal(r.summary.imprints, 90);
  assert.equal(r.summary.workUnits, 450000);
  assert.equal(r.summary.estimatedScreens, null);
  assert.deepEqual(r.complexityBreakdown.map(b => b.complexity), [3000, 7000]);
});

test("mixed groups use their own quantities; invoices are distinct across buckets", () => {
  const orders = [order("1", [group("a", 45, ["1 color", "1 color"]), group("b", 20, ["1 color"], "Screen Printing", 50)])];
  const r = decorationProduction(orders, "print");
  assert.equal(r.summary.invoices, 1);
  assert.equal(r.summary.quantity, 65);
  assert.equal(r.summary.imprints, 110);
  assert.equal(r.summary.averageLocationsPerItem, 110 / 65);
  assert.equal(r.summary.averageItemPrice, (45 * 38 + 20 * 50) / 65);
  assert.deepEqual(r.buckets.map(b => b.totals.invoices), [1, 1]);
  const filtered = decorationProduction(orders, "print", { locationCount: 1 });
  assert.equal(filtered.jobs[0].totals.quantity, 20);
  assert.equal(filtered.summary.quantity, 65);
});

test("method-specific locations do not count Heat or mix Print and Embroidery", () => {
  const g = group("a", 10, ["2 color"]);
  g.imprints.push(...group("b", 10, ["6K-8K"], "Embroidery").imprints);
  g.imprints.push(...group("c", 10, ["3 color"], "Heat Press").imprints);
  const o = order("1", [g]);
  assert.equal(decorationProduction([o], "print").summary.imprints, 10);
  assert.equal(decorationProduction([o], "embroidery").summary.workUnits, 70000);
  assert.equal(imprintMethod({ typeOfWork: "Heat Press", matrixName: "Heat Applied Graphics", columnName: "1 color" }), "heat");
  assert.equal(imprintMethod({ typeOfWork: null, matrixName: "1st PRINT LOC - 2025", columnName: "1 color" }), "print");
  assert.equal(imprintMethod({ typeOfWork: "Embroidery", matrixName: "Screen Printing", columnName: "1 color" }), null);
});

test("tier parsers reject ambiguous/unbounded values and handle K ranges", () => {
  for (const t of ["6K-8K", "6–8k", "6,000 - 8,000", "6K-8000", "6000-8K"]) assert.equal(stitchMidpoint(t), 7000);
  assert.equal(stitchMidpoint("0-5k"), 2500);
  for (const t of [null, "8k+", "up to 8k", "Embroidery - 1 Line", "8k-6k", "7000"]) assert.equal(stitchMidpoint(t), null);
  assert.equal(colorCount(" 3 COLORS "), 3);
  for (const t of [null, "1-3 colors", "2 color + base", "0 colors", "3"]) assert.equal(colorCount(t), null);
});

test("unknown pricing keeps quantities but never claims a complete work total", () => {
  const g = group("a", 10, ["2 color", "unknown"]);
  g.lineItems[0].priceKnown = false;
  const r = decorationProduction([order("1", [g])], "print");
  assert.equal(r.summary.workUnits, null);
  assert.equal(r.summary.knownWorkUnits, 20);
  assert.equal(r.summary.unknownLocations, 1);
  assert.equal(r.summary.imprints, 20);
  assert.equal(r.summary.averageItemPrice, null);
});

test("incomplete invoices, quotes, unknown-method groups and invalid quantities stay out", () => {
  const unclassified = group("unknown", 10, ["1 color"]);
  unclassified.imprints[0].typeOfWork = null;
  unclassified.imprints[0].matrixName = null;
  const orders = [
    order("1", [group("a", 10, ["1 color"])], { detailSyncState: "incomplete" }),
    order("2", [group("b", 10, ["1 color"])], { orderType: "quote" }),
    order("3", [unclassified, group("neg", -2, ["1 color"]), group("blank", 10, []), group("zero", 0, ["1 color"])]),
  ];
  const r = decorationProduction(orders, "print");
  assert.equal(r.summary.invoices, 0);
  assert.equal(r.excludedIncompleteInvoices, 1);
  assert.equal(r.unclassifiedGroups, 1);
  assert.equal(r.unassignedGroups, 1);
  assert.equal(r.excludedQuantityGroups, 2);
});

test("setup rows excluded and pagination never changes report-wide totals", () => {
  const g = group("a", 45, ["1 color"]);
  g.lineItems.push({ itemNumber: "Setup", color: null, brand: null, categoryName: "Embroidery - Set Up/Digitizing", items: 1, price: 100 });
  const r = decorationProduction([order("1", [g]), order("2", [group("b", 20, ["1 color"])])], "print", { offset: 1, limit: 1 });
  assert.equal(r.summary.quantity, 65);
  assert.equal(r.totalJobs, 2);
  assert.equal(r.jobs.length, 1);
  assert.equal(r.jobs[0].id, "2");
});

test("read-only development sample loads groups, prices, tier evidence and validates API contract", {
  skip: process.env.DPROD_READONLY_SMOKE !== "1",
}, async () => {
  const { pool } = await import("@workspace/db");
  try {
    const { loadReportOrders } = await import("../src/lib/reports/dataset");
    const { parseReportFilters } = await import("../src/lib/reports/filters");
    const { GetDecorationProductionResponse } = await import("@workspace/api-zod");
    const { filters, errors } = parseReportFilters({ orderType: "invoice", createdStart: "2026-01-01", createdEnd: "2026-12-31" });
    assert.equal(errors.length, 0);
    const orders = await loadReportOrders(filters);
    for (const method of ["print", "embroidery"] as const) {
      const report = decorationProduction(orders, method);
      GetDecorationProductionResponse.parse(report);
      assert.ok(report.summary.invoices <= orders.length);
      assert.equal(report.summary.imprints, report.buckets.reduce((n, b) => n + b.totals.imprints, 0));
      assert.equal(report.summary.quantity, report.buckets.reduce((n, b) => n + b.totals.quantity, 0));
      assert.equal(report.summary.knownWorkUnits, report.buckets.reduce((n, b) => n + b.totals.knownWorkUnits, 0));
      for (const job of report.jobs) {
        assert.equal(job.totals.quantity, job.groups.reduce((n, g) => n + g.quantity, 0));
        assert.equal(job.totals.imprints, job.groups.reduce((n, g) => n + g.quantity * g.locations.length, 0));
      }
      console.log(JSON.stringify({ method, loadedInvoices: orders.length, includedInvoices: report.summary.invoices,
        quantity: report.summary.quantity, imprints: report.summary.imprints,
        unknownLocations: report.summary.unknownLocations, unclassifiedGroups: report.unclassifiedGroups,
        excludedIncompleteInvoices: report.excludedIncompleteInvoices }));
    }
  } finally { await pool.end(); }
});
