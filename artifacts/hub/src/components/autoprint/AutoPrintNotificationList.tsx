import { useMemo, useState } from "react";
import { Link } from "wouter";
import { AlertTriangle, ArrowUpRight, Check, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { AutoPrintNotification } from "@workspace/api-client-react";
import { NOTIFICATION_PAGE_SIZE, apiErrorMessage, useAutoPrintNotificationList, useMarkNotificationRead } from "./useAutoPrintNotifications";

const KIND_LABEL: Record<AutoPrintNotification["kind"], string> = {
  failure: "Failure",
  manual_review: "Manual review",
  acceptance_unknown: "Acceptance unknown",
  run_failure: "Run failure",
};
const KIND_STYLE: Record<AutoPrintNotification["kind"], string> = {
  failure: "bg-red-500/15 text-red-300 border-red-500/30",
  manual_review: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  acceptance_unknown: "bg-orange-500/20 text-orange-200 border-orange-500/50",
  run_failure: "bg-red-500/15 text-red-300 border-red-500/30",
};

type KindFilter = "all" | AutoPrintNotification["kind"];
type ReadFilter = "all" | "unread" | "read";

const t = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "none scheduled");
const label = (s: string) => s.replaceAll("_", " ");

function NotificationItem({ n, onNavigate }: { n: AutoPrintNotification; onNavigate?: () => void }) {
  const mark = useMarkNotificationRead();
  const [err, setErr] = useState("");
  return (
    <article data-testid={`card-notification-${n.id}`} className={`rounded-lg border p-3 text-[12px] ${n.read ? "border-slate-800 bg-[#020617]" : "border-[#059669]/40 bg-[#059669]/5"}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {!n.read && <span className="h-2 w-2 rounded-full bg-[#10b981]" aria-label="Unread" />}
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${KIND_STYLE[n.kind]}`}>{KIND_LABEL[n.kind]}</span>
        <span className="text-slate-500">{n.documentType}</span>
        {n.visualId && <span className="text-slate-300">Invoice #{n.visualId}</span>}
        {n.poNumber && <span className="text-slate-300">PO {n.poNumber}</span>}
        <span className="ml-auto text-slate-500">{t(n.occurredAt)}</span>
      </div>
      <h3 className="mt-1.5 text-[13px] font-semibold text-slate-100">{n.title}</h3>
      <p className="mt-0.5 whitespace-pre-wrap text-slate-400">{n.reason}</p>
      {n.kind === "acceptance_unknown" && (
        <div role="alert" className="mt-2 flex gap-2 rounded border border-orange-500/50 bg-orange-500/10 p-2 text-orange-100">
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span><strong>This may already be printed.</strong> Verify in PrintNode AND at the physical printer before any resend.</span>
        </div>
      )}
      <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 rounded border border-slate-800 bg-slate-900/40 p-2 sm:grid-cols-2">
        <div><dt className="text-[10px] uppercase tracking-wide text-slate-500">At failure</dt><dd className="text-slate-300">{label(n.retryState)} · next attempt {t(n.nextAttemptAt)}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wide text-slate-500">Current</dt><dd className="text-slate-100">{label(n.currentState)} · next attempt {t(n.currentNextAttemptAt)}</dd></div>
      </dl>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Link href={n.href} onClick={onNavigate} data-testid={`link-notification-${n.id}`} className="inline-flex items-center gap-1 text-sky-300 underline underline-offset-2">
          {n.jobId ? "Open retry review" : "Open run history"} <ArrowUpRight size={12} />
        </Link>
        {!n.read && (
          <button type="button" disabled={mark.isPending} data-testid={`button-mark-read-${n.id}`}
            onClick={() => { setErr(""); mark.mutate({ id: n.id }, { onError: (e) => setErr(apiErrorMessage(e, "Could not mark as read. Try again.")) }); }}
            className="ml-auto inline-flex items-center gap-1 rounded border border-slate-700 px-2 py-1 text-slate-300 hover:border-slate-500 disabled:opacity-40">
            <Check size={12} /> {mark.isPending ? "Saving…" : "Mark read"}
          </button>
        )}
      </div>
      {err && <p role="alert" className="mt-1.5 text-red-300">{err}</p>}
    </article>
  );
}

export function AutoPrintNotificationList({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  const [offset, setOffset] = useState(0);
  const [kind, setKind] = useState<KindFilter>("all");
  const [read, setRead] = useState<ReadFilter>("all");
  const { admin, query, data } = useAutoPrintNotificationList(offset);
  const items = useMemo(() => (data?.items ?? []).filter((n) =>
    (kind === "all" || n.kind === kind) && (read === "all" || (read === "unread" ? !n.read : n.read))), [data, kind, read]);
  if (!admin) return null;
  const total = data?.total ?? 0;
  const ctl = "rounded bg-slate-800 border border-slate-700 px-2 py-1 text-[12px] text-slate-200";

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500">In-app only, admins only (no email). Marking read hides your unread marker; it does not resolve the print problem.</p>
      <p className="text-[11px] text-slate-500">Alerts begin after this version is published. Existing historical failures are not backfilled. Filters apply to the current page.</p>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="Filter by type" data-testid="select-notification-kind" value={kind} onChange={(e) => setKind(e.target.value as KindFilter)} className={ctl}>
          <option value="all">All types</option>
          {(Object.keys(KIND_LABEL) as AutoPrintNotification["kind"][]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
        <select aria-label="Filter by read state" data-testid="select-notification-read" value={read} onChange={(e) => setRead(e.target.value as ReadFilter)} className={ctl}>
          <option value="all">Read and unread</option><option value="unread">Unread</option><option value="read">Read</option>
        </select>
        {data && <span className="text-[11px] text-slate-500" data-testid="text-notification-unread">{data.unread} unread · {total} total</span>}
        <button type="button" onClick={() => query.refetch()} aria-label="Refresh notifications" data-testid="button-refresh-notifications" className="ml-auto rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100">
          <RefreshCw size={13} className={query.isFetching ? "animate-spin" : ""} />
        </button>
      </div>
      {query.isLoading && <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-slate-800/60" />)}</div>}
      {query.isError && (
        <div role="alert" className="rounded border border-red-500/30 bg-red-500/10 p-2 text-[12px] text-red-200">
          Could not load notifications: {apiErrorMessage(query.error, "request failed")}.{" "}
          <button type="button" onClick={() => query.refetch()} className="underline">Retry</button>
        </div>
      )}
      {data && items.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-800 p-4 text-center text-[12px] text-slate-500">
          {data.items.length === 0 ? "No AutoPrint notifications." : "No notifications on this page match the filters."}
        </p>
      )}
      <div className={`space-y-2 ${compact ? "max-h-[60dvh] overflow-y-auto custom-scrollbar pr-1" : ""}`}>
        {items.map((n) => <NotificationItem key={n.id} n={n} onNavigate={onNavigate} />)}
      </div>
      {data && total > NOTIFICATION_PAGE_SIZE && (
        <div className="flex items-center justify-between text-[12px] text-slate-400">
          <button type="button" data-testid="button-notifications-prev" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - NOTIFICATION_PAGE_SIZE))} className="inline-flex items-center gap-1 disabled:opacity-40"><ChevronLeft size={13} /> Newer</button>
          <span>{offset + 1}–{Math.min(offset + NOTIFICATION_PAGE_SIZE, total)} of {total}</span>
          <button type="button" data-testid="button-notifications-next" disabled={offset + NOTIFICATION_PAGE_SIZE >= total} onClick={() => setOffset(offset + NOTIFICATION_PAGE_SIZE)} className="inline-flex items-center gap-1 disabled:opacity-40">Older <ChevronRight size={13} /></button>
        </div>
      )}
    </div>
  );
}
