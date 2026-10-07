import { ReportDatePresets } from "@/components/ReportDatePresets";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  useListPrintavoStatuses,
  getListPrintavoStatusesQueryKey,
  useListPrintQueueOrders,
  getListPrintQueueOrdersQueryKey,
  getGetCombinedWorkordersHtmlUrl,
  getGetCombinedPackingSlipsHtmlUrl,
  getGetCombinedBoxLabelsHtmlUrl,
  useListPqStatusRules,
  getListPqStatusRulesQueryKey,
  useEvaluatePqRulesAndRun,
  useStartPqStatusJob,
  useGetPqStatusJob,
  getGetPqStatusJobQueryKey,
  type PrintQueueOrder,
  type PqStatusRule,
  type PqRuleMatchItem,
  type PqStatusJob,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  Printer,
  FileText,
  Package,
  Loader2,
  ChevronDown,
  ExternalLink,
  X,
  RefreshCw,
  Zap,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";

const STATUS_STORAGE_KEY = "printQueue.statusIds";
const EXCLUDE_ATTACHMENTS_KEY = "printQueue.excludeAttachments";
const MAX_PRINT_BATCH = 50;

/** Quick status presets carried over from the original bulk-print app. */
const PRESETS: { label: string; statusNames: string[] }[] = [
  {
    label: "Sepsy Purchasing",
    statusNames: [
      "Seps.io -  👕➗🧢 PARTIALLY ORDERED",
      "Seps.io - 👕🧢 ORDERED",
    ],
  },
  {
    label: "Merch",
    statusNames: [
      "👕🧢 MERCH - PRINT Waiting 4 Blanks",
      "👕🧢 MERCH - EMB Waiting 4 Blanks",
      "👕🧢 MERCH - HEAT Waiting 4 Blanks",
      "👕🧢 MERCH - MIXED DECO Waiting 4 Blanks",
      "MERCH -B/O Waiting 4 Blanks",
    ],
  },
];

/** Whitespace-insensitive compare — status names have stray double spaces. */
function normName(name: string): string {
  return name.replace(/\s+/g, " ").trim();
}

function loadExcludeAttachments(): boolean {
  try {
    const raw = localStorage.getItem(EXCLUDE_ATTACHMENTS_KEY);
    return raw == null ? true : raw === "true";
  } catch {
    return true;
  }
}

