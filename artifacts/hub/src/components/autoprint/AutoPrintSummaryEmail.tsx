import { getGetAutoPrintSummaryEmailQueryKey, useGetAutoPrintSummaryEmail } from "@workspace/api-client-react";

export function AutoPrintSummaryEmail() {
  const query = useGetAutoPrintSummaryEmail({ query: {
    queryKey: getGetAutoPrintSummaryEmailQueryKey(), refetchInterval: 30000, staleTime: 0,
  } });
  return <section className="rounded-xl border border-slate-700 bg-slate-900/60 p-4 space-y-2" aria-labelledby="summary-email-heading">
    <h3 id="summary-email-heading" className="text-sm font-semibold text-white">AutoPrint summary emails</h3>
    {query.isLoading ? <p className="text-sm text-slate-400">Loading email schedule…</p>
      : query.isError || !query.data ? <p role="alert" className="text-sm text-red-300">Could not load summary email status. <button className="underline" onClick={() => query.refetch()}>Retry</button></p>
      : <>
        <p className="text-sm text-slate-200">{query.data.schedule} → {query.data.recipient}</p>
        <p className="text-xs text-slate-400">Published Hub only. Each email covers the previous summary window plus unresolved recent carryover. Pending retries are listed—not reported as successes. Immediate failure alerts continue separately. Starts at the next scheduled slot after publishing; missed slots are not backfilled.</p>
        <details className="text-xs text-slate-300">
          <summary className="cursor-pointer text-sky-300">Recent email deliveries</summary>
          {!query.data.deliveries.length && <p className="mt-2">No scheduled summaries recorded in this environment yet.</p>}
          {query.data.deliveries.map(d => <p key={d.slot} className="mt-2">
            {new Date(d.slot).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" })}:
            {" "}{d.state === "sent" ? "Accepted by email provider" : d.state === "review_required" ? "Delivery unconfirmed — administrator review required; check Resend before resending" : "Pending delivery / retry"}
          </p>)}
        </details>
      </>}
  </section>;
}
