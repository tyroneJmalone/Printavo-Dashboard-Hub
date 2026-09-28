// Fully offline: real upsertOrder bundled against in-memory DB/Drizzle adapters.
// No database package, credentials, public defaults, or network is loaded.
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const mockDb = `
export const state = { orders: [], events: [], trace: [], failEvents: false };
export const pvOrdersTable = Object.fromEntries(
  ["printavoId", "visualId", "customerId", "orderType"].map(k => [k, k]));
export const changeEventsTable = { name: "events" };
export const pvCustomersTable = {};
export const pvContactsTable = {};
export const pvStatusesTable = {};
function adapter(inTransaction = false) {
  return {
    select() {
      let predicate = () => true;
      let limit = Infinity;
      const query = {
        from() { return query; },
        where(p) { predicate = p; return query; },
        limit(n) { limit = n; return query; },
        for(mode) {
          if (!inTransaction) throw Error("lock outside transaction");
          state.trace.push("lock:" + mode);
          return query;
        },
        then(resolve, reject) {
          return Promise.resolve(state.orders.filter(predicate).slice(0, limit))
            .then(resolve, reject);
        }
      };
      return query;
    },
    delete() {
      if (!inTransaction) throw Error("delete outside transaction");
      return { async where(predicate) {
        state.trace.push("delete");
        state.orders = state.orders.filter(row => !predicate(row));
      }};
    },
    insert(table) {
      if (!inTransaction) throw Error("insert outside transaction");
      return { async values(value) {
        if (table === changeEventsTable) {
          state.trace.push("events");
          if (state.failEvents) throw Error("preservation failed");
          state.events.push(...structuredClone(value));
        } else {
          state.trace.push("invoice");
          state.orders.push(structuredClone(value));
        }
      }};
    },
    async transaction(fn) {
      const before = structuredClone({ orders: state.orders, events: state.events });
      state.trace.push("begin");
      try {
        const result = await fn(adapter(true));
        state.trace.push("commit");
        return result;
      } catch (error) {
        state.orders = before.orders;
        state.events = before.events;
        state.trace.push("rollback");
        throw error;
      }
    }
  };
}
export const db = adapter();
`;

const bundle = await build({
  stdin: {
    contents: `export { upsertOrder } from "./src/lib/sync/upserts";
      export { state } from "@workspace/db";`,
    resolveDir: import.meta.dirname,
    loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false,
  plugins: [{
    name: "offline-db-only",
    setup(b) {
      b.onResolve({ filter: /^(@workspace\/db|drizzle-orm)$/ }, args => ({
        path: args.path, namespace: "offline",
      }));
      b.onLoad({ filter: /.*/, namespace: "offline" }, args => ({
        contents: args.path === "@workspace/db" ? mockDb : `
          export const eq = (column, value) => row => row[column] === value;
          export const and = (...predicates) => row => predicates.every(p => p(row));`,
        loader: "js",
      }));
    },
  }],
});
const { upsertOrder, state } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const quoteDate = "2025-12-24T14:22:00.000Z";
const firstSeen = new Date("2025-12-25T00:00:00Z");
function quote(id = "quote-a", customerId = "customer-a", visualId = 123) {
  return {
    printavoId: id, customerId, visualId, orderType: "quote",
    statusName: "Quote Approved", printavoCreatedAt: new Date(quoteDate),
    firstSeenAt: firstSeen, contentHash: "prior",
  };
}
function invoice(customerId = "customer-a") {
  return {
    id: "invoice-a", visualId: 123, total: 100,
    status: { id: "won", name: "Ready to Go" },
    contact: { id: "contact-a", customer: customerId ? { id: customerId } : null },
    timestamps: { createdAt: "2026-01-01T15:00:00Z" },
  };
}
function reset(orders) {
  Object.assign(state, { orders: structuredClone(orders), events: [], trace: [], failEvents: false });
}

test("upsert conversion preserves original quote date/customer/status in atomic quiet-seed transaction", async () => {
  reset([quote(), quote("other-customer", "customer-b"), quote("other-visual", "customer-a", 124)]);
  const result = await upsertOrder(invoice(), "invoice", { emitEvents: false, syncRunId: null });
  assert.deepEqual(result, { outcome: "converted", events: 1 });
  assert.deepEqual(state.trace, ["begin", "lock:update", "delete", "invoice", "events", "commit"]);
  assert.deepEqual(state.orders.map(o => o.printavoId), ["other-customer", "other-visual", "invoice-a"]);
  assert.deepEqual(state.orders.at(-1).firstSeenAt, firstSeen);
  assert.equal(state.orders.at(-1).printavoCreatedAt.toISOString(), "2026-01-01T15:00:00.000Z");
  assert.deepEqual(state.events[0].oldValue, {
    printavoId: "quote-a", orderType: "quote", quoteHistoryVersion: "1",
    quoteCreatedAt: quoteDate, customerId: "customer-a", statusName: "Quote Approved",
  });
  assert.equal(state.events[0].entityId, "invoice-a");
  assert.equal(state.events[0].visualId, 123);
  assert.equal(state.events[0].newValue.customerId, "customer-a");
  assert.equal(state.events[0].newValue.statusName, "Ready to Go");
});

test("ambiguous, mismatched and missing customer identities never delete a quote or fabricate conversion", async () => {
  for (const fixture of [
    { quotes: [quote(), quote("duplicate")], node: invoice() },
    { quotes: [quote("different", "customer-b")], node: invoice() },
    { quotes: [quote()], node: invoice(null) },
    { quotes: [quote("different-visual", "customer-a", 124)], node: invoice() },
  ]) {
    reset(fixture.quotes);
    const original = structuredClone(state.orders);
    const result = await upsertOrder(fixture.node, "invoice", { emitEvents: false, syncRunId: null });
    assert.deepEqual(result, { outcome: "created", events: 0 });
    assert.deepEqual(state.orders.slice(0, -1), original);
    assert.equal(state.orders.length, original.length + 1);
    assert.equal(state.trace.includes("delete"), false);
    assert.deepEqual(state.events, []);
  }
});

test("preservation insert failure rolls back invoice insertion and quote deletion together", async () => {
  reset([quote()]);
  const original = structuredClone(state.orders);
  state.failEvents = true;
  await assert.rejects(
    upsertOrder(invoice(), "invoice", { emitEvents: false, syncRunId: null }),
    /preservation failed/,
  );
  assert.deepEqual(state.orders, original);
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.trace, ["begin", "lock:update", "delete", "invoice", "events", "rollback"]);
});

test("unknown original quote creation remains null, never replaced with invoice creation", async () => {
  reset([{ ...quote(), printavoCreatedAt: null }]);
  await upsertOrder(invoice(), "invoice", { emitEvents: true, syncRunId: 7 });
  assert.equal(state.events[0].oldValue.quoteCreatedAt, null);
  assert.equal(state.events[0].syncRunId, 7);
  assert.equal(state.events[0].eventType, "converted");
});