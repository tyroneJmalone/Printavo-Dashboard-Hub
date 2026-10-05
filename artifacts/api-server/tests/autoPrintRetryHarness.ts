// Offline engine boundary: every database, network, renderer and status-job
// dependency is replaced by the test runner. No credentials or live writes.
import assert from "node:assert/strict";
import { canReservePrint } from "../src/lib/printQueue/autoPrint/candidatePlanning";

export const pqPrintRunsTable = table("runs");
export const pqPrintJobsTable = table("jobs");
export const pvOrdersTable = table("orders");
export const changeEventsTable = table("events");
export const pvStatusesTable = table("statuses");
function table(name: string): any {
  return new Proxy({ name }, { get: (target, key) => key === "name" ? target.name : String(key) });
}
export const eq = (column: string, value: unknown) => (row: any) => row[column] === value;
export const inArray = (column: string, values: unknown[]) => (row: any) => values.includes(row[column]);
export const and = (...checks: any[]) => (row: any) => checks.every((check) => check(row));
export const or = (...checks: any[]) => (row: any) => checks.some((check) => check(row));
export const desc = (value: unknown) => value;
export const sql = () => null;

export const h: any = {};
export const loadPurchaseNotes = async () => [];
export function reset(options: Record<string, unknown> = {}) {
  Object.assign(h, {
    runs: [], jobs: [], events: [], statuses: [{ printavoId: "source", name: "Ordered" }],
    orders: [{ printavoId: "order", visualId: 100, nickname: "Test", statusId: "source", statusName: "Ordered",
      data: { workorderUrl: "https://shop.printavo.com/work_orders/test" }, detailSyncedAt: new Date(),
      orderType: "invoice", customerDueAt: null }],
    renderCalls: 0, startupCalls: 0, sendCalls: 0, statusCalls: 0, claimCalls: 0,
    detailCalls: 0, closes: 0, delays: [], statusJobs: [], poBatches: [], timeline: [],
    renderFailures: 0, startupFailures: 0, submissionError: null, submissionId: 123,
    afterClaimFailures: 0, permanentRenderError: null, moved: false, conflict: false,
    uncertainPersistence: false, detailFailures: 0, statusFailures: 0,
    missingDetail: false, permanentDetailError: null, permanentStartupError: null,
    discoveryError: null, ...options,
  });
}
function query(rows: () => any[]) {
  let predicate = (_row: any) => true;
  let limit = Infinity;
  const chain: any = {
    from(t: any) { rows = () => h[t.name]; return chain; },
    where(check: any) { predicate = check; return chain; },
    orderBy() { return chain; },
    limit(n: number) { limit = n; return chain; },
    then(resolve: any, reject: any) {
      return Promise.resolve().then(() => rows().filter(predicate).slice(0, limit)).then(resolve, reject);
    },
  };
  return chain;
}
export const db: any = {
  select: () => query(() => []),
  insert(t: any) {
    let values: any;
    let committed: any[] | null = null;
    const commit = () => {
      if (committed) return committed;
      committed = (Array.isArray(values) ? values : [values]).map((value: any) => ({
        id: `${t.name}-${h[t.name].length + 1}`, createdAt: new Date(), ...structuredClone(value),
      }));
      h[t.name].push(...committed!);
      return committed;
    };
    const chain: any = {
      values(v: any) { values = v; return chain; },
      onConflictDoNothing() { return chain; },
      returning() { return Promise.resolve(commit()); },
      then(resolve: any, reject: any) { return Promise.resolve().then(commit).then(resolve, reject); },
    };
    return chain;
  },
  update(t: any) {
    return { set(values: any) { return { async where(check: any) {
      if (h.uncertainPersistence && values.status === "printed") throw new Error("database connection lost");
      for (const row of h[t.name].filter(check)) Object.assign(row, structuredClone(values));
    } }; } };
  },
  async transaction(fn: any) {
    h.claimCalls++;
    if (h.conflict) h.jobs.push({ id: "other-claim", docType: "workorder", printavoOrderId: "order", visualId: "100", status: "pending" });
    return fn(db);
  },
  execute: async () => {},
};
export const getAutoPrintConfig = async () => ({
  sourceStatusIds: ["source"], printerId: "1", printerName: "Offline", copies: 1,
  dryRun: false, excludeAttachments: true, routingMode: "category",
  categoryMappings: [{ category: "Screen Printing", statusId: "success", statusName: "Printed" }],
  errorStatusId: "error",
});
export const upsertOrder = async (node: any) => {
  const row = h.orders.find((row: any) => row.printavoId === node.id);
  if (row) Object.assign(row, { statusId: node.status.id, statusName: node.status.name });
};
export const newDetailAgg = () => ({});
export const applyOrderDetail = async () => "written";
const detail = () => ({ id: "order", visualId: 100,
  lineItemGroups: { pageInfo: { hasNextPage: false }, nodes: [
    { lineItems: { pageInfo: { hasNextPage: false }, nodes: [
      { id: "line", category: { name: "Screen Printing" }, items: 1 },
    ] } },
  ] } });
