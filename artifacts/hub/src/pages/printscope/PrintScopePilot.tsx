import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { 
  useGetPrintscopePilot, getGetPrintscopePilotQueryKey,
  useStartPrintscopePilot,
  useListPrintscopePilotSources, getListPrintscopePilotSourcesQueryKey,
  useImportPrintscopePilotSource,
  useListPrintscopePilotJobs, getListPrintscopePilotJobsQueryKey,
  useReviewPrintscopePilotJob,
  useListPrintscopePilotReviews, getListPrintscopePilotReviewsQueryKey,
  PrintscopePilotSummary, PrintscopePilotSource, PrintscopePilotJob,
  PrintscopePilotReviewOutcome,
  PrintscopePilotJobList,
  PrintscopePilot
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { PrintScopeDetail } from "./PrintScopeJobs";
import { useStaff } from "@/components/auth/StaffGate";

export function PrintScopePilot() {
  const { role } = useStaff();
  const { data: summary, isLoading, error } = useGetPrintscopePilot({
    query: { queryKey: getGetPrintscopePilotQueryKey() }
  });

  if (isLoading) return <div className="flex h-full items-center justify-center" style={{ height: "calc(100% - 48px)" }}><Loader2 className="animate-spin text-ink-3" /></div>;
  if (error || !summary) return <div className="flex h-full items-center justify-center text-fail" style={{ height: "calc(100% - 48px)" }}>Failed to load pilot data.</div>;

  if (!summary.pilot) {
    return <PilotNotStarted role={role} />;
  }

  return <PilotActive summary={summary} />;
}

function PilotNotStarted({ role }: { role: string }) {
  const startPilot = useStartPrintscopePilot();
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState(false);

  const handleStart = async () => {
    try {
      await startPilot.mutateAsync(undefined);
      queryClient.invalidateQueries({ queryKey: getGetPrintscopePilotQueryKey() });
    } catch (e) {
      alert("Failed to start pilot");
    }
  };

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center max-w-lg mx-auto" style={{ height: "calc(100% - 48px)" }}>
      <h2 className="text-2xl font-bold mb-4">SepScope Pilot</h2>
      <p className="text-ink-2 mb-8">
        The pilot is a 14-day production data trial. When started, staff can import existing Printavo order artwork to compare against the SepScope engine.
      </p>
      
      {role === "admin" ? (
        !confirm ? (
          <button className="bg-slate-800 text-white px-6 py-3 rounded hover:bg-slate-700 font-semibold" onClick={() => setConfirm(true)}>
            Start 14-Day Pilot
          </button>
        ) : (
          <div className="bg-surface-2 border border-line p-6 rounded-lg text-left">
            <h3 className="font-bold mb-2">Confirm Pilot Launch</h3>
            <ul className="list-disc pl-5 mb-6 text-sm text-ink-2 space-y-2">
              <li>The pilot runs for exactly 14 days (starts now).</li>
              <li>A snapshot of the current rules is immutably pinned.</li>
              <li>Original upstream mirrored files in Printavo remain completely untouched.</li>
              <li>Pilot copies and generated plates will be automatically deleted 30 days after the pilot ends.</li>
              <li>Review history and metrics are retained.</li>
            </ul>
            <div className="flex gap-4 justify-end">
              <button className="px-4 py-2 text-ink-2 hover:bg-line rounded" onClick={() => setConfirm(false)} disabled={startPilot.isPending}>Cancel</button>
              <button className="bg-fail text-white px-4 py-2 rounded font-semibold flex items-center gap-2" onClick={handleStart} disabled={startPilot.isPending}>
                {startPilot.isPending && <Loader2 size={16} className="animate-spin" />}
                Confirm & Start
              </button>
            </div>
          </div>
        )
      ) : (
        <div className="bg-surface-2 p-4 rounded text-ink-2 text-sm border border-line">
          The pilot has not been started. Only an admin can launch the pilot.
        </div>
      )}
    </div>
  );
}

