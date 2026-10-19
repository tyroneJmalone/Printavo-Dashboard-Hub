import { test } from "node:test";
import assert from "node:assert/strict";
import { pushCalcToInvoice } from "../src/lib/hub/calcPush";

// All infrastructure is replaced by the runner; never touches Printavo/storage/DB.
function fixture(orderType: "invoice" | "quote" = "invoice") {
  const state = {
    orderType,
    liveVisualId: 123,
    note: "Staff notes\n[Hub Price Calculator Q123]\nOld pricing\n[/Hub Price Calculator Q123]",
    mutations: [] as string[],
    patches: [] as Record<string, unknown>[],
    failFile: false,
    upload: {
      id: "upload1", invoiceId: "order1", visualId: 123,
      quoteNumber: "123", rangeKey: "all", priceRows: [{ qty: 12, unitPrice: 10 }],
      noteSections: null, lineItemSnapshot: null,
      productionFileId: null as string | null, noteOk: false,
      noteAttemptedAt: null as Date | null, fileAttemptedAt: null as Date | null,
    },
    client: {
      async query() {
        return { [state.orderType]: { id: "order1", visualId: state.liveVisualId, productionNote: state.note } };
      },
      async mutate(mutation: string) {
        state.mutations.push(mutation);
        if (mutation.includes("productionFileCreate")) {
          if (state.failFile) throw new Error("ambiguous file timeout");
          return { productionFileCreate: { id: "file1" } };
        }
        return {};
      },
    },
  };
  (globalThis as unknown as { calcTest: typeof state }).calcTest = state;
  const request = {
    uploadId: "upload1", invoiceId: "order1", visualId: 123,
    quoteNumber: "123", rangeKey: "all", priceRows: [{ qty: 12, unitPrice: 10 }],
    includeProductionNotes: false,
  };
  return { state, request };
}

for (const type of ["invoice", "quote"] as const) {
  test(`${type}: PNG only skips notes and repeated push does not attach twice`, async () => {
    const { state, request } = fixture(type);
    const result = await pushCalcToInvoice(request);
    assert.equal(result.noteOutcome.skipped, true);
    assert.equal(result.fileOutcome.ok, true);
    assert.equal(state.mutations.length, 1);
    assert.match(state.mutations[0]!, /productionFileCreate/);
    assert.equal(state.upload.noteAttemptedAt, null);
    assert.equal(state.upload.noteOk, false);
    assert.ok(state.patches.every((patch) => !("noteOk" in patch) && !("noteAttemptedAt" in patch)));
    await pushCalcToInvoice(request);
    assert.equal(state.mutations.length, 1);
  });
}

test("omitting the option preserves the notes + PNG default", async () => {
  const { state, request } = fixture();
  const result = await pushCalcToInvoice({ ...request, includeProductionNotes: undefined });
  assert.equal(result.noteOutcome.skipped, false);
  assert.equal(state.mutations.length, 2);
  assert.match(state.mutations[0]!, /invoiceUpdate/);
  assert.match(state.mutations[1]!, /productionFileCreate/);
});

test("enabling notes later reuses the attachment without duplicating it", async () => {
  const { state, request } = fixture();
  await pushCalcToInvoice(request);
  await pushCalcToInvoice({ ...request, includeProductionNotes: true });
  assert.equal(state.mutations.length, 2);
  assert.match(state.mutations[1]!, /invoiceUpdate/);
});

test("PNG-only does not repair, clear or retry an uncertain note attempt", async () => {
  const { state, request } = fixture();
  state.upload.noteAttemptedAt = new Date();
  const attempted = state.upload.noteAttemptedAt;
  state.note = "[Hub Price Calculator Q123]\nMalformed unclosed block";
  const result = await pushCalcToInvoice(request);
  assert.equal(result.fileOutcome.ok, true);
  assert.equal(state.upload.noteAttemptedAt, attempted);
  assert.equal(state.upload.noteOk, false);
  assert.equal(state.mutations.length, 1);
  assert.match(state.mutations[0]!, /productionFileCreate/);
});

test("uncertain file attach remains locked when the notes option changes", async () => {
  const { state, request } = fixture();
  state.failFile = true;
  const first = await pushCalcToInvoice(request);
  assert.equal(first.fileOutcome.locked, true);
  const second = await pushCalcToInvoice({ ...request, includeProductionNotes: true });
  assert.equal(second.fileOutcome.locked, true);
  assert.equal(state.mutations.filter((m) => m.includes("productionFileCreate")).length, 1);
});

test("PNG-only validates the live target number before any write", async () => {
  const { state, request } = fixture();
  state.liveVisualId = 999;
  await assert.rejects(pushCalcToInvoice(request), /does not match/);
  assert.equal(state.mutations.length, 0);
});
