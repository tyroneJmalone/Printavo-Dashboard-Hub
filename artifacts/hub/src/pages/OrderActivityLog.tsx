import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  useSearchOrderActivityLog,
  getSearchOrderActivityLogQueryKey,
  getOrderActivityLog,
  type OrderActivityLogSearchResponse,
} from "@workspace/api-client-react";
import { AppShell } from "@/components/layout/AppShell";
import { OrderLineItemHistory } from "@/components/OrderLineItemHistory";
import { OrderActivityChange } from "@/components/OrderActivityChange";
import { activityFieldLabel } from "@/components/orderActivityChanges";
import {
  Search, History, ChevronLeft, ChevronRight, AlertTriangle, RefreshCw, Info, ArrowRight,
  FileSpreadsheet, ListTree, Eye, CalendarDays, FileCheck, Printer,
} from "lucide-react";

type SearchResponse = OrderActivityLogSearchResponse;
type LogResponse = Awaited<ReturnType<typeof getOrderActivityLog>>;
type LogOrder = NonNullable<SearchResponse>["orders"][number];
type LogEvent = LogResponse["events"][number];

const PAGE = 20;
const FEED_PAGE = 50;
const CATEGORIES = [
  { id: "all", label: "All" },
  { id: "status", label: "Status" },
  { id: "line-items", label: "Line items" },
  { id: "order", label: "Order" },
  { id: "payments", label: "Payments" },
  { id: "files", label: "Files" },
  { id: "printing", label: "Printing" },
] as const;
type Category = (typeof CATEGORIES)[number]["id"];

const CATEGORY_TONE: Record<string, string> = {
  status: "bg-sky-500/10 text-sky-300 border-sky-500/20",
  "line-items": "bg-amber-500/10 text-amber-300 border-amber-500/20",
  order: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
  payments: "bg-lime-500/10 text-lime-300 border-lime-500/20",
  files: "bg-violet-500/10 text-violet-300 border-violet-500/20",
  printing: "bg-rose-500/10 text-rose-300 border-rose-500/20",
};

function timestampMeta(kind: string) {
  switch (kind) {
    case "business-date":
      return { icon: CalendarDays, label: "Payment business date", hint: "Date recorded on the payment, not when the Hub saw it", dateOnly: true };
    case "milestone":
      return { icon: FileCheck, label: "File mirror milestone", hint: "When the Hub recorded this file mirror milestone", dateOnly: false };
    case "job-outcome":
      return { icon: Printer, label: "Print job recorded", hint: "When the Hub recorded the print job outcome; does not confirm physical printing", dateOnly: false };
    case "observation":
      return { icon: Eye, label: "Observed by sync", hint: "When the Hub noticed the change; the actual change may be earlier", dateOnly: false };
    default:
      return { icon: Eye, label: kind || "Recorded", hint: "Timestamp type reported by the server", dateOnly: false };
  }
}