function PilotActive({ summary }: { summary: PrintscopePilotSummary }) {
  const pilot = summary.pilot!;
  const [location, setLocation] = useLocation();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const tab = searchParams.get("tab") || "jobs";
  const jobId = searchParams.get("job");
  const sourceId = searchParams.get("source");

  const [jobsOffset, setJobsOffset] = useState(0);
  const [sourcesOffset, setSourcesOffset] = useState(0);

  const { data: jobsData, isLoading: jobsLoading } = useListPrintscopePilotJobs(
    { limit: 50, offset: jobsOffset },
    {
      query: {
        queryKey: getListPrintscopePilotJobsQueryKey({ limit: 50, offset: jobsOffset }),
        refetchInterval: (query) => {
          const data = query.state.data as PrintscopePilotJobList | undefined;
          if (data?.jobs?.some(j => j.state === "queued" || j.state === "processing" || j.state === "uploading")) {
            return 5000;
          }
          return false;
        }
      }
    }
  );

  const { data: sourcesData, isLoading: sourcesLoading } = useListPrintscopePilotSources(
    { limit: 50, offset: sourcesOffset },
    {
      query: {
        queryKey: getListPrintscopePilotSourcesQueryKey({ limit: 50, offset: sourcesOffset }),
        enabled: tab === "sources"
      }
    }
  );

  const selectedJob = jobsData?.jobs.find(j => j.id === jobId);
  const selectedSource = sourcesData?.sources.find(s => s.sourceId === sourceId);

  return (
    <div className="flex flex-col" style={{ height: "calc(100% - 48px)" }}>
      <div className="border-b border-line bg-surface-1 p-4 flex flex-col md:flex-row md:items-center justify-between shrink-0 gap-4">
        <div className="w-full">
           <h2 className="font-bold text-lg">Pilot Overview</h2>
           <div className="text-xs text-ink-2 mt-1 flex flex-wrap gap-x-4 gap-y-1">
             <span>State: <strong className="uppercase font-bold">{pilot.state}</strong></span>
             <span>Rules: v{pilot.ruleVersionId}</span>
             <span>Started: {new Date(pilot.startedAt).toLocaleString()}</span>
             <span>Ends: {new Date(pilot.endsAt).toLocaleString()}</span>
             <span>Purge: {new Date(pilot.purgeAfter).toLocaleString()}</span>
           </div>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-4 text-sm justify-start md:justify-end w-full md:w-auto shrink-0">
           <div className="flex flex-col md:items-end">
             <span className="text-ink-3 uppercase text-[10px] tracking-wider font-semibold">Jobs</span>
             <span className="font-semibold">{summary.metrics.queued} Q / {summary.metrics.completed} C / {summary.metrics.failed} F (of {summary.metrics.imported})</span>
           </div>
           <div className="flex flex-col md:items-end">
             <span className="text-ink-3 uppercase text-[10px] tracking-wider font-semibold">Reviews</span>
             <span className="font-semibold">{summary.metrics.reviewed} (Unreviewed: {summary.metrics.unreviewed})</span>
           </div>
           <div className="flex flex-col md:items-end">
             <span className="text-ink-3 uppercase text-[10px] tracking-wider font-semibold">Comparison</span>
             <span className="font-semibold">{summary.metrics.matching} match / {summary.metrics.nonmatching} differ (of {summary.metrics.comparable})</span>
           </div>
           <div className="flex flex-col md:items-end">
             <span className="text-ink-3 uppercase text-[10px] tracking-wider font-semibold">Uncertain</span>
             <span className="font-semibold">{summary.metrics.uncertain}</span>
           </div>
           <div className="flex flex-col md:items-end">
             <span className="text-ink-3 uppercase text-[10px] tracking-wider font-semibold">Potential False Clearance</span>
             <span className="font-semibold text-fail">{summary.metrics.falseClear}</span>
           </div>
        </div>
      </div>
      
      {summary.metrics.limitations.length > 0 && (
        <div className="border-b border-line bg-surface-2 p-3 text-xs text-ink-2 shrink-0">
           <strong className="text-ink-1 mr-2 font-bold uppercase tracking-wider text-[10px]">Limitations</strong>
           {summary.metrics.limitations.join("; ")}
        </div>
      )}
      
      <div className="flex flex-col md:flex-row flex-1 overflow-hidden">
        <aside className="border-r border-b md:border-b-0 border-line bg-surface-1 w-full md:w-[320px] shrink-0 flex flex-col h-[40vh] md:h-full overflow-hidden">
          <div className="railhead p-0 shrink-0 border-b border-line h-[45px] flex">
            <button 
              className={`flex-1 py-3 text-sm font-semibold border-b-2 ${tab === 'jobs' ? 'border-ink-1 text-ink-1' : 'border-transparent text-ink-3 hover:text-ink-2'}`}
              onClick={() => setLocation(`/printscope/pilot?tab=jobs`)}
            >
              Inspections
            </button>
            <button 
              className={`flex-1 py-3 text-sm font-semibold border-b-2 ${tab === 'sources' ? 'border-ink-1 text-ink-1' : 'border-transparent text-ink-3 hover:text-ink-2'}`}
              onClick={() => setLocation(`/printscope/pilot?tab=sources`)}
            >
              Sources
            </button>
          </div>
          
          <div className="qlist flex-1 overflow-y-auto">
            {tab === "jobs" ? (
              <>
                {jobsLoading && <div className="p-4 text-center text-ink-3 text-sm">Loading...</div>}
                {jobsData?.jobs.map(job => (
                   <PilotJobItem key={job.id} job={job} selected={job.id === jobId} onClick={() => setLocation(`/printscope/pilot?tab=jobs&job=${job.id}`)} />
                ))}
                {jobsData && jobsData.total > 50 && (
                   <div className="flex items-center justify-between p-3 border-t border-line text-xs font-semibold">
                      <button disabled={jobsOffset === 0} onClick={() => setJobsOffset(Math.max(0, jobsOffset - 50))} className="text-ink-2 hover:text-ink-1 disabled:opacity-50">Prev</button>
                      <span className="text-ink-3">{jobsOffset + 1}-{Math.min(jobsOffset + 50, jobsData.total)} of {jobsData.total}</span>
                      <button disabled={jobsOffset + 50 >= jobsData.total} onClick={() => setJobsOffset(jobsOffset + 50)} className="text-ink-2 hover:text-ink-1 disabled:opacity-50">Next</button>
                   </div>
                )}
              </>
            ) : (
              <>
                {sourcesLoading && <div className="p-4 text-center text-ink-3 text-sm">Loading...</div>}
                {sourcesData?.sources.map(src => (
                   <button 
                     key={src.sourceId} 
                     className={`w-full text-left p-3 flex flex-col border-b border-line hover:bg-surface-2 transition-colors ${src.sourceId === sourceId ? 'bg-surface-2' : ''}`}
                     onClick={() => setLocation(`/printscope/pilot?tab=sources&source=${src.sourceId}`)}
                   >
                     <span className="font-semibold text-sm truncate">{src.filename}</span>
                     <div className="flex justify-between w-full mt-1 items-center">
                        <span className="text-xs text-ink-3">Order #{src.visualId}</span>
                        {!src.eligible && <span className="text-[9px] uppercase font-bold text-fail bg-fail-bg px-1 rounded">Ineligible</span>}
                     </div>
                   </button>
                ))}
                {sourcesData && sourcesData.total > 50 && (
                   <div className="flex items-center justify-between p-3 border-t border-line text-xs font-semibold">
                      <button disabled={sourcesOffset === 0} onClick={() => setSourcesOffset(Math.max(0, sourcesOffset - 50))} className="text-ink-2 hover:text-ink-1 disabled:opacity-50">Prev</button>
                      <span className="text-ink-3">{sourcesOffset + 1}-{Math.min(sourcesOffset + 50, sourcesData.total)} of {sourcesData.total}</span>
                      <button disabled={sourcesOffset + 50 >= sourcesData.total} onClick={() => setSourcesOffset(sourcesOffset + 50)} className="text-ink-2 hover:text-ink-1 disabled:opacity-50">Next</button>
                   </div>
                )}
              </>
            )}
          </div>
        </aside>
        
        <main className="detail bg-white flex-1 h-[60vh] md:h-full overflow-y-auto w-full">
          {tab === "jobs" ? (
             jobId ? (
                selectedJob ? <PilotJobDetail job={selectedJob} pilot={summary.pilot!} /> : <div className="p-8 text-center text-ink-3">Job not found.</div>
             ) : <div className="flex h-full items-center justify-center text-ink-3 font-semibold">Select a pilot inspection job</div>
          ) : (
             sourceId ? (
                selectedSource ? <PilotSourceDetail source={selectedSource} pilot={summary.pilot!} /> : <div className="p-8 text-center text-ink-3">Source not found.</div>
             ) : <div className="flex h-full items-center justify-center text-ink-3 font-semibold">Select a source file to import</div>
          )}
        </main>
      </div>
    </div>
  );
}

