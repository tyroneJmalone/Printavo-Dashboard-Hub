import assert from "node:assert/strict";
import test from "node:test";
import { artworkEvidence, artworkMatches, artworkMetrics, buildArtworkReport } from "../src/lib/reports/artwork";
import { parseReportFilters } from "../src/lib/reports/filters";
import type { ReportOrder } from "../src/lib/reports/dataset";

const source = (id: string, breezy = false, mockup = false) => ({
  printavo_id: id, extras_synced_at: "2026-10-22", extras_stale: false,
  extras: { productionFiles: breezy ? [{ id: "f1", name: "Proof.BREEZY " }, { id: "f2", name: "Revision.breezy" }] : [],
    lineItems: [{ id: "li1", mockups: mockup ? [{ id: "m1" }, { id: "m2" }] : [] }], truncated: false },
});
const order = (id: string, invoiceAt: string | null = "2026-10-01") => ({
  id, visualId: Number(id), orderType: "invoice", invoiceAt, statusName: "Complete", customerName: "Example",
} as ReportOrder);

test("counts an invoice once despite multiple files and mockups; extension is exact and case-insensitive", () => {
  const a = source("1", true, true);
  const e = artworkEvidence(a);
  assert.equal(e.category, "both"); assert.equal(e.filenames.length, 2);
  a.extras.productionFiles = [{ id: "f", name: "Breezy picture.png" }, { id: "g", name: "proof.breezy.zip" }];
  assert.equal(artworkEvidence(a).breezy, false);
  const report = buildArtworkReport([order("1"), order("1")], [source("1", true, true)], "total", undefined, 0, 50);
  assert.equal(report.summary.total, 1); assert.equal(report.summary.mockup, 1); assert.equal(report.summary.breezy, 1);
});

test("exclusive categories partition complete evidence; incomplete evidence stays unknown", () => {
  const orders = ["1","2","3","4","5"].map(id => order(id));
  const sources = [source("1",true,true),source("2",true,false),source("3",false,true),source("4")];
  const result = buildArtworkReport(orders,sources,"total",undefined,0,50);
  assert.deepEqual(result.summary, { total:5,breezy:2,mockup:2,both:1,mockupOnly:1,breezyOnly:1,neither:1,unknown:1 });
  assert.equal(result.breezyPercent,40); assert.equal(result.breezyOfMockupsPercent,50);
});

test("stale, partial, truncated, unsynced and malformed snapshots cannot prove absence", () => {
  const base = source("1");
  for (const s of [
    undefined, { ...base, extras_stale: true }, { ...base, extras_synced_at: null },
    { ...base, extras: { ...base.extras, truncated: true } },
    { ...base, extras: { ...base.extras, partialErrors: ["API error"] } },
    { ...base, extras: { productionFiles: [], lineItems: null } },
    { ...base, extras: { productionFiles: [], lineItems: [{ id: "a", mockups: [null] }] } },
  ]) {
    const evidence = artworkEvidence(s);
    assert.equal(evidence.category,"unknown"); assert.ok(evidence.warning);
  }
});

test("observed positives survive incomplete snapshots without being classified as confirmed both", () => {
  const s = { ...source("1",true,true), extras_stale: true };
  const report = buildArtworkReport([order("1")],[s],"unknown",undefined,0,50);
  assert.equal(report.summary.unknown,1); assert.equal(report.summary.both,0);
  assert.equal(report.summary.breezy,1); assert.equal(report.summary.mockup,1);
  assert.equal(report.breezyOfMockupsPercent,null);
});

test("imprint mockups do not count as line-item mockups", () => {
  const s = source("1");
  const e = artworkEvidence({ ...s, extras: { ...s.extras, imprints: [{ mockups: [{ id: "a" }] }] } });
  assert.equal(e.mockup,false);
});

test("all metric and monthly drilldowns exactly match reported counts and paginate deterministically", () => {
  const orders = Array.from({length:103}, (_,i) => order(String(i+1), i < 50 ? "2026-09-30" : "2026-10-01"));
  const sources = orders.map((o,i) => source(o.id,i%2===0,i%3===0));
  const full = buildArtworkReport(orders,sources,"total",undefined,0,100);
  for (const metric of artworkMetrics) {
    const r = buildArtworkReport(orders,sources,metric,undefined,0,100);
    assert.equal(r.total,full.summary[metric]);
    assert.ok(r.invoices.every(row => artworkMatches(row,metric)));
    for (const month of full.monthly) {
      const m = buildArtworkReport(orders,sources,metric,month.month,0,100);
      assert.equal(m.total,month[metric]); assert.ok(m.invoices.every(row => row.invoiceDate?.startsWith(month.month)));
    }
  }
  const page1 = buildArtworkReport(orders,sources,"total",undefined,0,50);
  const page2 = buildArtworkReport(orders,sources,"total",undefined,50,50);
  const page3 = buildArtworkReport(orders,sources,"total",undefined,100,50);
  assert.equal(new Set([...page1.invoices,...page2.invoices,...page3.invoices].map(r=>r.id)).size,103);
});

test("quotes excluded, undated records drill down, empty denominators remain null", () => {
  const r = buildArtworkReport([{...order("1"),orderType:"quote"},order("2",null)],[source("2")],"total","undated",0,50);
  assert.equal(r.summary.total,1); assert.equal(r.total,1); assert.equal(r.monthly[0].month,"undated");
  const empty = buildArtworkReport([],[],"total",undefined,0,50);
  assert.equal(empty.breezyPercent,null); assert.equal(empty.breezyOfMockupsPercent,null);
});

test("shared status exclusion and inclusive invoice date filters parse without altering status names", () => {
  const {filters,errors} = parseReportFilters({statuses:"BLANKS - COMPLETE||Samples",exclude:"statuses",invoiceStart:"2026-09-01",invoiceEnd:"2026-09-30"});
  assert.deepEqual(errors,[]); assert.equal(filters.exclude.has("statuses"),true);
  assert.deepEqual(filters.statuses,["blanks - complete","samples"]);
  assert.equal(filters.invoiceStart,"2026-09-01"); assert.equal(filters.invoiceEnd,"2026-09-30");
});