function fmtDate(iso: string, dateOnly: boolean) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return dateOnly
    ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
    : d.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function dayKey(iso: string, dateOnly = false) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "Unknown date" : d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric", ...(dateOnly ? { timeZone: "UTC" } : {}) });
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function SearchPanel({ selectedId, onPick }: { selectedId: string | null; onPick: (o: LogOrder) => void }) {
  const [text, setText] = useState("");
  const [offset, setOffset] = useState(0);
  const search = useDebounced(text.trim(), 300);
  useEffect(() => setOffset(0), [search]);
  const params = { search: search || undefined, limit: PAGE, offset };
  const q = useSearchOrderActivityLog(params, {
    query: { queryKey: getSearchOrderActivityLogQueryKey(params), staleTime: 30_000, placeholderData: (p) => p },
  });
  const orders = q.data?.orders ?? [];
  const total = q.data?.total ?? 0;

  return (
    <section className="rounded-xl border border-slate-800 bg-[#0f172a] flex flex-col min-h-0">
      <div className="p-3 border-b border-slate-800">
        <label className="relative block">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            data-testid="input-order-search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Invoice # or customer name"
            className="w-full rounded-md bg-slate-900 border border-slate-700 pl-9 pr-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-600"
          />
        </label>
      </div>
      <div className="flex-1 overflow-y-auto custom-scrollbar">
        {q.isLoading ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-14 rounded-md bg-slate-800/50 animate-pulse" />)}
          </div>
        ) : q.isError ? (
          <div className="p-6 text-center text-sm text-slate-400">
            <AlertTriangle className="mx-auto text-amber-400 mb-2" size={20} />
            Couldn't search orders.
            <button data-testid="button-retry-search" onClick={() => q.refetch()} className="mt-3 mx-auto flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 text-xs font-semibold">
              <RefreshCw size={12} /> Retry
            </button>
          </div>
        ) : orders.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            {search ? <>No orders match "{search}".</> : "No orders synced yet."}
          </div>
        ) : (
          <ul className={`divide-y divide-slate-800/70 transition-opacity ${q.isFetching ? "opacity-60" : ""}`}>
            {orders.map((o) => {
              const active = o.id === selectedId;
              return (
                <li key={o.id}>
                  <button
                    data-testid={`button-pick-order-${o.id}`}
                    onClick={() => onPick(o)}
                    className={`w-full text-left px-4 py-3 transition-colors border-l-2 ${active ? "bg-emerald-500/10 border-emerald-500" : "border-transparent hover:bg-slate-800/60"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-slate-100">#{o.visualId ?? "—"}</span>
                      <span className="text-[10px] uppercase tracking-wider text-slate-500">{o.orderType}</span>
                      {o.statusName && <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 truncate max-w-[45%]">{o.statusName}</span>}
                    </div>
                    <div className="text-xs text-slate-400 mt-0.5 truncate">{o.customerName || "Unknown customer"}{o.nickname ? ` · ${o.nickname}` : ""}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between px-3 py-2 border-t border-slate-800 text-[11px] text-slate-500">
        <span data-testid="text-search-range">{total ? `${offset + 1}–${Math.min(offset + PAGE, total)} of ${total}` : "0 results"}</span>
        <div className="flex gap-1">
          <button data-testid="button-search-prev" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))} className="p-1 rounded hover:bg-slate-800 disabled:opacity-30"><ChevronLeft size={14} /></button>
          <button data-testid="button-search-next" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)} className="p-1 rounded hover:bg-slate-800 disabled:opacity-30"><ChevronRight size={14} /></button>
        </div>
      </div>
    </section>
  );
}

function EventRow({ e }: { e: LogEvent }) {
  const meta = timestampMeta(e.timestampKind);
  const dateOnly = meta.dateOnly;
  const hasDiff = e.oldValue != null || e.newValue != null;
  const isLineFieldChange = e.source === "change_events" && e.title === "Line item field_change";
  const field = e.description ?? "";
  return (
    <li data-testid={`row-event-${e.id}`} className="relative pl-6 pb-5">
      <span className="absolute left-0 top-1.5 w-2.5 h-2.5 rounded-full bg-slate-900 border-2 border-emerald-500" />
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border ${CATEGORY_TONE[e.category] ?? "bg-slate-800 text-slate-300 border-slate-700"}`}>{e.category}</span>
        <span className="text-sm font-medium text-slate-100">{isLineFieldChange ? `Line item · ${activityFieldLabel(field)} changed` : e.title}</span>
      </div>
      {e.description && !isLineFieldChange && <p className="text-xs text-slate-400 mt-1">{e.description}</p>}
      {hasDiff && isLineFieldChange && <OrderActivityChange field={field} before={e.oldValue} after={e.newValue} />}
      {hasDiff && !isLineFieldChange && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs font-mono">
          <span className="px-2 py-1 rounded bg-rose-500/5 border border-rose-500/15 text-rose-200/80 line-through decoration-rose-400/40">{e.oldValue ?? "(empty)"}</span>
          <ArrowRight size={12} className="text-slate-600" />
          <span className="px-2 py-1 rounded bg-emerald-500/5 border border-emerald-500/20 text-emerald-200">{e.newValue ?? "(empty)"}</span>
        </div>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
        <span title={meta.hint} className="flex items-center gap-1"><meta.icon size={11} /> {meta.label}: {fmtDate(e.occurredAt, dateOnly)}</span>
        <span>Source: {e.source}</span>
      </div>
    </li>
  );
}

function Feed({ order }: { order: LogOrder }) {
  const [category, setCategory] = useState<Category>("all");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [meta, setMeta] = useState<LogResponse | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [reload, setReload] = useState(0);
  const reqId = useRef(0);

  const filters = useMemo(() => ({
    category: category === "all" ? undefined : category,
    start: start ? new Date(`${start}T00:00:00`).toISOString() : undefined,
    end: end ? new Date(`${end}T23:59:59.999`).toISOString() : undefined,
  }), [category, start, end]);

  async function load(more: boolean) {
    const id = ++reqId.current;
    more ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const res = await getOrderActivityLog(order.id, { ...filters, limit: FEED_PAGE, cursor: more ? cursor ?? undefined : undefined });
      if (id !== reqId.current) return;
      setMeta(res);
      setCursor(res.nextCursor ?? null);
      setEvents((prev) => {
        const base = more ? prev : [];
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...res.events.filter((x) => !seen.has(x.id) && (seen.add(x.id), true))];
      });
    } catch (err) {
      if (id !== reqId.current) return;
      setError(err instanceof Error ? err.message : "Couldn't load activity");
    } finally {
      if (id === reqId.current) { setLoading(false); setLoadingMore(false); }
    }
  }

  useEffect(() => {
    setEvents([]); setCursor(null); setMeta(null);
    load(false);
    return () => { reqId.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id, filters, reload]);

  const grouped = useMemo(() => {
    const out: { day: string; items: LogEvent[] }[] = [];
    for (const e of events) {
      const d = dayKey(e.occurredAt, e.timestampKind === "business-date");
      if (out.at(-1)?.day === d) out.at(-1)!.items.push(e); else out.push({ day: d, items: [e] });
    }
    return out;
  }, [events]);

  const head = meta?.order ?? order;
  const coverage = meta?.coverage;

  return (
    <section className="rounded-xl border border-slate-800 bg-[#0f172a] flex flex-col min-h-0">
      <header className="p-4 border-b border-slate-800 space-y-3">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 data-testid="text-order-visual-id" className="font-mono text-lg font-semibold text-white">#{head.visualId ?? "—"}</h2>
              {head.statusName && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">{head.statusName}</span>}
              <span className="text-[10px] uppercase tracking-wider text-slate-500">{head.orderType}</span>
            </div>
            <div className="text-sm text-slate-400 truncate">{head.customerName}{head.nickname ? ` · ${head.nickname}` : ""}</div>
          </div>
          <button data-testid="button-refresh-activity" disabled={loading || loadingMore} onClick={() => setReload(r => r + 1)} className="ml-auto flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-50">
            <RefreshCw size={13} /> Refresh
          </button>
          <button data-testid="button-line-item-history" onClick={() => setHistoryOpen(true)} className="flex items-center gap-1.5 rounded-md border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800">
            <ListTree size={13} /> Line-item history
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {CATEGORIES.map((c) => (
            <button key={c.id} data-testid={`button-category-${c.id}`} onClick={() => setCategory(c.id)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${category === c.id ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" : "border-slate-700 text-slate-400 hover:text-slate-100"}`}>
              {c.label}
            </button>
          ))}
          <div className="flex items-center gap-1.5 ml-auto text-xs text-slate-400">
            <input data-testid="input-start-date" type="date" value={start} max={end || undefined} onChange={(e) => setStart(e.target.value)} className="rounded bg-slate-900 border border-slate-700 px-2 py-1 text-slate-200 [color-scheme:dark]" />
            <span>to</span>
            <input data-testid="input-end-date" type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} className="rounded bg-slate-900 border border-slate-700 px-2 py-1 text-slate-200 [color-scheme:dark]" />
            {(start || end) && <button data-testid="button-clear-dates" onClick={() => { setStart(""); setEnd(""); }} className="text-emerald-400 hover:text-emerald-300">Clear</button>}
          </div>
        </div>
      </header>

      {coverage && (coverage.baselineObservedAt || coverage.notes.length > 0) && (
        <div data-testid="notice-coverage" className="mx-4 mt-4 rounded-md border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-100/80 flex gap-2">
          <Info size={14} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="space-y-1">
            {coverage.baselineObservedAt && <p>First retained line-item baseline: {fmtDate(coverage.baselineObservedAt, false)}. Line-item changes before then may be missing; other sources have their own coverage.</p>}
            {coverage.notes.map((n, i) => <p key={i}>{n}</p>)}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
        {loading ? (
          <div className="space-y-4">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="h-16 rounded-md bg-slate-800/50 animate-pulse" />)}</div>
        ) : error ? (
          <div className="py-12 text-center text-sm text-slate-400">
            <AlertTriangle className="mx-auto text-amber-400 mb-2" size={22} />
            {error}
            <button data-testid="button-retry-feed" onClick={() => setReload((r) => r + 1)} className="mt-3 mx-auto flex items-center gap-1.5 text-emerald-400 hover:text-emerald-300 text-xs font-semibold"><RefreshCw size={12} /> Retry</button>
          </div>
        ) : events.length === 0 ? (
          <div className="py-14 text-center">
            <History className="mx-auto text-slate-600" size={28} />
            <p className="mt-3 text-sm text-slate-300">No activity recorded{category !== "all" || start || end ? " for these filters" : ""}.</p>
            <p className="text-xs text-slate-500 mt-1">Try another category or widen the date range.</p>
          </div>
        ) : (
          <>
            {grouped.map((g) => (
              <div key={`${g.day}-${g.items[0]?.id}`} className="mb-2">
                <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-3">{g.day}</h3>
                <ol className="border-l border-slate-800 ml-1 pl-0">{g.items.map((e) => <EventRow key={e.id} e={e} />)}</ol>
              </div>
            ))}
            {cursor ? (
              <button data-testid="button-load-more" disabled={loadingMore} onClick={() => load(true)} className="w-full mt-2 rounded-md border border-slate-700 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-50">
                {loadingMore ? "Loading..." : "Load older activity"}
              </button>
            ) : (
              <p className="text-center text-[11px] text-slate-600 mt-2">Beginning of recorded history</p>
            )}
          </>
        )}
      </div>
      <OrderLineItemHistory orderId={order.id} visualId={head.visualId ?? null} open={historyOpen} onOpenChange={setHistoryOpen} />
    </section>
  );
}

export default function OrderActivityLog() {
  const [picked, setPicked] = useState<LogOrder | null>(null);
  return (
    <AppShell>
      <div className="p-4 md:p-6 flex flex-col gap-4 min-h-full lg:h-full">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-widest text-emerald-500">Reports</div>
            <h1 className="text-xl font-semibold text-white tracking-tight">Order Activity Log</h1>
            <p className="text-sm text-slate-400">Recorded order changes, payments, file milestones and print outcomes, newest first.</p>
          </div>
          <Link href="/orders" data-testid="link-reports" className="ml-auto flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-100">
            <FileSpreadsheet size={13} /> Back to Reports
          </Link>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 flex-1 min-h-0">
          <div className="lg:min-h-0 max-h-[60dvh] lg:max-h-none flex flex-col"><SearchPanel selectedId={picked?.id ?? null} onPick={setPicked} /></div>
          {picked ? <Feed key={picked.id} order={picked} /> : (
            <div className="rounded-xl border border-dashed border-slate-800 flex flex-col items-center justify-center p-10 text-center">
              <History className="text-slate-600" size={32} />
              <p className="mt-3 text-sm text-slate-300">Pick an order to see its timeline</p>
              <p className="text-xs text-slate-500 mt-1 max-w-sm">Status moves, line edits, payments, file milestones and print runs appear with where each record came from.</p>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