function loadSavedStatusIds(): string[] {
  try {
    const raw = localStorage.getItem(STATUS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fmtMoney(total: string | null): string {
  if (total == null) return "—";
  const n = Number(total);
  if (Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function printavoDocUrl(printavoId: string, doc: "packing_slip" | "box_labels"): string {
  return `https://www.printavo.com/invoices/${printavoId}/${doc}`;
}

function apiError(err: unknown): string | undefined {
  return err && typeof err === "object" && "data" in err
    ? (err as { data?: { error?: string } }).data?.error
    : undefined;
}

/* ── Bulk status change dialog ───────────────────────────────────────── */

function BulkStatusDialog({
  orders,
  statuses,
  ruleChips,
  pending,
  onApply,
  onClose,
}: {
  orders: PrintQueueOrder[];
  statuses: { id: string; name: string; color?: string | null }[];
  ruleChips: PqStatusRule[];
  pending: boolean;
  onApply: (targetStatusId: string) => void;
  onClose: () => void;
}) {
  const [target, setTarget] = useState("");
  const targetName = statuses.find((s) => s.id === target)?.name;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-lg bg-[#0f172a] border border-slate-700 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white">
            Change status — {orders.length} order{orders.length === 1 ? "" : "s"}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white" data-testid="button-close-bulk-dialog">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4 space-y-4 overflow-y-auto custom-scrollbar">
          {ruleChips.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500 mb-1.5">
                Quick picks (from Queue Rules)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ruleChips.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => setTarget(r.targetStatusId!)}
                    className={`px-2.5 py-1.5 rounded-md border text-[12px] transition-colors ${
                      target === r.targetStatusId
                        ? "border-[#059669] bg-[#059669]/10 text-[#10b981]"
                        : "border-slate-700 text-slate-300 hover:border-slate-500"
                    }`}
                    data-testid={`chip-rule-${r.id}`}
                  >
                    {r.name ?? r.targetStatusName}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="flex flex-col gap-1.5 text-[11px] uppercase tracking-wider text-slate-500">
            Move to Printavo status
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="bg-slate-800 border border-slate-700 text-slate-200 text-[13px] rounded-lg px-2.5 py-2 focus:outline-none focus:border-[#059669] normal-case tracking-normal"
              data-testid="select-bulk-target"
            >
              <option value="">— pick a status —</option>
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="max-h-44 overflow-y-auto custom-scrollbar rounded-md border border-slate-800 divide-y divide-slate-800/60">
            {orders.map((o) => (
              <div key={o.printavoId} className="px-3 py-1.5 text-[12px] flex items-center gap-2">
                <span className="font-semibold text-slate-200">#{o.visualId}</span>
                <span className="truncate text-slate-400 flex-1">{o.nickname ?? ""}</span>
                <span className="text-slate-500 truncate max-w-[160px]">{o.statusName ?? "—"}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="px-5 py-4 border-t border-slate-800 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-md border border-slate-700 text-[13px] text-slate-300 hover:border-slate-500 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => target && onApply(target)}
            disabled={!target || pending}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-[#059669] text-white text-[13px] font-semibold hover:bg-[#047857] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="button-apply-bulk-status"
          >
            {pending && <Loader2 size={13} className="animate-spin" />}
            Move {orders.length} to {targetName ?? "…"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Post-print "ask first" confirmation panel ───────────────────────── */

function AskPanel({
  items,
  pending,
  jobRunning,
  onApply,
  onClose,
}: {
  items: PqRuleMatchItem[];
  pending: boolean;
  jobRunning: boolean;
  onApply: (chosen: PqRuleMatchItem[]) => void;
  onClose: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(items.map((i) => i.orderId)),
  );
  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const chosen = items.filter((i) => checked.has(i.orderId));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-xl max-h-[80vh] flex flex-col rounded-lg bg-[#0f172a] border border-slate-700 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <Zap size={15} className="text-[#10b981]" /> Move printed orders?
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white" data-testid="button-close-ask-panel">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-3 text-[12px] text-slate-400 border-b border-slate-800">
          Your Queue Rules matched these printed orders. Uncheck any you want to
          leave alone, then apply.
        </div>
        <div className="flex-1 overflow-y-auto custom-scrollbar divide-y divide-slate-800/60">
          {items.map((i) => (
            <label
              key={i.orderId}
              className="flex items-center gap-2.5 px-5 py-2.5 text-[13px] hover:bg-slate-800/50 cursor-pointer"
            >
              <input
                type="checkbox"
                checked={checked.has(i.orderId)}
                onChange={() => toggle(i.orderId)}
                className="accent-[#059669]"
                data-testid={`checkbox-ask-${i.visualId ?? i.orderId}`}
              />
              <span className="font-semibold text-slate-200">
                #{i.visualId ?? "?"}
              </span>
              <span className="truncate text-slate-400 flex-1">{i.nickname ?? ""}</span>
              <span className="text-slate-500 truncate max-w-[140px]">
                {i.fromStatusName ?? "—"}
              </span>
              <span className="text-slate-500">→</span>
              <span className="px-1.5 py-0.5 rounded text-[11px] font-semibold bg-[#059669]/10 border border-[#059669]/25 text-[#10b981] truncate max-w-[160px]">
                {i.targetStatusName}
              </span>
            </label>
          ))}
        </div>
        <div className="px-5 py-4 border-t border-slate-800 flex items-center justify-end gap-2">
          {jobRunning && (
            <span className="mr-auto text-[11px] text-slate-500">
              Waiting for the current job to finish…
            </span>
          )}
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-md border border-slate-700 text-[13px] text-slate-300 hover:border-slate-500 transition-colors"
            data-testid="button-skip-ask"
          >
            Don't move anything
          </button>
          <button
            onClick={() => onApply(chosen)}
            disabled={chosen.length === 0 || pending || jobRunning}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-[#059669] text-white text-[13px] font-semibold hover:bg-[#047857] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="button-apply-ask"
          >
            {pending && <Loader2 size={13} className="animate-spin" />}
            Move {chosen.length} order{chosen.length === 1 ? "" : "s"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Status job progress card ────────────────────────────────────────── */

function jobCounts(job: PqStatusJob) {
  const c = { done: 0, failed: 0, stale: 0, skipped: 0, pending: 0 };
  for (const l of job.lines) c[l.status] = (c[l.status] ?? 0) + 1;
  return c;
}

function JobProgressCard({ job, onDismiss }: { job: PqStatusJob; onDismiss: () => void }) {
  const c = jobCounts(job);
  const total = job.lines.length;
  const processed = total - c.pending;
  const running = job.status === "running";
  const clean = job.status === "success" && c.failed === 0 && c.stale === 0;

  return (
    <div
      className="fixed bottom-4 right-4 z-40 w-80 rounded-lg bg-[#0f172a] border border-slate-700 shadow-2xl"
      data-testid="card-job-progress"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
        <div className="flex items-center gap-2 text-[13px] font-semibold text-white">
          {running ? (
            <Loader2 size={14} className="animate-spin text-[#10b981]" />
          ) : clean ? (
            <CheckCircle2 size={14} className="text-[#10b981]" />
          ) : (
            <AlertTriangle size={14} className="text-amber-400" />
          )}
          {running
            ? `Moving orders… ${processed}/${total}`
            : job.status === "interrupted"
              ? "Status change interrupted"
              : clean
                ? "Status change complete"
                : "Status change finished"}
        </div>
        {!running && (
          <button onClick={onDismiss} className="text-slate-400 hover:text-white" data-testid="button-dismiss-job">
            <X size={14} />
          </button>
        )}
      </div>
      <div className="px-4 py-3 text-[12px] text-slate-400 space-y-1">
        <div>
          {c.done} moved
          {c.failed > 0 && <span className="text-red-400"> · {c.failed} failed</span>}
          {c.stale > 0 && (
            <span className="text-amber-400"> · {c.stale} skipped (status changed since)</span>
          )}
          {c.skipped > 0 && <span> · {c.skipped} already there</span>}
          {running && c.pending > 0 && <span> · {c.pending} to go</span>}
        </div>
        {job.status === "interrupted" && (
          <div className="text-amber-400">
            The server restarted mid-run — unfinished orders were not changed.
          </div>
        )}
        {(c.failed > 0 || c.stale > 0) && (
          <div className="max-h-28 overflow-y-auto custom-scrollbar space-y-0.5 pt-1">
            {job.lines
              .filter((l) => l.status === "failed" || l.status === "stale")
              .map((l) => (
                <div key={l.orderId} className="text-[11px]">
                  <span className="font-semibold text-slate-300">#{l.visualId ?? "?"}</span>{" "}
                  <span className={l.status === "failed" ? "text-red-400" : "text-amber-400"}>
                    {l.status === "failed" ? (l.error ?? "failed") : "moved by someone else"}
                  </span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Status multi-select ─────────────────────────────────────────────── */

function StatusPicker({
  statuses,
  selected,
  onChange,
}: {
  statuses: { id: string; name: string; color?: string | null }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return statuses;
    return statuses.filter((s) => s.name.toLowerCase().includes(q));
  }, [statuses, search]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => {
          setOpen((v) => !v);
          setSearch("");
        }}
        className="flex items-center gap-2 px-3 py-2 rounded-md bg-[#0f172a] border border-slate-700 text-[13px] text-slate-200 hover:border-slate-500 transition-colors"
        data-testid="button-status-picker"
      >
        <span>
          {selected.length === 0
            ? "Select statuses…"
            : `${selected.length} status${selected.length === 1 ? "" : "es"} selected`}
        </span>
        <ChevronDown size={14} className="text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-80 rounded-md bg-[#0f172a] border border-slate-700 shadow-xl">
          <div className="p-2 border-b border-slate-800">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search statuses…"
              className="w-full px-2.5 py-1.5 rounded bg-[#020617] border border-slate-700 text-[13px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-[#059669]"
              data-testid="input-status-search"
            />
          </div>
          <div className="max-h-72 overflow-y-auto custom-scrollbar">
            {visible.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12px] text-slate-500">
                No statuses match.
              </div>
            ) : (
              visible.map((s) => (
                <label
                  key={s.id}
                  className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-slate-200 hover:bg-slate-800 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(s.id)}
                    onChange={() => toggle(s.id)}
                    className="accent-[#059669]"
                    data-testid={`checkbox-status-${s.id}`}
                  />
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: s.color || "#475569" }}
                  />
                  <span className="truncate">{s.name}</span>
                </label>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Packing slip / box label launcher ───────────────────────────────── */

function DocLinksDialog({
  title,
  doc,
  orders,
  skippedQuotes,
  onClose,
}: {
  title: string;
  doc: "packing_slip" | "box_labels";
  orders: PrintQueueOrder[];
  skippedQuotes: number;
  onClose: () => void;
}) {
  const [popupsBlocked, setPopupsBlocked] = useState(false);

  const printCombined = () => {
    const ids = orders.map((o) => o.printavoId).join(",");
    const url =
      doc === "packing_slip"
        ? getGetCombinedPackingSlipsHtmlUrl({ ids })
        : getGetCombinedBoxLabelsHtmlUrl({ ids });
    // Synchronous window.open on click — popup-blocker-safe.
    const w = window.open(url, "_blank");
    if (!w) setPopupsBlocked(true);
  };

  const openAll = () => {
    let opened = 0;
    for (const o of orders) {
      const w = window.open(printavoDocUrl(o.printavoId, doc), "_blank");
      if (w) opened++;
    }
    setPopupsBlocked(opened < orders.length);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md max-h-[80vh] flex flex-col rounded-lg bg-[#0f172a] border border-slate-700 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-white" data-testid="button-close-doc-dialog">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-3 text-[12px] text-slate-400 border-b border-slate-800">
          One combined document rendered from your synced data — no Printavo
          login needed. Page break between orders.
          {skippedQuotes > 0 && (
            <span className="text-amber-400">
              {" "}
              {skippedQuotes} quote{skippedQuotes === 1 ? "" : "s"} skipped (invoices only).
            </span>
          )}
        </div>
        {orders.length > 0 && (
          <div className="px-5 py-3 border-b border-slate-800">
            <button
              onClick={printCombined}
              className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-[#059669] text-white text-[13px] font-semibold hover:bg-[#047857] transition-colors"
              data-testid="button-print-combined-docs"
            >
              <Printer size={13} /> Print Combined ({orders.length})
            </button>
            <button
              onClick={openAll}
              className="mt-2 w-full flex items-center justify-center gap-2 px-4 py-2 rounded-md border border-slate-700 text-slate-300 text-[13px] font-medium hover:bg-slate-800 transition-colors"
              data-testid="button-open-all-docs"
            >
              <ExternalLink size={13} /> Open in Printavo instead ({orders.length})
            </button>
            {popupsBlocked && (
              <p className="mt-2 text-[12px] text-amber-400">
                Pop-ups blocked — allow pop-ups for this site in your browser's address
                bar, then try again. Or use the links below.
              </p>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto custom-scrollbar px-3 py-2">
          {orders.length === 0 ? (
            <div className="px-2 py-6 text-center text-[13px] text-slate-500">
              No invoices in the selection.
            </div>
          ) : (
            orders.map((o) => (
              <a
                key={o.printavoId}
                href={printavoDocUrl(o.printavoId, doc)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2.5 px-2 py-2 rounded-md text-[13px] text-slate-200 hover:bg-slate-800 transition-colors"
                data-testid={`link-doc-${o.visualId}`}
              >
                <ExternalLink size={13} className="text-[#10b981] flex-shrink-0" />
                <span className="font-semibold">#{o.visualId}</span>
                <span className="truncate text-slate-400">{o.nickname ?? ""}</span>
              </a>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────────────── */

export default function PrintQueue() {
  const { toast } = useToast();
  const [statusIds, setStatusIds] = useState<string[]>(loadSavedStatusIds);
  const [dateFilter, setDateFilter] = useState("");
  const [dateRange, setDateRange] = useState<{ start: string; end: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [docDialog, setDocDialog] = useState<"packing_slip" | "box_labels" | null>(null);
  const [excludeAttachments, setExcludeAttachments] = useState<boolean>(loadExcludeAttachments);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [askItems, setAskItems] = useState<PqRuleMatchItem[] | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(STATUS_STORAGE_KEY, JSON.stringify(statusIds));
  }, [statusIds]);

  useEffect(() => {
    localStorage.setItem(EXCLUDE_ATTACHMENTS_KEY, String(excludeAttachments));
  }, [excludeAttachments]);

  const { data: statusData } = useListPrintavoStatuses({
    query: { queryKey: getListPrintavoStatusesQueryKey(), staleTime: 5 * 60_000 },
  });
  const statuses = statusData?.statuses ?? [];
  const statusColor = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of statuses) if (s.color) m.set(s.id, s.color);
    return m;
  }, [statuses]);

  const params = { statusIds: statusIds.join(",") };
  const {
    data: orderData,
    isFetching,
    refetch,
  } = useListPrintQueueOrders(params, {
    query: {
      queryKey: getListPrintQueueOrdersQueryKey(params),
      enabled: statusIds.length > 0,
    },
  });
  const orders = useMemo(
    () => (statusIds.length > 0 ? (orderData?.orders ?? []) : []),
    [orderData, statusIds.length],
  );

  const filtered = useMemo(() => {
    if (dateRange) return orders.filter(o => {
      // Printavo due dates are calendar dates stored at UTC midnight.
      const day = o.productionDueAt?.slice(0, 10);
      return day && day >= dateRange.start && day <= dateRange.end;
    });
    const f = dateFilter.trim().toLowerCase();
    if (!f) return orders;
    return orders.filter((o) => fmtDate(o.productionDueAt).toLowerCase().includes(f));
  }, [orders, dateFilter, dateRange]);

  // Drop selections that fell out of the current result set.
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(orders.map((o) => o.printavoId));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [orders]);

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((o) => selected.has(o.printavoId));

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) filtered.forEach((o) => next.delete(o.printavoId));
      else filtered.forEach((o) => next.add(o.printavoId));
      return next;
    });
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedOrders = useMemo(
    () => orders.filter((o) => selected.has(o.printavoId)),
    [orders, selected],
  );
  const selectedInvoices = useMemo(
    () => selectedOrders.filter((o) => o.orderType === "invoice"),
    [selectedOrders],
  );

  /* — Queue Rules integration (PQ2) — */

  const { data: rulesData } = useListPqStatusRules({
    query: { queryKey: getListPqStatusRulesQueryKey(), staleTime: 60_000 },
  });
  const ruleChips = useMemo(
    () => (rulesData?.rules ?? []).filter((r) => r.enabled && r.targetStatusId),
    [rulesData],
  );

  const startJob = useStartPqStatusJob({
    mutation: {
      onSuccess: (job) => {
        setActiveJobId(job.id);
        setBulkOpen(false);
        setAskItems(null);
        setSelected(new Set());
      },
      onError: (err) => {
        toast({
          title: "Could not start status change",
          description: apiError(err) ?? "Start failed",
          variant: "destructive",
        });
      },
    },
  });

  const evaluateRun = useEvaluatePqRulesAndRun({
    mutation: {
      onSuccess: (res) => {
        if (!res.automationEnabled) {
          const hasLiveRules = (rulesData?.rules ?? []).some(
            (r) => r.enabled && (r.mode === "ask" || r.mode === "auto"),
          );
          if (hasLiveRules) {
            toast({
              title: "Queue Rules didn't run — automation is off",
              description:
                "Turn on the master switch on the Queue Rules page to get post-print prompts.",
            });
          }
          return;
        }
        if (res.autoJobId) {
          setActiveJobId(res.autoJobId);
          toast({
            title: `Moving ${res.autoCount} order${res.autoCount === 1 ? "" : "s"} automatically`,
            description: "Progress shows in the corner card.",
          });
        }
        if (res.askItems.length > 0) setAskItems(res.askItems);
      },
      onError: () => {
        toast({
          title: "Status rules could not run",
          description: "The workorders printed fine, but the post-print rule check failed.",
          variant: "destructive",
        });
      },
    },
  });

  // Poll the active job while it runs; refresh the order list when it ends.
  const { data: jobData } = useGetPqStatusJob(activeJobId ?? "", {
    query: {
      queryKey: getGetPqStatusJobQueryKey(activeJobId ?? ""),
      enabled: activeJobId != null,
      refetchInterval: (query) =>
        query.state.data?.status === "running" ? 1500 : false,
    },
  });
  const refreshedJobRef = useRef<string | null>(null);
  useEffect(() => {
    if (!jobData || jobData.status === "running") return;
    if (refreshedJobRef.current === jobData.id) return;
    refreshedJobRef.current = jobData.id;
    if (statusIds.length > 0) refetch();
  }, [jobData, statusIds.length, refetch]);

  const startBulkChange = (targetStatusId: string) => {
    if (startJob.isPending) return;
    startJob.mutate({
      data: {
        trigger: "manual",
        lines: selectedOrders.map((o) => ({
          orderId: o.printavoId,
          targetStatusId,
          // Stale guard — skip the line if the order moved since this screen loaded.
          expectedStatusId: o.statusId ?? null,
        })),
      },
    });
  };

  const applyAskItems = (chosen: PqRuleMatchItem[]) => {
    if (startJob.isPending || chosen.length === 0) return;
    startJob.mutate({
      data: {
        trigger: "ask",
        lines: chosen.map((i) => ({
          orderId: i.orderId,
          targetStatusId: i.targetStatusId,
          expectedStatusId: i.fromStatusId,
        })),
      },
    });
  };

  const printWorkorders = (source: PrintQueueOrder[]) => {
    const withWo = source.filter((o) => o.hasWorkorder);
    const skipped = source.length - withWo.length;
    if (withWo.length === 0) {
      toast({
        title: "Nothing to print",
        description: "None of these orders have a workorder page.",
        variant: "destructive",
      });
      return;
    }
    if (withWo.length > MAX_PRINT_BATCH) {
      toast({
        title: "Too many orders",
        description: `Print at most ${MAX_PRINT_BATCH} workorders per batch.`,
        variant: "destructive",
      });
      return;
    }
    const url = getGetCombinedWorkordersHtmlUrl({
      ids: withWo.map((o) => o.printavoId).join(","),
      ...(excludeAttachments ? { excludeAttachments: true } : {}),
    });
    // Synchronous window.open on click — popup-blocker-safe.
    window.open(url, "_blank");
    if (skipped > 0) {
      toast({
        title: `${skipped} order${skipped === 1 ? "" : "s"} skipped`,
        description: "They have no workorder page in Printavo.",
      });
    }
    // Post-print hook: evaluate Queue Rules for what was printed. The server
    // enforces the automation kill switch — when off this is a cheap no-op.
    evaluateRun.mutate({ data: { orderIds: withWo.map((o) => o.printavoId) } });
  };

  const applyPreset = (preset: (typeof PRESETS)[number]) => {
    const wanted = new Set(preset.statusNames.map(normName));
    const ids = statuses.filter((s) => wanted.has(normName(s.name))).map((s) => s.id);
    if (ids.length === 0) {
      toast({
        title: "No matching statuses",
        description: `None of the "${preset.label}" statuses exist in Printavo anymore.`,
        variant: "destructive",
      });
      return;
    }
    setStatusIds(ids);
    setSelected(new Set());
    if (ids.length < preset.statusNames.length) {
      toast({
        title: `${preset.statusNames.length - ids.length} status(es) not found`,
        description: "They may have been renamed in Printavo.",
      });
    }
  };

  const selectedStatuses = useMemo(
    () =>
      statusIds
        .map((id) => statuses.find((s) => s.id === id))
        .filter((s): s is (typeof statuses)[number] => s != null),
    [statusIds, statuses],
  );

  return (
    <AppShell>
      <div className="p-6 max-w-[1400px] mx-auto">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-lg font-semibold text-white flex items-center gap-2">
              <Printer size={18} className="text-[#10b981]" /> Print Queue
            </h1>
            <p className="text-[12px] text-slate-400 mt-0.5">
              Pick statuses, select orders, then print workorders or open packing
              slips &amp; box labels.
            </p>
          </div>
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 mb-3">
          <StatusPicker statuses={statuses} selected={statusIds} onChange={setStatusIds} />
          <span className="text-[11px] uppercase tracking-wider text-slate-500">Presets:</span>
          {PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p)}
              className="px-2.5 py-1.5 rounded-md border border-slate-700 text-[12px] text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
              data-testid={`button-preset-${p.label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {p.label}
            </button>
          ))}
          <input
            value={dateFilter}
            onChange={(e) => { setDateFilter(e.target.value); setDateRange(null); }}
            placeholder="Filter by production date…"
            className="px-3 py-2 rounded-md bg-[#0f172a] border border-slate-700 text-[13px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-[#059669] w-56"
            data-testid="input-date-filter"
          />
          <ReportDatePresets onChange={r => { setDateRange(r); setDateFilter(""); }} />
          {dateRange && <span className="text-xs text-slate-300">{dateRange.start} through {dateRange.end} <button type="button" className="text-emerald-300 underline" onClick={() => setDateRange(null)}>Clear dates</button></span>}
          <button
            onClick={() => refetch()}
            disabled={statusIds.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-700 text-[13px] text-slate-300 hover:text-white hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="button-refresh"
          >
            {isFetching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Refresh
          </button>
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-[12px] text-slate-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={excludeAttachments}
              onChange={(e) => setExcludeAttachments(e.target.checked)}
              className="accent-[#059669]"
              data-testid="checkbox-exclude-attachments"
            />
            Exclude attachments
          </label>
          <button
            onClick={() => printWorkorders(selectedOrders)}
            disabled={selected.size === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-md bg-[#059669] text-white text-[13px] font-semibold hover:bg-[#047857] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="button-print-workorders"
          >
            <Printer size={14} /> Print Workorders ({selected.size})
          </button>
          <button
            onClick={() => printWorkorders(filtered)}
            disabled={filtered.length === 0}
            className="flex items-center gap-2 px-3 py-2 rounded-md border border-slate-700 text-[13px] text-slate-200 hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="button-print-all-workorders"
          >
            <Printer size={14} /> Print All ({filtered.filter((o) => o.hasWorkorder).length})
          </button>
          <button
            onClick={() => setDocDialog("packing_slip")}
            disabled={selected.size === 0}
            className="flex items-center gap-2 px-3 py-2 rounded-md border border-slate-700 text-[13px] text-slate-200 hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="button-packing-slips"
          >
            <FileText size={14} /> Packing Slips
          </button>
          <button
            onClick={() => setDocDialog("box_labels")}
            disabled={selected.size === 0}
            className="flex items-center gap-2 px-3 py-2 rounded-md border border-slate-700 text-[13px] text-slate-200 hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="button-box-labels"
          >
            <Package size={14} /> Box Labels
          </button>
          <button
            onClick={() => setBulkOpen(true)}
            disabled={selected.size === 0 || startJob.isPending}
            className="flex items-center gap-2 px-3 py-2 rounded-md border border-slate-700 text-[13px] text-slate-200 hover:border-slate-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            data-testid="button-change-status"
          >
            <Zap size={14} /> Change Status
          </button>
        </div>

        {/* Selected status badges */}
        {selectedStatuses.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-4" data-testid="selected-statuses-list">
            {selectedStatuses.map((s) => (
              <button
                key={s.id}
                onClick={() => setStatusIds(statusIds.filter((id) => id !== s.id))}
                className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-full bg-slate-800 border border-slate-700 text-[12px] text-slate-200 hover:border-slate-500 transition-colors"
                title="Remove status"
                data-testid={`badge-status-${s.id}`}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: s.color || "#475569" }}
                />
                <span className="max-w-[220px] truncate">{s.name}</span>
                <X size={11} className="text-slate-400" />
              </button>
            ))}
            {selectedStatuses.length > 1 && (
              <button
                onClick={() => setStatusIds([])}
                className="px-2 py-1 text-[12px] text-slate-500 hover:text-slate-300 transition-colors"
                data-testid="button-clear-statuses"
              >
                Clear all
              </button>
            )}
          </div>
        )}

        {/* Table */}
        <div className="rounded-lg bg-[#0f172a] border border-slate-800 overflow-hidden">
          {statusIds.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-slate-500">
              Select one or more Printavo statuses to load orders.
            </div>
          ) : isFetching && !orderData ? (
            <div className="py-16 flex items-center justify-center gap-2 text-[13px] text-slate-400">
              <Loader2 size={15} className="animate-spin" /> Loading orders…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-[13px] text-slate-500">
              No orders in the selected statuses
              {dateFilter.trim() || dateRange ? " matching that date filter" : ""}.
            </div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-2.5 w-10">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAll}
                      className="accent-[#059669]"
                      data-testid="checkbox-select-all"
                    />
                  </th>
                  <th className="px-3 py-2.5">Order</th>
                  <th className="px-3 py-2.5">Nickname</th>
                  <th className="px-3 py-2.5">Customer</th>
                  <th className="px-3 py-2.5 text-right">Qty</th>
                  <th className="px-3 py-2.5 text-right">Total</th>
                  <th className="px-3 py-2.5">Production due</th>
                  <th className="px-3 py-2.5">Customer due</th>
                  <th className="px-3 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o) => (
                  <tr
                    key={o.printavoId}
                    className={`border-b border-slate-800/60 last:border-0 hover:bg-slate-800/40 cursor-pointer transition-colors ${
                      selected.has(o.printavoId) ? "bg-[#059669]/5" : ""
                    }`}
                    onClick={() => toggleOne(o.printavoId)}
                    data-testid={`row-order-${o.visualId}`}
                  >
                    <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selected.has(o.printavoId)}
                        onChange={() => toggleOne(o.printavoId)}
                        className="accent-[#059669]"
                        data-testid={`checkbox-order-${o.visualId}`}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="font-semibold text-white">#{o.visualId}</span>
                      {o.orderType === "quote" && (
                        <span className="ml-1.5 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                          Quote
                        </span>
                      )}
                      {!o.hasWorkorder && (
                        <span className="ml-1.5 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">
                          No WO
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-slate-300 max-w-[240px] truncate">
                      {o.nickname ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-slate-300 max-w-[200px] truncate">
                      {o.customerCompany ?? o.contactName ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-300">
                      {o.quantity ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-300">
                      {fmtMoney(o.total)}
                    </td>
                    <td className="px-3 py-2.5 text-slate-300">{fmtDate(o.productionDueAt)}</td>
                    <td className="px-3 py-2.5 text-slate-300">{fmtDate(o.customerDueAt)}</td>
                    <td className="px-3 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                          style={{
                            backgroundColor:
                              (o.statusId && statusColor.get(o.statusId)) || "#475569",
                          }}
                        />
                        <span className="text-slate-300">{o.statusName ?? "—"}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {statusIds.length > 0 && filtered.length > 0 && (
          <div className="mt-2 text-[12px] text-slate-500">
            {filtered.length} order{filtered.length === 1 ? "" : "s"}
            {dateFilter.trim() || dateRange ? ` (filtered from ${orders.length})` : ""} · {selected.size}{" "}
            selected
          </div>
        )}
      </div>

      {docDialog && (
        <DocLinksDialog
          title={docDialog === "packing_slip" ? "Packing Slips" : "Box Labels"}
          doc={docDialog}
          orders={selectedInvoices}
          skippedQuotes={selectedOrders.length - selectedInvoices.length}
          onClose={() => setDocDialog(null)}
        />
      )}

      {bulkOpen && selectedOrders.length > 0 && (
        <BulkStatusDialog
          orders={selectedOrders}
          statuses={statuses}
          ruleChips={ruleChips}
          pending={startJob.isPending}
          onApply={startBulkChange}
          onClose={() => setBulkOpen(false)}
        />
      )}

      {askItems && askItems.length > 0 && (
        <AskPanel
          key={askItems.map((i) => i.orderId).join(",")}
          items={askItems}
          pending={startJob.isPending}
          jobRunning={jobData?.status === "running"}
          onApply={applyAskItems}
          onClose={() => setAskItems(null)}
        />
      )}

      {activeJobId && jobData && (
        <JobProgressCard job={jobData} onDismiss={() => setActiveJobId(null)} />
      )}
    </AppShell>
  );
}
