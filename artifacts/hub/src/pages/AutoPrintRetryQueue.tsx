import { useEffect, useRef, useState } from "react";
import { useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAutoPrintRetries, useActOnAutoPrintRetry, getListAutoPrintRetriesQueryKey,
  getListAutoPrintJobsQueryKey, getListAutoPrintRunsQueryKey, getGetAutoPrintRunQueryKey,
  type AutoPrintRetryJob, type AutoPrintRetryActionRequest,
} from "@workspace/api-client-react";
import { useStaff } from "@/components/auth/StaffGate";
import { AutoPrintSection } from "@/components/autoprint/AutoPrintSection";

const button = "rounded border border-slate-600 px-2 py-1 text-xs disabled:opacity-40";
const field = "w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm";
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "—";

export function AutoPrintRetryQueue() {
  const linkedJobId = new URLSearchParams(useSearch()).get("job");
  const staff = useStaff();
  const admin = staff.role === "admin";
  const queue = useListAutoPrintRetries({ query: { queryKey: getListAutoPrintRetriesQueryKey(), enabled: admin, refetchInterval: 10_000 } });
  const cache = useQueryClient();
  const [selected, setSelected] = useState<AutoPrintRetryJob | null>(null);
  const [action, setAction] = useState<AutoPrintRetryActionRequest["action"]>("retry");
  const [statusId, setStatusId] = useState("");
  const [note, setNote] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const focusedJob = useRef<string | null>(null);
  useEffect(() => {
    if (!linkedJobId || !queue.data || focusedJob.current === linkedJobId) return;
    const target = queue.data.jobs.find(job => job.id === linkedJobId);
    if (target) {
      setSearch(target.visualId ?? target.printavoOrderId);
      focusedJob.current = linkedJobId;
    }
  }, [linkedJobId, queue.data]);
  const mutation = useActOnAutoPrintRetry({ mutation: {
    onSuccess: async () => {
      await Promise.all([
        cache.invalidateQueries({ queryKey: getListAutoPrintRetriesQueryKey() }),
        cache.invalidateQueries({ queryKey: getListAutoPrintJobsQueryKey() }),
        cache.invalidateQueries({ queryKey: getListAutoPrintRunsQueryKey() }),
        ...(selected ? [cache.invalidateQueries({ queryKey: getGetAutoPrintRunQueryKey(selected.runId) })] : []),
      ]);
      setSelected(null);
    },
    onError: (err) => {
      const data = (err as { data?: { error?: string } }).data;
      setError(data?.error ?? "Action failed. Refresh the queue before trying again.");
    },
  } });
  if (!admin) return null;
  const open = (job: AutoPrintRetryJob, next: AutoPrintRetryActionRequest["action"]) => {
    setSelected(job); setAction(next); setStatusId(""); setNote(""); setNodeId(""); setConfirmed(false); setError("");
  };
  const jobs = (queue.data?.jobs ?? []).filter(j => !search || j.visualId?.includes(search) || j.printavoOrderId.includes(search));
  return <AutoPrintSection title="Pending retries & operator review" id="autoprint-retry-review" revealParam="job" testId="autoprint-retry-queue">
    <p className="text-xs text-slate-400">Temporary failures stay here without moving the order to its failure status. Automatic retries run only in production while live Auto-Print is enabled. Accepted jobs never retry; uncertain sends require PrintNode and printer verification.</p>
    <p className="text-xs text-slate-400">Printavo workorder-page 403s get up to three attempts, then a 15-minute cooldown and one final three-attempt round. Print Error is withheld during the cooldown. “Retry now” is a single manual attempt and overrides the wait.</p>
    <input aria-label="Find invoice in retry queue" placeholder="Find invoice number or order ID" className={field} value={search} onChange={e => setSearch(e.target.value)} />
    {queue.isLoading && <p className="text-sm text-slate-400">Loading retry queue…</p>}
    {queue.isError && <p role="alert" className="text-red-300">Could not load retries. <button className={button} onClick={() => queue.refetch()}>Refresh</button></p>}
    {!queue.isLoading && !queue.isError && jobs.length === 0 && <p className="text-sm text-slate-400">No matching retry jobs.</p>}
    <div className="max-h-[600px] space-y-3 overflow-y-auto">
      {jobs.map(job => <article key={job.id} id={`autoprint-job-${job.id}`} className={`space-y-2 rounded-lg border bg-slate-950 p-3 text-xs text-slate-300 ${job.id === linkedJobId ? "border-sky-500" : "border-slate-800"}`}>
        <div className="flex flex-wrap justify-between gap-2">
          <strong>Invoice #{job.visualId ?? job.printavoOrderId}</strong>
          <span>{job.status} · {job.retryPhase ?? "legacy"} · {job.retryCount} durable attempt(s)</span>
        </div>
        <p>Expected status: {job.sourceStatusName ?? "unknown"} ({job.sourceStatusId ?? "unknown"}) · Next retry: {time(job.nextRetryAt)}</p>
        {job.printnodeJobId && <p>Accepted PrintNode job: {job.printnodeJobId} — not eligible for resend.</p>}
        {job.errorMessage && <p className="whitespace-pre-wrap text-amber-200">{job.errorMessage}</p>}
        <div className="flex flex-wrap gap-2">
          {job.retryManaged && !job.printnodeJobId && ["retry_pending", "held", "exhausted", "cancelled"].includes(job.status) && <>
            <button className={button} onClick={() => open(job, "retry")}>Retry now</button>
            <button className={button} onClick={() => open(job, "cancel")}>Cancel retry</button>
            <button className={button} onClick={() => open(job, "fail")}>Stop & apply failure status</button>
          </>}
          {!job.printnodeJobId && ["failed", "held", "exhausted", "cancelled", "retry_pending"].includes(job.status) &&
            <button className={button} onClick={() => open(job, "recover")}>Review / recover</button>}
          {job.status === "submission_unknown" && <>
            <button className={button} onClick={() => open(job, "confirm_accepted")}>Record verified acceptance</button>
            <button className={button} onClick={() => open(job, "confirm_not_sent")}>Verify nothing submitted</button>
          </>}
        </div>
        <details>
          <summary className="cursor-pointer text-sky-300">Attempt history ({job.attempts.length})</summary>
          {!job.attempts.length && <p className="mt-2">No detailed attempt records. This alone does not indicate a failed print. Review the job status and any printer acceptance before recovery.</p>}
          {job.attempts.map(a => <div key={a.id} className="mt-2 border-t border-slate-800 pt-2">
            #{a.attempt} · {a.phase} · {a.outcome} · {time(a.startedAt)}
            {a.error && <p className="whitespace-pre-wrap text-amber-200">{a.error}</p>}
          </div>)}
        </details>
      </article>)}
    </div>
    {selected && <div role="dialog" aria-modal="true" aria-label={`Confirm ${action} for invoice ${selected.visualId}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <form className="w-full max-w-lg space-y-4 rounded-xl border border-slate-600 bg-slate-950 p-5 text-sm text-slate-200"
        onSubmit={e => { e.preventDefault(); mutation.mutate({ id: selected.id, data: {
          action, ...(statusId ? { expectedStatusId: statusId.trim() } : {}),
          ...(note ? { note } : {}), ...(nodeId ? { printnodeJobId: nodeId } : {}),
          confirmedNotSubmitted: confirmed,
        } }); }}>
        <h3 className="font-semibold">Invoice #{selected.visualId}: {action.replaceAll("_", " ")}</h3>
        {action === "retry" && <p className="text-amber-200">This is a live print attempt, even in development or with dry-run settings. The exact order and expected status will be checked again. Accepted output may advance the order’s status.</p>}
        {action === "cancel" && <p>Cancel future attempts without changing Printavo. Normal discovery will not requeue this job.</p>}
        {action === "fail" && <p className="text-amber-200">Stop retries and request the configured failure status, only if the order still has its exact expected source status.</p>}
        {action === "recover" && <>
          <p className="text-amber-200">Status conflict warning: the order may have moved since failure (including to Monday Sync). Recovery authorizes a fresh snapshot at the exact status you enter, without changing Printavo or printing. Retry now is a separate action.</p>
          <label className="block">Exact current Printavo status ID<input required className={field} value={statusId} onChange={e => setStatusId(e.target.value)} /></label>
        </>}
        {action === "confirm_accepted" && <label className="block">Verified PrintNode job ID<input required pattern="[1-9][0-9]*" className={field} value={nodeId} onChange={e => setNodeId(e.target.value)} /></label>}
        {["recover", "confirm_not_sent"].includes(action) && <label className="flex gap-2 text-amber-200">
          <input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
          I verified in PrintNode and at the printer that this workorder was not submitted.
        </label>}
        {!["retry", "cancel"].includes(action) && <label className="block">Verification / decision note<textarea required maxLength={2000} className={field} value={note} onChange={e => setNote(e.target.value)} /></label>}
        {error && <p role="alert" className="whitespace-pre-wrap text-red-300">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={button} disabled={mutation.isPending} onClick={() => setSelected(null)}>Close</button>
          <button className={button} disabled={mutation.isPending}>{mutation.isPending ? "Working…" : "Confirm"}</button>
        </div>
      </form>
    </div>}
  </AutoPrintSection>;
}
