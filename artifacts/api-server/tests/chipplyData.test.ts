import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { cents, parseDataCsv, parseDataRows } from "../src/lib/chipply/dataImport";
import { parseCsvRows } from "../src/lib/chipply/parseCsv";
import { reconcileData, type MirrorInvoice } from "../src/lib/chipply/dataReconciliation";
import { parseDataUpload } from "../src/lib/chipply/dataUpload";
import { confirmChipplyData } from "../src/lib/chipply/dataService";
const csv = readFileSync("../../attached_assets/0_Fuel_Summer_26_Data_Export_1790655144068.csv", "utf8");
const parsed = parseDataCsv(csv);
test("Fuel source totals and deduplicated order components are exact", () => {
  assert.equal(parsed.salesOrder, "553498");
  assert.equal(parsed.summary.lineCount, 54);
  assert.equal(parsed.summary.orderCount, 19);
  assert.equal(parsed.summary.quantity, 57);
  assert.equal(parsed.summary.itemTotalCents, 220000);
  assert.equal(parsed.summary.orderTotalCents, 238046);
  assert.equal(parsed.summary.orderComponentsCents["Order Total"], 238046);
  assert.equal(parsed.summary.unitComponentsExtendedCents["Combined"], parsed.summary.unitComponentsExtendedCents["Product Price"] + parsed.summary.unitComponentsExtendedCents["Process Price"]);
  const stored = JSON.stringify(parsed);
  assert(!stored.includes("@"));
  assert(!stored.includes("Mast Rd"));
  assert(!stored.includes("Jennifer"));
});
test("decimal parsing never rounds fractional cents or floats", () => {
  assert.equal(cents("($1,234.5600)"), -123456);
  assert.equal(cents("$0.29"), 29);
  assert.throws(() => cents("0.001"), /Sub-cent/);
  assert.throws(() => cents("NaN"));
  assert.throws(() => cents(""));
});
test("repeating order money mismatch rejects entire file", () => {
  const rows = parseCsvRows(csv);
  rows[2][rows[0].indexOf("Tax Total")] = "$1.00";
  assert.throws(() => parseDataRows(rows, "test"), /repeated order money differs/);
});
test("identical legitimate source lines preserved with distinct ordinals", () => {
  const rows = parseCsvRows(csv);
  const dup = parseDataRows([rows[0], rows[1], rows[1]], "test");
  assert.equal(dup.lines.length, 2);
  assert.equal(dup.summary.orderCount, 1);
  assert.equal(dup.summary.itemTotalCents, 5000);
  assert.deepEqual(dup.lines.map(l => l.rowOrdinal), [1, 2]);
});
const line = parsed.lines[0];
const one = [{ ...line, quantity: 1 }];
const mirror: MirrorInvoice = { invoiceId: "123", nickname: "553498 Fuel Summer HEAT: FRONT: STRONG", statusName: "HEAT", detailSyncState: "complete", detailSyncedAt: "2026-07-02T00:00:00Z", syncedAt: "2026-07-01T00:00:00Z", items: [{ style: line.style, color: line.color, quantity: 1, sizes: [{ size: line.size, count: 1 }] }] };
test("actual current status outranks planned PRINT and nickname", () => {
  const r = reconcileData(one, "553498", [{ ...mirror, nickname: mirror.nickname.replace("HEAT:", "PRINT:") }])[0];
  assert.equal(r.plannedMethod, "screenprint");
  assert.equal(r.reconciliation.actualMethod, "heat-transfer");
  assert.equal(r.reconciliation.outcome, "matched");
  assert.equal(r.itemTotalCents, line.itemTotalCents);
});
test("invoice display uses visual numbers while matching and overrides retain internal IDs", () => {
  const invoice = { ...mirror, invoiceId: "internal-record-987", visualId: 22251 };
  const matched = reconcileData(one, "553498", [invoice])[0].reconciliation;
  assert.equal(matched.invoiceId, "internal-record-987");
  assert.equal(matched.invoiceVisualId, 22251);
  assert.deepEqual(matched.candidateInvoices, [{ invoiceId: "internal-record-987", visualId: 22251 }]);
  const incomplete = reconcileData(one, "553498", [{ ...invoice, detailSyncState: "pending" }])[0].reconciliation;
  assert.equal(incomplete.outcome, "incomplete");
  assert.equal(incomplete.invoiceId, null);
  assert.equal(incomplete.invoiceVisualId, null);
  assert.equal(incomplete.candidateInvoices[0].visualId, 22251);
  const absent = reconcileData(one, "553498", [mirror])[0].reconciliation;
  assert.equal(absent.invoiceVisualId, null, "Never display the internal ID as an invoice number");
});
test("one-size Other evidence clears group flags without weakening apparel or quantity checks", () => {
  const cap = { ...line, style: "X210P", color: "Lavender", size: "Adjustable", quantity: 1 };
  const item = { style: cap.style, color: cap.color, quantity: 1, sizes: [{ size: "size_other", count: 1 }] };
  const reconcile = (lines: typeof one, items: MirrorInvoice["items"]) => reconcileData(lines, "553498", [{ ...mirror, items }]);
  assert.equal(reconcile([cap], [item])[0].reconciliation.outcome, "matched");
  assert.match(reconcile([cap], [item])[0].reconciliation.reason, /one-size labels reconciled/);
  const bag = { ...cap, style: "411095", color: "Gear Grey/ Black", size: "OSFA" };
  const apparel = { ...cap, rowOrdinal: 2, style: "EXP15WPQ", color: "Black", size: "M" };
  const bagItem = { ...item, style: bag.style, color: bag.color };
  const apparelItem = { style: apparel.style, color: apparel.color, quantity: 1, sizes: [{ size: "size_m", count: 1 }] };
  assert.ok(reconcile([bag, apparel], [bagItem, apparelItem]).every(l => l.reconciliation.outcome === "matched"));
  assert.equal(reconcile([{ ...cap, size: "M" }], [item])[0].reconciliation.outcome, "quantity-mismatch");
  assert.equal(reconcile([cap], [{ ...item, quantity: 2, sizes: [{ size: "size_other", count: 2 }] }])[0].reconciliation.outcome, "quantity-mismatch");
  assert.equal(reconcile([cap], [{ ...item, color: "White" }])[0].reconciliation.outcome, "quantity-mismatch");
  assert.equal(reconcile([cap, { ...cap, rowOrdinal: 2, size: "M" }], [{ ...item, quantity: 2, sizes: [{ size: "size_other", count: 2 }] }])[0].reconciliation.outcome, "quantity-mismatch");
  assert.equal(reconcile([cap, { ...cap, rowOrdinal: 2, size: "OSFA" }], [{ ...item, quantity: 2, sizes: [{ size: "size_other", count: 2 }] }])[0].reconciliation.outcome, "quantity-mismatch");
  assert.equal(reconcile([cap], [{ ...item, sizes: [{ size: "size_m", count: 1 }] }])[0].reconciliation.outcome, "quantity-mismatch");
});
test("Printavo size enum prefixes normalize without inventing generic other sizes", () => {
  const items = [{ ...mirror.items[0], sizes: [{ size: `size_${line.size.toLowerCase()}`, count: 1 }, { size: "size_xs", count: null as unknown as number }] }];
  assert.equal(reconcileData(one, "553498", [{ ...mirror, items }])[0].reconciliation.outcome, "matched");
  assert.equal(reconcileData(one, "553498", [{ ...mirror, items: [{ ...mirror.items[0], sizes: [{ size: "size_other", count: 1 }] }] }])[0].reconciliation.outcome, "quantity-mismatch");
});
test("invoice method extraction cannot consume arbitrary earlier or ambiguous method headers", () => {
  for (const nickname of [
    "553498 Fuel Summer NOTE: HEAT: FRONT: STRONG",
    "553498 Fuel Summer PRINT HEAT: FRONT: STRONG",
    "553498 Fuel Summer PRINT: HEAT: FRONT: STRONG",
    "553498 HEAT: FRONT: STRONG",
    "553498 Fuel Summer unknown HEAT: FRONT: OTHER",
  ]) assert.equal(reconcileData(one, "553498", [{ ...mirror, nickname }])[0].reconciliation.outcome, "unmatched", nickname);
  assert.equal(reconcileData([{ ...one[0], processName: "NOTE: FRONT: STRONG" }], "553498", [mirror])[0].reconciliation.outcome, "unmatched");
  assert.equal(reconcileData(one, "553498", [mirror])[0].reconciliation.outcome, "matched");
});
test("mixed production status is not silently split or nickname-attributed", () => {
  const r = reconcileData(one, "553498", [{ ...mirror, statusName: "MERCH PRINT + HEAT" }])[0];
  assert.equal(r.reconciliation.actualMethod, null);
  assert.equal(r.reconciliation.outcome, "unverified");
  assert.equal(parsed.lines[0].orderDate, "2026-06-22");
});
test("explicit MERCH MIXED stages retain one mixed-decoration financial bucket", () => {
  for (const statusName of ["MERCH MIXED", "MERCH - MIXED DECO", "MERCH - MIXED DECO - COMPLETE"]) {
    const r = reconcileData(one, "553498", [{ ...mirror, statusName }])[0];
    assert.equal(r.reconciliation.actualMethod, "mixed-decoration");
    assert.equal(r.reconciliation.outcome, "matched");
    assert.equal(r.itemTotalCents, line.itemTotalCents);
    assert.equal(r.quantity, 1);
    assert.match(r.reconciliation.reason, /Current mirrored status/);
  }
});
test("ambiguous candidates, mismatch and incomplete detail stay unallocated", () => {
  assert.equal(reconcileData(one, "553498", [mirror, { ...mirror, invoiceId: "456" }])[0].reconciliation.outcome, "ambiguous");
  assert.equal(reconcileData(one, "553498", [{ ...mirror, items: [] }])[0].reconciliation.outcome, "quantity-mismatch");
  assert.equal(reconcileData(one, "553498", [{ ...mirror, detailSyncState: "incomplete" }])[0].reconciliation.outcome, "incomplete");
  assert.equal(reconcileData(one, "553499", [mirror])[0].reconciliation.outcome, "unmatched");
  assert.equal(reconcileData(one, "553498", [])[0].reconciliation.actualMethod, null);
});
test("manual review selects candidate but cannot bypass quantity coverage", () => {
  const override = [{ rowOrdinal: line.rowOrdinal, invoiceId: "123", actor: "staff", reason: "Confirmed matching process", createdAt: "2026-07-02" }];
  assert.equal(reconcileData(one, "553498", [mirror, { ...mirror, invoiceId: "456" }], override)[0].reconciliation.outcome, "reviewed");
  assert.equal(reconcileData(one, "553498", [{ ...mirror, items: [] }], override)[0].reconciliation.actualMethod, null);
});
test("XLSX import has CSV parity and rejects formula cells", async () => {
  const rows = parseCsvRows(csv);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Data");
  for (const row of rows) sheet.addRow(row);
  const result = await parseDataUpload(Buffer.from(await workbook.xlsx.writeBuffer()), "Fuel.xlsx");
  assert.deepEqual(result.summary, parsed.summary);
  sheet.getCell("BF2").value = { formula: "1+1", result: 2 };
  await assert.rejects(parseDataUpload(Buffer.from(await workbook.xlsx.writeBuffer()), "Fuel.xlsx"), /formulas/);
});
test("confirmation is idempotent, replacement explicit, stale previews rejected, transaction rolled back on errors", async () => {
  let current: string | null = null;
  let expected: string | null = null;
  let sameId: string | null = null;
  let commits = 0, rollbacks = 0, events = 0, created = 0;
  const query = async (sql: string, params: unknown[] = []) => {
    const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
    if (sql === "BEGIN") return result();
    if (sql === "COMMIT") { commits++; return result(); }
    if (sql === "ROLLBACK") { rollbacks++; return result(); }
    if (sql.includes("FROM chipply_data_previews")) return result([{ payload: parsed, expected_snapshot_id: expected, expires_at: "2099-01-01", source_name: "Fuel.csv" }]);
    if (sql.includes("pg_advisory")) return result();
    if (sql.includes("INSERT INTO chipply_stores")) return result([{ id: "store" }]);
    if (sql.includes("SELECT snapshot_id")) return result(current ? [{ snapshot_id: current }] : []);
    if (sql.includes("SELECT id FROM chipply_data_snapshots")) return result(sameId ? [{ id: sameId }] : []);
    if (sql.includes("INSERT INTO chipply_data_snapshots")) { created++; return result([{ id: "new" }]); }
    if (sql.includes("INSERT INTO chipply_data_current")) { current = params[1] as string; return result(); }
    if (sql.includes("INSERT INTO chipply_data_events")) { events++; return result(); }
    if (sql.includes("UPDATE chipply_data_previews")) return result();
    throw new Error(`Unexpected test query: ${sql}`);
  };
  (globalThis as unknown as { chipplyTestQuery: typeof query }).chipplyTestQuery = query;
  assert.deepEqual(await confirmChipplyData("preview", "staff", false), { storeId: "store", snapshotId: "new", idempotent: false });
  assert.equal(created, 1);
  assert.equal(events, 1);
  sameId = "new";
  assert.equal((await confirmChipplyData("preview", "staff", false)).idempotent, true);
  assert.equal(events, 1);
  sameId = null;
  await assert.rejects(confirmChipplyData("preview", "staff", true), /changed after preview/);
  expected = current;
  await assert.rejects(confirmChipplyData("preview", "staff", false), /Explicit replaceCurrent/);
  assert.equal(rollbacks, 2);
  await confirmChipplyData("preview", "staff", true);
  assert.equal(events, 2);
  assert.equal(commits, 3);
});