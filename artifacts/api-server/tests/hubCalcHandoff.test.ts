/**
 * Multi-style calculator handoff — pure pricing, payloads, and one-attempt
 * claim semantics with an in-memory store and a mocked Printavo transport.
 * No real Printavo, DB, or network access.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrintavoApiError } from "@workspace/printavo";
import {
  priceHandoff,
  buildHandoffLines,
  assertReviewedPrices,
  snapshotHash,
  operationKey,
  requestDigest,
  isStrictIsoDate,
  HandoffValidationError,
  type HandoffPricingInput,
  type HandoffMatrix,
} from "../src/lib/hub/calcHandoffPure.ts";
import {
  buildHandoffMutation,
  executeHandoff,
  extractHandoffResult,
  HandoffConflictError,
  type HandoffRowLike,
  type HandoffSnapshot,
  type HandoffStore,
} from "../src/lib/hub/calcHandoffExec.ts";

const matrices: HandoffMatrix[] = [
  {
    id: "m1",
    name: "1st Print Loc",
    data: { xValues: [{ label: "1 Color", breaks: [{ qty: 12, decorationCost: 4 }, { qty: 48, decorationCost: 2.5 }, { qty: 144, decorationCost: 1.5 }] }] },
  },
  {
    id: "m2",
    name: "Addnl Print Loc",
    data: { xValues: [{ label: "2 Color", breaks: [{ qty: 12, decorationCost: 3 }, { qty: 48, decorationCost: 2 }] }] },
  },
];

const garment = (id: string, cost: number, sizes: Array<{ size: string; quantity: number }> = []) => ({
  id, style: `S${id}`, color: "Black", brand: "Brand", description: "Tee", categoryId: "c1", garmentCost: cost, sizes,
});
const decorations = [
  { id: "d1", placement: "Left Chest", details: "1 color logo", matrixId: "m1", columnIndex: 0 },
  { id: "d2", placement: "Full Back", details: "", matrixId: "m2", columnIndex: 0 },
];
const cats = new Map([["c1", "Screen Printing"]]);

test("compare: independent schedules per style, zero quantities, descriptive lines", () => {
  const input: HandoffPricingInput = { mode: "compare", markup: 2, rangeKey: "all", garments: [garment("a", 3), garment("b", 5)], decorations };
  const priced = priceHandoff(input, matrices);
  assert.deepEqual(priced.garments[0]!.schedule, [
    { qty: 12, unitPrice: 13 }, { qty: 48, unitPrice: 10.5 }, { qty: 144, unitPrice: 9.5 },
  ]);
  assert.equal(priced.garments[1]!.schedule[0]!.unitPrice, 17);
  const lines = buildHandoffLines(priced, cats);
  assert.equal(lines[0]!.quantity, 0);
  assert.deepEqual(lines[0]!.sizes, []);
  assert.equal(lines[0]!.price, 0);
  assert.match(lines[0]!.description, /12\+ = \$13\.00/);
  assert.equal(lines[0]!.categoryName, "Screen Printing");
});

test("compare: refuses ordered quantities instead of inventing an order", () => {
  assert.throws(
    () => priceHandoff({ mode: "compare", markup: 2, rangeKey: "all", garments: [garment("a", 3, [{ size: "M", quantity: 5 }])], decorations }, matrices),
    HandoffValidationError,
  );
});

test("mixed: combined qty sets the shared decoration tier, garment costs stay separate", () => {
  const input: HandoffPricingInput = {
    mode: "mixed", markup: 2, rangeKey: "all",
    garments: [garment("a", 3, [{ size: "M", quantity: 20 }, { size: "L", quantity: 10 }]), garment("b", 5, [{ size: "XL", quantity: 18 }])],
    decorations,
  };
  const priced = priceHandoff(input, matrices);
  assert.equal(priced.combinedQuantity, 48);
  assert.equal(priced.decorationCostPerPiece, 4.5);
  assert.equal(priced.garments[0]!.unitPrice, 10.5);
  assert.equal(priced.garments[1]!.unitPrice, 14.5);
  assert.deepEqual(priced.garments[0]!.sizes, [{ size: "size_m", count: 20 }, { size: "size_l", count: 10 }]);
  assert.doesNotThrow(() => assertReviewedPrices(priced, [{ garmentId: "a", unitPrice: 10.5 }, { garmentId: "b", unitPrice: 14.5 }]));
  assert.throws(() => assertReviewedPrices(priced, [{ garmentId: "a", unitPrice: 10.5 }, { garmentId: "b", unitPrice: 15 }]), HandoffValidationError);
});

test("mixed: missing size breakdown and missing matrix fail closed", () => {
  assert.throws(() => priceHandoff({ mode: "mixed", markup: 2, rangeKey: "all", garments: [garment("a", 3)], decorations }, matrices), /size breakdown/);
  assert.throws(
    () => priceHandoff({ mode: "mixed", markup: 2, rangeKey: "all", garments: [garment("a", 3, [{ size: "M", quantity: 1 }])], decorations: [{ ...decorations[0]!, matrixId: "gone" }] }, matrices),
    /no longer exists/,
  );
});

function snapshotFor(kind: "existing" | "new_quote"): HandoffSnapshot {
  const priced = priceHandoff({ mode: "mixed", markup: 2, rangeKey: "all", garments: [garment("a", 3, [{ size: "M", quantity: 30 }]), garment("b", 5, [{ size: "L", quantity: 18 }])], decorations }, matrices);
  return {
    target: kind === "existing"
      ? { kind, orderId: "ord1", visualId: 5012, orderType: "quote", groupPosition: 3 }
      : { kind, customerId: "cu1", companyName: "Harbor Rowing", contactId: "co1", contactName: "Dana", nickname: "Spring tees", dueDate: "2026-05-01" },
    mode: "mixed", markup: 2, rangeKey: null, combinedQuantity: 48, decorationCostPerPiece: 4.5,
    lines: buildHandoffLines(priced, cats),
    imprints: [
      { details: "Left Chest — 1 color logo", matrixName: "1st Print Loc", columnLabel: "1 Color", pricingMatrixColumnId: "pv-col-1" },
      { details: "Full Back", matrixName: "Addnl Print Loc", columnLabel: "2 Color", pricingMatrixColumnId: "pv-col-2" },
    ],
  };
}

test("payload: existing target creates ONE group with distinct lines, categories, imprints and live column ids", () => {
  const m = buildHandoffMutation(snapshotFor("existing"), "h1");
  assert.equal((m.match(/lineItemGroupCreate\(/g) ?? []).length, 1);
  assert.match(m, /parentId: "ord1"/);
  assert.match(m, /position: 3/);
  assert.equal((m.match(/category: \{ id: "c1" \}/g) ?? []).length, 2);
  assert.match(m, /pricingMatrixColumn: \{ id: "pv-col-1" \}/);
  assert.match(m, /details: "Left Chest — 1 color logo"/);
  assert.match(m, /price: 10\.50/);
  assert.match(m, /size: size_m, count: 30/);
  assert.doesNotMatch(m, /lineItemUpdate|lineItemDelete/);
});

test("payload: new quote uses quoteCreate with one group, category per line, exact sizes", () => {
  const m = buildHandoffMutation(snapshotFor("new_quote"), "h1");
  assert.match(m, /quoteCreate\(/);
  assert.match(m, /contact: \{ id: "co1" \}/);
  assert.match(m, /nickname: "Spring tees"/);
  assert.match(m, /category: \{ id: "c1" \}/);
  assert.match(m, /size: size_l, count: 18/);
});

test("snapshot hash changes when the destination changes", () => {
  const a = snapshotFor("existing");
  const b = { ...a, target: { ...a.target, groupPosition: 4 } } as HandoffSnapshot;
  assert.notEqual(snapshotHash(a), snapshotHash(b));
});

function memoryStore() {
  const rows = new Map<string, HandoffRowLike & { key: string }>();
  let n = 0;
  const store: HandoffStore = {
    async find(key) { return [...rows.values()].find((r) => r.key === key) ?? null; },
    async findByRequestDigest(d) { return [...rows.values()].find((r) => r.requestDigest === d) ?? null; },
    async claim({ operationKey: key, requestDigest: digest, snapshot }) {
      if ([...rows.values()].some((r) => r.key === key)) return null;
      const row = {
        key, id: `h${++n}`, requestDigest: digest, status: "attempting" as const, targetKind: snapshot.target.kind,
        orderId: null, visualId: null, resultOrderId: null, resultVisualId: null, resultPublicUrl: null,
        resultGroupId: null, resultLineItemIds: null, error: null,
      };
      rows.set(row.id, row);
      return row;
    },
    async markOk(id, patch) { Object.assign(rows.get(id)!, patch, { status: "ok" }); },
    async markUnknown(id, error) { Object.assign(rows.get(id)!, { status: "unknown", error }); },
    async release(id) { return rows.delete(id); },
  };
  return { store, rows };
}

const REQ_A = { mode: "mixed", orderId: "ord1", garments: ["a", "b"] };
function run(snapshot: HandoffSnapshot, store: HandoffStore, mutate: (m: string) => Promise<unknown>, req: object = REQ_A) {
  return executeHandoff({
    snapshot,
    operationKey: operationKey(snapshot),
    snapshotHash: snapshotHash(snapshot),
    requestDigest: requestDigest(req),
    actorEmail: null,
    store,
    mutate,
  });
}
const groupOk = async () => ({ lineItemGroupCreate: { id: "g1", lineItems: { nodes: [{ id: "l1" }, { id: "l2" }] } } });
const withPosition = (s: HandoffSnapshot, p: number) => ({ ...s, target: { ...s.target, groupPosition: p } }) as HandoffSnapshot;

test("operation key ignores derived append position; preview hash does not", () => {
  const a = snapshotFor("existing");
  assert.equal(operationKey(a), operationKey(withPosition(a, 4)));
  assert.notEqual(snapshotHash(a), snapshotHash(withPosition(a, 4)));
});

test("re-preview after a successful append (position moved) still dedupes, no second write", async () => {
  const { store } = memoryStore();
  let calls = 0;
  const mutate = async () => { calls++; return groupOk(); };
  const first = await run(snapshotFor("existing"), store, mutate);
  const again = await run(withPosition(snapshotFor("existing"), 4), store, mutate);
  assert.equal(calls, 1);
  assert.equal(first.deduped, false);
  assert.equal(again.deduped, true);
});

test("unknown hold survives re-preview at a new position", async () => {
  const { store } = memoryStore();
  let calls = 0;
  await assert.rejects(run(snapshotFor("existing"), store, async () => { calls++; throw new Error("socket hang up"); }), HandoffConflictError);
  await assert.rejects(run(withPosition(snapshotFor("existing"), 4), store, groupOk), /uncertain/);
  assert.equal(calls, 1);
});

test("a different request is rejected even when the matching operation already succeeded", async () => {
  const { store } = memoryStore();
  await run(snapshotFor("existing"), store, groupOk);
  await assert.rejects(run(snapshotFor("existing"), store, groupOk, { other: true }), /different request/);
});

test("browser-local garment ids cannot evade duplicate or uncertain-write holds", () => {
  const original = snapshotFor("existing");
  const recreated = {
    ...original,
    lines: original.lines.map((line, i) => ({ ...line, garmentId: `new-browser-${i}` })),
  };
  assert.equal(operationKey(original), operationKey(recreated));
});

test("duplicate clicks: one Printavo call, second request returns deduped result", async () => {
  const { store } = memoryStore();
  let calls = 0;
  const mutate = async () => { calls++; return { quoteCreate: { id: "q9", visualId: "7001", publicUrl: "https://pv/q9" } }; };
  const first = await run(snapshotFor("new_quote"), store, mutate);
  const second = await run(snapshotFor("new_quote"), store, mutate);
  assert.equal(calls, 1);
  assert.equal(first.visualId, 7001);
  assert.equal(second.deduped, true);
  assert.equal(second.publicUrl, "https://pv/q9");
});

test("concurrent clicks: in-flight claim blocks the second request", async () => {
  const { store } = memoryStore();
  let release!: () => void;
  let calls = 0;
  const mutate = () => { calls++; return new Promise((r) => { release = () => r(groupOk()); }); };
  const p1 = run(snapshotFor("existing"), store, mutate);
  await new Promise((r) => setImmediate(r));
  await assert.rejects(run(snapshotFor("existing"), store, mutate), HandoffConflictError);
  release();
  const r1 = await p1;
  assert.equal(calls, 1);
  assert.deepEqual(r1.lineItemIds, ["l1", "l2"]);
  assert.equal(r1.lineItemGroupId, "g1");
});

test("ambiguous transport failure locks as unknown and is never retried", async () => {
  const { store, rows } = memoryStore();
  let calls = 0;
  const mutate = async () => { calls++; throw new Error("socket hang up"); };
  await assert.rejects(run(snapshotFor("existing"), store, mutate), HandoffConflictError);
  await assert.rejects(run(snapshotFor("existing"), store, mutate), /uncertain/);
  assert.equal(calls, 1);
  assert.equal([...rows.values()][0]!.status, "unknown");
});

test("malformed success payloads lock as unknown instead of ok", async () => {
  const s = snapshotFor("existing");
  assert.equal(extractHandoffResult(s, { lineItemGroupCreate: { id: "g1", lineItems: { nodes: [{ id: "l1" }] } } }), null);
  assert.equal(extractHandoffResult(s, { lineItemGroupCreate: { id: "g1", lineItems: { nodes: [{ id: "l1" }, { id: "l1" }] } } }), null);
  assert.equal(extractHandoffResult(s, { lineItemGroupCreate: { lineItems: { nodes: [{ id: "l1" }, { id: "l2" }] } } }), null);
  assert.equal(extractHandoffResult(s, {}), null);
  const q = snapshotFor("new_quote");
  assert.equal(extractHandoffResult(q, { quoteCreate: { id: "q1", visualId: 0 } }), null);
  assert.equal(extractHandoffResult(q, { quoteCreate: { id: "", visualId: 5 } }), null);
  assert.equal(extractHandoffResult(q, { quoteCreate: { id: "q1", visualId: "abc" } }), null);
  const { store, rows } = memoryStore();
  await assert.rejects(run(s, store, async () => ({ lineItemGroupCreate: { id: "g1" } })), /incomplete/);
  assert.equal([...rows.values()][0]!.status, "unknown");
  await assert.rejects(run(s, store, groupOk), /uncertain/);
});

test("definitive GraphQL input rejection releases the claim", async () => {
  const { store, rows } = memoryStore();
  const err = Object.assign(Object.create(PrintavoApiError.prototype), {
    message: "rejected", httpStatus: 200, partialData: undefined,
    graphqlErrors: [{ message: "InputObject 'LineItemCreateInput' doesn't accept argument 'foo'" }],
  });
  await assert.rejects(run(snapshotFor("existing"), store, async () => { throw err; }), HandoffValidationError);
  assert.equal(rows.size, 0);
});

test("request digest ignores the preview binding but not content", () => {
  assert.equal(requestDigest({ a: 1, expectedSnapshotHash: "x" }), requestDigest({ a: 1 }));
  assert.notEqual(requestDigest({ a: 1 }), requestDigest({ a: 2 }));
});

test("strict calendar dates", () => {
  assert.equal(isStrictIsoDate("2026-05-01"), true);
  assert.equal(isStrictIsoDate("2028-02-29"), true);
  for (const bad of ["2026-02-30", "2026-02-29", "2026-13-01", "2026-04-31", "2026-5-01", "2026-05-01T00:00"]) {
    assert.equal(isStrictIsoDate(bad), false, bad);
  }
});

// ── Multi-style Production Notes + PNG ──────────────────────────────────
import { buildMultiNoteBlock, buildNoteBlock, spliceNoteBlock } from "../src/lib/hub/calcPush.ts";
import { computeDedupeKey, noteSectionsEqual, validateNoteSections } from "../src/lib/hub/pureHelpers.ts";
import { matchesConfirmedQuote } from "../src/lib/hub/pushTarget.ts";

const compareSections = [
  { label: "Brand · S1 · Black", kind: "schedule" as const, rows: [{ qty: 12, unitPrice: 13 }, { qty: 48, unitPrice: 10.5 }] },
  { label: "Brand · S2 · Navy", kind: "schedule" as const, rows: [{ qty: 12, unitPrice: 17 }, { qty: 48, unitPrice: 14.5 }] },
];
const mixedSections = [
  { label: "Brand · S1 · Black", kind: "order" as const, rows: [{ qty: 30, unitPrice: 10.5 }] },
  { label: "Brand · S2 · Navy", kind: "order" as const, rows: [{ qty: 18, unitPrice: 14.5 }] },
];

test("legacy single-style note block format is unchanged", () => {
  assert.equal(
    buildNoteBlock("5012", "all", [{ qty: 12, unitPrice: 13 }]),
    "[Hub Price Calculator Q5012]\nRange: All\nQTY\tUnit Price\n12+\t$13.00\n[/Hub Price Calculator Q5012]",
  );
});

test("compare multi-style: one block with every style schedule", () => {
  const block = buildMultiNoteBlock("5012", "all", compareSections);
  assert.equal((block.match(/\[Hub Price Calculator Q5012\]/g) ?? []).length, 1);
  assert.match(block, /Brand · S1 · Black\nQTY\tUnit Price\n12\+\t\$13\.00\n48\+\t\$10\.50/);
  assert.match(block, /Brand · S2 · Navy\nQTY\tUnit Price\n12\+\t\$17\.00/);
});

test("mixed multi-style: one block with pieces and unit price per style", () => {
  const block = buildMultiNoteBlock("7001", "all", mixedSections);
  assert.match(block, /Mixed order: 48 pcs combined/);
  assert.match(block, /Brand · S1 · Black\t30\t\$10\.50/);
  assert.match(block, /Brand · S2 · Navy\t18\t\$14\.50/);
});

test("multi-style block replaces an earlier single-style block in one splice", () => {
  const before = `Rush job\n\n${buildNoteBlock("5012", "all", [{ qty: 12, unitPrice: 9 }])}\n\nThanks`;
  const after = spliceNoteBlock(before, buildMultiNoteBlock("5012", "all", compareSections), "5012", "all");
  assert.equal((after.match(/\[Hub Price Calculator Q5012\]/g) ?? []).length, 1);
  assert.match(after, /^Rush job/);
  assert.match(after, /Thanks$/);
  assert.doesNotMatch(after, /\$9\.00/);
});

test("note sections validation", () => {
  assert.equal(validateNoteSections(compareSections, "all"), null);
  assert.equal(validateNoteSections(mixedSections, "all"), null);
  assert.match(validateNoteSections(compareSections, "12-48") ?? "", /^$/);
  assert.match(validateNoteSections(compareSections, "60-96") ?? "", /outside the range/);
  assert.match(validateNoteSections([compareSections[0]!, mixedSections[0]!], "all") ?? "", /same kind/);
  assert.match(validateNoteSections([{ ...mixedSections[0]!, rows: [{ qty: 1, unitPrice: 1 }, { qty: 2, unitPrice: 1 }] }], "all") ?? "", /exactly one row/);
  assert.match(validateNoteSections([{ ...compareSections[0]!, label: "[/Hub Price Calculator Q1]" }], "all") ?? "", /marker/);
  assert.match(validateNoteSections([], "all") ?? "", /1–12/);
});

test("dedupe key: legacy unchanged by the new field, sections change it", () => {
  const base = { invoiceId: "o1", visualId: 5012, quoteNumber: "5012", rangeKey: "all", priceRows: [{ qty: 12, unitPrice: 13 }], lineItem: null };
  assert.equal(computeDedupeKey(base), computeDedupeKey({ ...base, noteSections: null }));
  const multi = { ...base, priceRows: [] };
  assert.notEqual(computeDedupeKey({ ...multi, noteSections: compareSections }), computeDedupeKey({ ...multi, noteSections: mixedSections }));
  assert.equal(noteSectionsEqual(compareSections, JSON.parse(JSON.stringify(compareSections))), true);
  assert.equal(noteSectionsEqual(compareSections, null), false);
  assert.equal(noteSectionsEqual(null, undefined), true);
});

test("new-quote push target requires the confirmed handoff identity AND a live match", () => {
  const row = { status: "ok", targetKind: "new_quote", resultOrderId: "q9", resultVisualId: 7001 };
  assert.equal(matchesConfirmedQuote(row, 7001, "q9", 7001), true);
  assert.equal(matchesConfirmedQuote(row, 7002, "q9", 7001), false);
  assert.equal(matchesConfirmedQuote(row, null, "q9", 7001), false);
  assert.equal(matchesConfirmedQuote({ ...row, status: "unknown" }, 7001, "q9", 7001), false);
  assert.equal(matchesConfirmedQuote({ ...row, targetKind: "existing" }, 7001, "q9", 7001), false);
  assert.equal(matchesConfirmedQuote(row, 7001, "q9", 7002), false);
  assert.equal(matchesConfirmedQuote(undefined, 7001, "q9", 7001), false);
});