function PilotJobItem({ job, selected, onClick }: { job: PrintscopePilotJob, selected: boolean, onClick: () => void }) {
  const res = job.result as any;
  const verdict = res?.verdict || job.state;
  
  return (
    <button 
      className="qitem relative" 
      data-v={verdict} 
      aria-current={selected ? "true" : "false"}
      onClick={onClick}
    >
      <span className="stripe" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: "4px" }}></span>
      <span className="body flex flex-col pl-[10px] w-full">
        <span className="fn truncate font-semibold text-[13px]">{job.filename}</span>
        <span className="qmeta flex items-center mt-1">
          <span className="uppercase text-[10px] font-bold tracking-widest">{verdict}</span>
          {job.latestReview && <span className="ml-2 text-[9px] uppercase font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">Rev: {job.latestReview.outcome}</span>}
          <span style={{ marginLeft: "auto", fontSize: "11px", color: "var(--ink-3)" }}>
            {new Date(job.createdAt).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}
          </span>
        </span>
      </span>
    </button>
  );
}

function PilotSourceDetail({ source, pilot }: { source: PrintscopePilotSource, pilot: PrintscopePilot }) {
  const importSource = useImportPrintscopePilotSource();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [errorMsg, setErrorMsg] = useState("");

  const handleImport = async () => {
    if (!source.eligible || pilot.state !== "active" || !source.revisionToken || !source.sourceGeneration) return;
    try {
      setErrorMsg("");
      const job = await importSource.mutateAsync({
        data: {
          pilotId: pilot.id,
          sourceId: source.sourceId,
          revisionToken: source.revisionToken,
          expectedGeneration: source.sourceGeneration,
          expectedFilename: source.filename,
          expectedBytes: source.bytes
        }
      });
      queryClient.invalidateQueries({ queryKey: getListPrintscopePilotJobsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetPrintscopePilotQueryKey() });
      setLocation(`/printscope/pilot?tab=jobs&job=${job.id}`);
    } catch (e: any) {
      if (e?.status === 409) {
        setErrorMsg("Source metadata is stale. Please refresh the list.");
        queryClient.invalidateQueries({ queryKey: getListPrintscopePilotSourcesQueryKey() });
      } else {
        setErrorMsg(e.message || "Failed to import source");
      }
    }
  };

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h2 className="text-xl font-bold mb-6">Source Artwork</h2>
      
      <div className="bg-surface-1 border border-line rounded-lg p-6 flex flex-col gap-6">
        <div>
          <span className="text-xs text-ink-3 uppercase font-semibold tracking-wider">Filename</span>
          <p className="font-mono text-[13px] mt-1 p-2 bg-surface-2 border border-line rounded break-all">{source.filename}</p>
        </div>
        
        <div className="flex flex-wrap gap-8">
          <div>
            <span className="text-xs text-ink-3 uppercase font-semibold tracking-wider">Order ID</span>
            <p className="mt-1 font-semibold">#{source.visualId}</p>
          </div>
          <div>
            <span className="text-xs text-ink-3 uppercase font-semibold tracking-wider">Size</span>
            <p className="mt-1 font-semibold">{Math.round(source.bytes / 1024)} KB</p>
          </div>
          <div>
            <span className="text-xs text-ink-3 uppercase font-semibold tracking-wider">Mirrored</span>
            <p className="mt-1 font-semibold">{new Date(source.mirroredAt).toLocaleString()}</p>
          </div>
        </div>
        
        <div className="pt-6 border-t border-line">
          {source.eligible ? (
            <div className="flex flex-col gap-4 items-start">
              <span className="text-pass flex items-center gap-2 font-semibold">
                <CheckCircle2 size={18} /> Eligible for pilot inspection
              </span>
              <button 
                className="bg-slate-800 text-white px-5 py-2.5 rounded font-semibold flex items-center gap-2 disabled:opacity-50 transition-colors hover:bg-slate-700"
                onClick={handleImport}
                disabled={importSource.isPending || pilot.state !== "active" || !source.revisionToken || !source.sourceGeneration}
              >
                {importSource.isPending && <Loader2 size={16} className="animate-spin" />}
                Import for Inspection
              </button>
              {errorMsg && <p className="text-fail text-sm font-semibold">{errorMsg}</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-3 p-4 bg-fail-bg border border-fail rounded">
              <span className="text-fail flex items-center gap-2 font-bold">
                <XCircle size={18} /> Ineligible for Pilot
              </span>
              <ul className="list-disc pl-6 text-sm text-ink-1 space-y-1">
                {source.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PilotJobDetail({ job, pilot }: { job: PrintscopePilotJob, pilot: PrintscopePilot }) {
  return (
    <div className="flex flex-col relative h-full">
      <div className="bg-surface-2 border-b border-line px-6 py-4 text-sm flex items-center justify-between shrink-0">
         <div className="flex flex-col gap-1">
            <h3 className="font-bold text-ink-1">Pilot Inspection Cohort</h3>
            <div className="flex gap-6 text-ink-2 text-xs font-semibold">
               <span>Order #{job.provenance.visualId}</span>
               <span>Imported: {new Date(job.provenance.importedAt).toLocaleString()}</span>
               <span className="font-mono">SHA: {job.provenance.contentSha256.substring(0, 16)}</span>
            </div>
         </div>
         <div className="text-right">
             <span className="text-[10px] uppercase font-bold text-ink-3 tracking-widest block">Original Size</span>
             <span className="font-semibold text-xs text-ink-2">{Math.round(job.provenance.bytes / 1024)} KB</span>
         </div>
      </div>
      
      <div className="flex-1 overflow-y-auto">
         <PrintScopeDetail job={job} />
         
         <PilotReviewForm job={job} pilot={pilot} />
      </div>
    </div>
  );
}

function PilotReviewForm({ job, pilot }: { job: PrintscopePilotJob, pilot: PrintscopePilot }) {
  const queryClient = useQueryClient();
  const reviewMutation = useReviewPrintscopePilotJob();
  const [historyOffset, setHistoryOffset] = useState(0);
  
  const { data: historyData, isLoading: historyLoading, isError: historyError, refetch: reloadHistory } = useListPrintscopePilotReviews(
    job.id,
    { limit: 50, offset: historyOffset },
    {
      query: {
        queryKey: getListPrintscopePilotReviewsQueryKey(job.id, { limit: 50, offset: historyOffset })
      }
    }
  );

  const canReview = pilot.state !== "expired" && job.state === "completed";
  
  const [outcome, setOutcome] = useState<PrintscopePilotReviewOutcome | "">("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  useEffect(() => {
    setHistoryOffset(0);
    setOutcome("");
    setReason("");
    setNote("");
    setErrorMsg("");
    setSuccessMsg("");
  }, [job.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!outcome) {
      setErrorMsg("Please select an outcome.");
      return;
    }
    if (!reason.trim()) {
      setErrorMsg("A reason is required.");
      return;
    }
    
    try {
      setErrorMsg("");
      await reviewMutation.mutateAsync({
        id: job.id,
        data: {
          outcome: outcome as PrintscopePilotReviewOutcome,
          reason,
          note
        }
      });
      setSuccessMsg("Review submitted successfully.");
      queryClient.invalidateQueries({ queryKey: getListPrintscopePilotJobsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetPrintscopePilotQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListPrintscopePilotReviewsQueryKey(job.id) });
      setHistoryOffset(0);
      setOutcome("");
      setReason("");
      setNote("");
    } catch (e: any) {
      setErrorMsg(e.message || "Failed to submit review");
    }
  };

  return (
    <section className="blk mb-12">
      <div className="blkhead">
        <h2 style={{ fontSize: "15px" }}>Human Review</h2>
        <span className="lbl">Pilot Comparison</span>
      </div>
      
      <div className="p-6 bg-surface-1 border border-line rounded-lg m-4 shadow-sm">
        {historyLoading && <p role="status" className="mb-4 text-sm">Loading review history…</p>}
        {historyError && <p role="alert" className="mb-4 text-sm">Full review history could not be loaded. <button type="button" className="underline" onClick={() => reloadHistory()}>Retry</button></p>}
        {historyData?.reviews && historyData.reviews.length > 0 ? (
          <div className="mb-8">
            <h4 className="font-bold text-sm mb-3 border-b border-line pb-2">Review History ({historyData.total})</h4>
            <div className="flex flex-col gap-4">
              {historyData.reviews.map((rev: any) => (
                <div key={rev.id} className="p-4 bg-surface-2 border border-line rounded">
                  <div className="flex items-center gap-3 mb-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-widest ${
                      rev.outcome === 'pass' ? 'bg-pass-bg text-pass' : 
                      rev.outcome === 'fail' ? 'bg-fail-bg text-fail' : 
                      rev.outcome === 'flag' ? 'bg-flag-bg text-flag' : 
                      'bg-slate-200 text-slate-700'
                    }`}>{rev.outcome}</span>
                    <span className="text-[11px] text-ink-3 font-semibold">
                      By {rev.reviewerId} on {new Date(rev.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase font-bold text-ink-3 block">Reason</span>
                    <p className="text-[13px] font-medium text-ink-1 mt-0.5">{rev.reason}</p>
                  </div>
                  {rev.note && (
                    <div className="mt-2">
                      <span className="text-[10px] uppercase font-bold text-ink-3 block">Notes</span>
                      <p className="text-[13px] text-ink-2 mt-0.5">{rev.note}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {historyData.total > 50 && <div className="flex justify-between items-center gap-3 mt-4 text-sm">
              <button type="button" disabled={historyOffset === 0} onClick={() => setHistoryOffset(Math.max(0, historyOffset - 50))} className="underline disabled:opacity-40">Newer reviews</button>
              <span>{historyOffset + 1}–{Math.min(historyOffset + 50, historyData.total)} of {historyData.total}</span>
              <button type="button" disabled={historyOffset + 50 >= historyData.total} onClick={() => setHistoryOffset(historyOffset + 50)} className="underline disabled:opacity-40">Older reviews</button>
            </div>}
          </div>
        ) : job.latestReview ? (
          <div className="mb-8 p-5 bg-surface-2 border border-line rounded">
            <h4 className="font-bold text-sm mb-3 flex items-center gap-3 border-b border-line pb-2">
              Latest Review 
              <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-bold tracking-widest ${
                job.latestReview.outcome === 'pass' ? 'bg-pass-bg text-pass' : 
                job.latestReview.outcome === 'fail' ? 'bg-fail-bg text-fail' : 
                job.latestReview.outcome === 'flag' ? 'bg-flag-bg text-flag' : 
                'bg-slate-200 text-slate-700'
              }`}>{job.latestReview.outcome}</span>
            </h4>
            <div className="flex flex-col gap-2">
               <div>
                  <span className="text-[10px] uppercase font-bold text-ink-3 block">Reason</span>
                  <p className="text-[13px] font-medium text-ink-1 mt-0.5">{job.latestReview.reason}</p>
               </div>
               {job.latestReview.note && (
                 <div>
                    <span className="text-[10px] uppercase font-bold text-ink-3 block mt-2">Notes</span>
                    <p className="text-[13px] text-ink-2 mt-0.5">{job.latestReview.note}</p>
                 </div>
               )}
            </div>
            <div className="text-[11px] text-ink-3 mt-4 pt-3 border-t border-line/50 font-semibold">
               By {job.latestReview.reviewerId} on {new Date(job.latestReview.createdAt).toLocaleString()}
            </div>
          </div>
        ) : null}
        
        {canReview ? (
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <h4 className="font-bold text-sm">Add New Review</h4>
            <div className="flex gap-6">
               {["pass", "flag", "fail", "uncertain"].map(o => (
                  <label key={o} className="flex items-center gap-2 text-sm cursor-pointer select-none">
                     <input 
                       type="radio" 
                       name="outcome" 
                       value={o} 
                       checked={outcome === o} 
                       onChange={(e) => setOutcome(e.target.value as PrintscopePilotReviewOutcome)} 
                       className="accent-slate-800"
                     />
                     <span className="capitalize font-semibold">{o}</span>
                  </label>
               ))}
            </div>
            
            <div className="flex flex-col gap-1.5">
               <label className="text-[10px] font-bold uppercase tracking-widest text-ink-3">Reason (Required)</label>
               <input 
                 type="text" 
                 value={reason} 
                 onChange={e => setReason(e.target.value)} 
                 className="border border-line rounded p-2.5 text-sm w-full max-w-md focus:border-slate-400 focus:outline-none transition-colors" 
                 placeholder="Brief reason for this outcome..."
                 required
               />
            </div>
            
            <div className="flex flex-col gap-1.5">
               <label className="text-[10px] font-bold uppercase tracking-widest text-ink-3">Note (Optional)</label>
               <textarea 
                 value={note} 
                 onChange={e => setNote(e.target.value)} 
                 className="border border-line rounded p-2.5 text-sm w-full max-w-md h-24 resize-y focus:border-slate-400 focus:outline-none transition-colors" 
                 placeholder="Detailed notes..."
               />
            </div>
            
            <div className="flex items-center gap-4 mt-2">
               <button 
                 type="submit" 
                 disabled={reviewMutation.isPending}
                 className="bg-slate-800 hover:bg-slate-700 text-white px-5 py-2.5 rounded font-semibold text-sm flex items-center gap-2 disabled:opacity-50 transition-colors"
               >
                 {reviewMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                 Submit Review
               </button>
               {errorMsg && <span className="text-fail text-sm font-semibold">{errorMsg}</span>}
               {successMsg && <span className="text-pass text-sm font-semibold">{successMsg}</span>}
            </div>
          </form>
        ) : (
          <div className="text-sm font-semibold text-ink-3 bg-surface-2 p-4 rounded text-center border border-line">
            {pilot.state === "expired" ? "Reviews are disabled because the pilot has expired." : "This job must finish processing before it can be reviewed."}
          </div>
        )}
      </div>
    </section>
  );
}
