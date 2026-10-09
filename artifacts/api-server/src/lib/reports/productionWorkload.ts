import type { ProductionWorkloadReport, ProductionWorkloadJob, ProductionWorkloadPeriod } from "@workspace/api-zod";
import type { ReportOrder } from "./dataset";
import { decorationProduction, totals } from "./decorationProduction";

export type Method = "print" | "embroidery";
export type MerchScope = "all" | "only" | "exclude";
export interface CompletionEvent { orderId: string; at: string; oldStatus: string | null; newStatus: string | null }
export interface WorkloadOptions { start: string; end: string; method: Method; merch: MerchScope; baselineWeeks: number }
const normalize = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const dateKey = (s: string | null) => s ? s.slice(0, 10) : null;
export const observedDay = (s: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(s));
export function addDays(s: string, n: number) { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function monday(s: string) { return addDays(s, -((new Date(`${s}T12:00:00Z`).getUTCDay() + 6) % 7)); }
export function validDate(s: unknown): s is string { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s; }
export function matchesMethod(status: string | null, method: Method) {
  const s = normalize(status);
  return /\bmixed(?: deco)?\b/.test(s) || (method === "print" ? /\bprint\b/.test(s) : /\b(emb|embroidery)\b/.test(s));
}
export function genericPickedUp(status: string | null) {
  return normalize(status) === "picked up";
}
export function finishedStatus(status: string | null, method: Method) {
  return genericPickedUp(status) || (matchesMethod(status, method) && /\b(complete|picked up|shipped|delivered)\b/.test(normalize(status)));
}
export function excludedStatus(status: string | null) {
  return /\b(dead|archive|archived|cancelled|canceled|void|outsourced)\b|\bstore (master|source)\b|\bmerch commitment\b/.test(normalize(status));
}
export function merchMatches(value: boolean | undefined, scope: MerchScope) {
  return scope === "all" || (scope === "only" ? value === true : value !== true);
}

/** One historical attribution per invoice/method. An old-value completion proves
 * it was already finished before observation, not that it finished that day. */
export function completionEvidence(status: string | null, events: CompletionEvent[], method: Method) {
  let day: string | null = null, completionStatus: string | null = null;
  let alreadyFinishedWithoutDate = false, lastMethodStatus: string | null = null;
  for (const e of events) {
    if (finishedStatus(e.oldStatus, method) && !day) alreadyFinishedWithoutDate = true;
    if (!lastMethodStatus && (matchesMethod(e.oldStatus, method) || genericPickedUp(e.oldStatus))) lastMethodStatus = e.oldStatus;
    if (matchesMethod(e.newStatus, method) || genericPickedUp(e.newStatus)) lastMethodStatus = e.newStatus;
    if (!day && !alreadyFinishedWithoutDate && finishedStatus(e.newStatus, method)) {
      day = observedDay(e.at); completionStatus = e.newStatus;
    }
  }
  const current = matchesMethod(status, method) || genericPickedUp(status) ? status : lastMethodStatus;
  const done = finishedStatus(current, method);
  // A different method completing does not prove this method is still pending.
  const unclear = !done && !matchesMethod(status, method)
    && /\b(complete|picked up|shipped|delivered)\b/.test(normalize(status));
  return { day, completionStatus, done, unclear };
}
export function indexEvents(events: CompletionEvent[]) {
  const map = new Map<string, CompletionEvent[]>();
  for (const event of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    const list = map.get(event.orderId) ?? []; list.push(event); map.set(event.orderId, list);
  }
  return map;
}

/** Production Due is the shop's produced date once its calendar day is past.
 * Status events still resolve undated/future job state, never historical dates. */
export function pastProductionDate(value: string | null, today: string) {
  const day = dateKey(value);
  return validDate(day) && day! < today ? day : null;
}
export function workloadCompletion(status: string | null, events: CompletionEvent[], method: Method, due: string | null, today: string) {
  const day = pastProductionDate(due, today);
  if (day) return { day, done: true, unclear: false, completionStatus: null };
  const evidence = completionEvidence(status, events, method);
  return { ...evidence, day: null, completionStatus: null };
}

export function productionWorkload(orders: ReportOrder[], events: CompletionEvent[], options: WorkloadOptions,
  historyAvailableFrom: string | null, today = observedDay(new Date().toISOString()), extraUndated = 0): ProductionWorkloadReport {
  const { method, merch, start, end, baselineWeeks } = options;
  const baselineStart = addDays(monday(today), -7 * baselineWeeks), baselineEnd = addDays(monday(today), -1);
  const scoped = orders.filter(o => merchMatches(o.productionMerch, merch)
    && (pastProductionDate(o.productionDueAt, today) || !excludedStatus(o.statusName)));
  const report = decorationProduction(scoped, method, { limit: Number.MAX_SAFE_INTEGER });
  const source = new Map(scoped.map(o => [o.id, o]));
  const eventMap = indexEvents(events);
  const jobs: ProductionWorkloadJob[] = [];
  let undatedCompletedInvoices = extraUndated;
  for (const job of report.jobs) {
    const order = source.get(job.id)!;
    const evidence = workloadCompletion(order.statusName, eventMap.get(job.id) ?? [], method, order.productionDueAt, today);
    const dueDate = dateKey(order.productionDueAt);
    const historical = !!evidence.day && evidence.day >= baselineStart && evidence.day <= baselineEnd;
    if (evidence.done && !evidence.day) undatedCompletedInvoices++;
    const disposition = evidence.done ? "completed" : evidence.unclear ? "unclear"
      : !dueDate ? "unscheduled" : dueDate < today ? "overdue" : "scheduled";
    if (!historical && (disposition === "completed" || (disposition === "scheduled" && (dueDate! < start || dueDate! > end)))) continue;
    jobs.push({ job, status: order.statusName, merch: !!order.productionMerch, dueDate,
      completedDate: evidence.day, completionStatus: evidence.completionStatus, disposition });
  }
  const period = (key: string, from: string, to: string, selected: ProductionWorkloadJob[]): ProductionWorkloadPeriod => ({
    key, start: from, end: to, totals: totals(selected.map(j => j.job), method),
    locations: selected.reduce((n, j) => n + j.job.groups.reduce((m, g) => m + g.locations.length, 0), 0),
    jobIds: selected.map(j => j.job.id),
  });
  const pending = jobs.filter(j => j.disposition === "scheduled" && j.dueDate! >= start && j.dueDate! <= end);
  const historical = jobs.filter(j => j.completedDate && j.completedDate >= baselineStart && j.completedDate <= baselineEnd);
  const periods = (from: string, to: string, list: ProductionWorkloadJob[], history: boolean) => {
    const days: ProductionWorkloadPeriod[] = [], weeks: ProductionWorkloadPeriod[] = [];
    for (let day = from; day <= to; day = addDays(day, 1)) {
      days.push(period(day, day, day, list.filter(j => (history ? j.completedDate : j.dueDate) === day)));
    }
    for (let week = monday(from); week <= to; week = addDays(week, 7)) {
      const first = week < from ? from : week, last = addDays(week, 6) > to ? to : addDays(week, 6);
      weeks.push(period(week, first, last, list.filter(j => {
        const day = history ? j.completedDate : j.dueDate; return day! >= first && day! <= last;
      })));
    }
    return { days, weeks };
  };
  const future = periods(start, end, pending, false), past = periods(baselineStart, baselineEnd, historical, true);
  return {
    method, merch, start, end, baselineStart, baselineEnd, baselineWeeks, historyAvailableFrom,
    historyCoversBaseline: !!historyAvailableFrom && historyAvailableFrom <= baselineStart,
    scheduled: period("scheduled", start, end, pending),
    overdue: period("overdue", "", addDays(today, -1), jobs.filter(j => j.disposition === "overdue")),
    unscheduled: period("unscheduled", "", "", jobs.filter(j => j.disposition === "unscheduled")),
    unclear: period("unclear", "", "", jobs.filter(j => j.disposition === "unclear")),
    history: period("history", baselineStart, baselineEnd, historical),
    days: future.days, weeks: future.weeks, historyDays: past.days, historyWeeks: past.weeks, jobs,
    undatedCompletedInvoices, excludedIncompleteInvoices: report.excludedIncompleteInvoices,
    unclassifiedGroups: report.unclassifiedGroups, excludedQuantityGroups: report.excludedQuantityGroups,
    recognizedCompletionStatuses: [...new Set([...scoped.map(o => o.statusName), ...events.flatMap(e => [e.oldStatus, e.newStatus])]
      .filter((s): s is string => !!s && finishedStatus(s, method)))].sort(),
  };
}
