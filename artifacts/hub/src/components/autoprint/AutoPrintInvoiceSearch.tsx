import { useState } from "react";
import { Link } from "wouter";
import { useInfiniteQuery } from "@tanstack/react-query";
import { searchAutoPrintInvoice, getSearchAutoPrintInvoiceQueryKey } from "@workspace/api-client-react";
import { jobReasonLabel } from "@/pages/autoPrintHistoryHelpers";
import { settingsHref } from "@/pages/settingsNavigation";

const labels: Record<string, string> = {
  printed: "Success · accepted by PrintNode", failed: "Failed", retry_pending: "Pending retry",
  held: "Needs review · held", exhausted: "Failed · retries exhausted",
  submission_unknown: "Needs review · submission unknown", pending: "Pending · verify before resending",
  review_required: "Needs review", blocked: "Blocked · needs review",
  updated: "Correction successful", noop: "No changes needed", ready: "Preview · not applied",
  candidate: "Not yet reviewed", applying: "Correction in progress", status_queued: "Status change queued",
  recovery_started: "Continued in a newer correction", cancelled: "Cancelled", skipped: "Skipped",
  dry_run: "Dry run · not printed",
};
const button = "rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 disabled:opacity-50";
const time = (v: string) => new Date(v).toLocaleString("en-US", {
  timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
});

export function AutoPrintInvoiceSearch() {
  const [input, setInput] = useState("");
  const [invoice, setInvoice] = useState("");
  const [error, setError] = useState("");
  const history = useInfiniteQuery({
    queryKey: [...getSearchAutoPrintInvoiceQueryKey({ invoice }), "pages"],
    enabled: !!invoice,
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => searchAutoPrintInvoice({ invoice, offset: pageParam }, { signal }),
    getNextPageParam: (last, pages) => last.hasMore ? pages.length * 50 : undefined,
    refetchInterval: invoice ? 15000 : false,
  });
  const items = history.data?.pages.flatMap(p => p.items) ?? [];
  return <section aria-labelledby="invoice-search-title" className="rounded-xl border border-slate-700 bg-slate-900/50 p-4 space-y-3">
    <h2 id="invoice-search-title" className="text-sm font-semibold text-slate-100">Find an invoice in AutoPrint</h2>
    <p className="text-xs text-slate-400">Search all saved print, retry, and status/category correction records. Newest activity appears first; older failures remain visible as history.</p>
    <form className="flex flex-wrap gap-2" onSubmit={e => {
      e.preventDefault();
      const value = input.trim().replace(/^#/, "");
      if (!/^\d{1,12}$/.test(value)) { setError("Enter a complete invoice number, such as 23343."); return; }
      setError("");
      if (value === invoice) void history.refetch();
      else setInvoice(value);
    }}>
      <input aria-label="Invoice number to search across AutoPrint" inputMode="numeric" placeholder="Invoice number, e.g. 23343"
        className="min-w-0 flex-1 rounded-lg border border-slate-600 bg-slate-950 px-3 py-2 text-sm text-slate-100"
        value={input} onChange={e => setInput(e.target.value)} />
      <button className={button} type="submit">Search</button>
      {invoice && <button className={button} type="button" onClick={() => { setInvoice(""); setInput(""); setError(""); }}>Clear</button>}
    </form>
    {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
    {invoice && <div className="space-y-3">
      <p className="text-sm text-slate-200" role="status">Invoice #{invoice}{history.isFetching ? " · Searching…" : ` · ${items.length} records loaded`}</p>
      {history.isError && <p role="alert" className="text-sm text-red-300">Could not search AutoPrint history. <button className="underline" onClick={() => history.refetch()}>Try again</button></p>}
      {!history.isPending && !history.isError && !items.length && <p className="text-sm text-slate-400">No saved AutoPrint records for this invoice. Older unrecorded skips cannot be searched.</p>}
      <div className="max-h-[36rem] overflow-y-auto space-y-2">
        {items.map(item => {
          const correction = item.kind === "status_category_correction";
          const review = ["failed", "held", "exhausted", "submission_unknown", "blocked", "review_required"].includes(item.status);
          return <article key={item.id} className="rounded-lg border border-slate-700 bg-slate-950 p-3 text-xs space-y-2">
            <div className="flex flex-wrap justify-between gap-2">
              <strong className={review ? "text-amber-300" : ["printed", "updated"].includes(item.status) ? "text-emerald-300" : "text-sky-300"}>{labels[item.status] ?? item.status}</strong>
              <time dateTime={item.occurredAt} className="text-slate-400">{item.dateLabel}: {time(item.occurredAt)}</time>
            </div>
            <p className="text-slate-300">{correction ? "Status/category correction" : item.kind.replaceAll("_", " ")} · {item.nickname}</p>
            {item.message && <p className="text-slate-400 whitespace-pre-wrap">{correction ? item.message : jobReasonLabel(item.message)}</p>}
            <Link className="text-sky-300 underline" href={`${settingsHref("auto-print", `run=${encodeURIComponent(item.runId)}`)}#autoprint-run-history`}>Open run &amp; correction history</Link>
            {!correction && item.kind === "workorder" && ["retry_pending", "held", "exhausted", "submission_unknown", "failed"].includes(item.status) &&
              <Link className="ml-3 text-sky-300 underline" href={`${settingsHref("auto-print", `run=${encodeURIComponent(item.runId)}&job=${encodeURIComponent(item.jobId)}`)}#autoprint-retry-review`}>Open retry / operator review</Link>}
          </article>;
        })}
      </div>
      {history.hasNextPage && <button type="button" className={button} disabled={history.isFetchingNextPage} onClick={() => history.fetchNextPage()}>Load older matches</button>}
      <p className="text-xs text-slate-500">Success means PrintNode accepted the job, not confirmation of physical paper output. Searching never prints or changes an invoice.</p>
    </div>}
  </section>;
}