export const singleOrderDetailQuery = () => "offline query";
export const getPrintavoClient = () => ({ query: async () => {
  h.detailCalls++;
  if (h.permanentDetailError) throw h.permanentDetailError;
  if (h.detailFailures-- > 0) throw Object.assign(new Error("Printavo HTTP 503"), { httpStatus: 503 });
  if (h.missingDetail) return { invoice: null };
  return { invoice: detail() };
} });
export const discoverLiveAutoPrintOrders = async () => {
  if (h.discoveryError) throw h.discoveryError;
  return ({
  orders: h.orders.map((row: any) => ({ kind: "invoices", node: {
    id: row.printavoId, visualId: row.visualId, nickname: row.nickname,
    status: { id: "source", name: "Ordered" },
  } })),
  pages: { invoices: 1, quotes: 0 },
  });
};
export class LiveDiscoveryError extends Error {}
export const liveOrderStatusMatches = (observed: any, expected: any) => !!observed &&
  observed.orderId === expected.orderId && observed.visualId === expected.visualId &&
  observed.statusId === expected.sourceStatusId;
export const fetchLiveOrderStatus = async () => {
  h.statusCalls++;
  if (h.statusFailures-- > 0) throw new Error("fetch failed");
  if (h.afterClaimFailures && h.jobs.some((job: any) => job.status === "pending")) {
    h.afterClaimFailures--;
    h.timeline.push("pre-send-failure");
    throw new Error("fetch failed");
  }
  return { orderId: "order", visualId: 100, statusId: h.moved && h.renderCalls ? "moved" : "source", statusName: "Ordered" };
};
export const printNodeConfigured = () => true;
export const submitPdfPrintJob = async () => {
  h.sendCalls++;
  h.timeline.push("send");
  assert.equal(h.jobs.filter((job: any) => job.status === "pending").length, 1, "durable claim before send");
  if (h.submissionError) throw h.submissionError;
  return h.submissionId;
};
export const openPdfRenderer = async (options: any) => {
  h.startupCalls++;
  assert.equal(options.maxStartupAttempts, 1, "no nested retry budgets");
  if (h.permanentStartupError) throw h.permanentStartupError;
  if (h.startupFailures-- > 0) throw Object.assign(new Error("Chromium startup failed (timeout) after 1 attempts"), { reason: "timeout" });
  return {
    renderUrl: async () => {
      h.renderCalls++;
      h.timeline.push("render");
      if (h.permanentRenderError) throw new Error(h.permanentRenderError);
      if (h.renderFailures-- > 0) throw new Error("Printavo returned 503");
      return Buffer.from("offline PDF");
    },
    renderHtml: async () => Buffer.from("offline PO"),
    close: async () => { h.closes++; },
  };
};
export const startPqStatusJob = async (_source: any, lines: any) => {
  h.timeline.push("status-finalized");
  h.statusJobs.push(lines);
  return { status: "started", job: { id: "status-job" } };
};
export const runHubPoBatch = async (input: any) => {
  h.poBatches.push(input);
  return { printed: input.successfullyPrintedOrders.length ? 1 : 0, failed: 0, unknown: 0, warnings: [] };
};
export const loadPurchaseNotes = async () => [];
export const sleep = async (ms: number) => {
  h.delays.push(ms);
  assert.equal(h.sendCalls, 0, "never back off after sending");
  assert.equal(h.statusJobs.length, 0, "no intermediate status finalization");
  const claims = h.jobs.filter((job: any) => job.status === "pending");
  if (claims.length) {
    assert.equal(canReservePrint(claims, null), false, "retained pending claims block other runs");
    assert.ok(claims[0].attemptKey, "retry does not release the durable key");
  }
};