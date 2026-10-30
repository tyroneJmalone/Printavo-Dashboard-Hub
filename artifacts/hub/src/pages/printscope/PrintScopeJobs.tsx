import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import { useLocation, useSearch } from "wouter";
import { 
  useListPrintscopeJobs, 
  getListPrintscopeJobsQueryKey,
  useGetPrintscopeJob,
  getPrintscopeJob,
  getGetPrintscopeJobQueryKey,
  useCreatePrintscopeUpload,
  useCompletePrintscopeUpload,
  useReinspectPrintscopeJob,
  PrintscopeCapabilities,
  PrintscopeJob
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, UploadCloud, RefreshCw, X } from "lucide-react";
import {
  nextPendingUpload,
  runUploadAttempt,
  type UploadItem
} from "./uploadOrchestration";
import { sortPlateLayers } from "./plateLayerOrder";

const LOCAL_UPLOAD_LIMIT = 50 * 1024 * 1024;
const MAX_QUEUED_UPLOADS = 20;

export function PrintScopeJobs({ caps }: { caps: PrintscopeCapabilities }) {
  const [location, setLocation] = useLocation();
  const searchString = useSearch();
  const searchParams = new URLSearchParams(searchString);
  const selectedJobId = searchParams.get("job");

  const queryClient = useQueryClient();

  const [pageOffset, setPageOffset] = useState(0);

  const { data: jobsData, isLoading: jobsLoading } = useListPrintscopeJobs(
    { limit: 50, offset: pageOffset },
    { 
      query: { 
        queryKey: getListPrintscopeJobsQueryKey({ limit: 50, offset: pageOffset }),
        refetchInterval: 5000 // finite polling
      }
    }
  );

  const { data: selectedJob, isLoading: jobLoading } = useGetPrintscopeJob(
    selectedJobId || "",
    {
      query: {
        enabled: !!selectedJobId,
        queryKey: getGetPrintscopeJobQueryKey(selectedJobId || ""),
        refetchInterval: (query) => {
          const data = query.state.data as PrintscopeJob | undefined;
          if (data && (data.state === "queued" || data.state === "processing" || data.state === "uploading")) {
            return 2000;
          }
          return false;
        }
      }
    }
  );

  // Upload Logic
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const uploadItemsRef = useRef<UploadItem[]>([]);
  const processingUploadsRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

  const createUpload = useCreatePrintscopeUpload();
  const completeUpload = useCompletePrintscopeUpload();

  const replaceUploadItems = useCallback((next: UploadItem[]) => {
    uploadItemsRef.current = next;
    setUploadItems(next);
  }, []);

  const updateUploadItem = useCallback((id: string, patch: Partial<UploadItem>) => {
    const next = uploadItemsRef.current.map(item => item.id === id ? { ...item, ...patch } : item);
    replaceUploadItems(next);
    return next.find(item => item.id === id)!;
  }, [replaceUploadItems]);

  const uploadOne = useCallback(async (id: string) => {
    const item = uploadItemsRef.current.find(candidate => candidate.id === id);
    if (!item) return;

    const result = await runUploadAttempt(item, {
      reserve: current => createUpload.mutateAsync({
          data: {
            filename: current.filename,
            byteSize: current.byteSize,
            contentType: current.contentType
          }
      }),
      put: async (uploadURL, current) => {
        const response = await fetch(uploadURL, {
          method: "PUT",
          headers: { "Content-Type": current.contentType },
          body: current.file
        });
        return { ok: response.ok, status: response.status };
      },
      getJob: getPrintscopeJob,
      complete: jobId => completeUpload.mutateAsync({ id: jobId }),
      onReserved: jobId => setLocation(`/printscope?job=${jobId}`),
      onUpdate: updated => updateUploadItem(id, updated)
    });

    if (result.status === "queued" && result.jobId) {
      queryClient.invalidateQueries({ queryKey: getListPrintscopeJobsQueryKey({ limit: 50, offset: pageOffset }) });
      queryClient.invalidateQueries({ queryKey: getGetPrintscopeJobQueryKey(result.jobId) });
    }
  }, [completeUpload, createUpload, pageOffset, queryClient, setLocation, updateUploadItem]);

  const processUploads = useCallback(async () => {
    if (processingUploadsRef.current) return;
    processingUploadsRef.current = true;
    try {
      let next = nextPendingUpload(uploadItemsRef.current);
      while (next) {
        await uploadOne(next.id);
        next = nextPendingUpload(uploadItemsRef.current);
      }
    } finally {
      processingUploadsRef.current = false;
      if (uploadItemsRef.current.some(item => item.status === "pending")) {
        void processUploads();
      }
    }
  }, [uploadOne]);

  const addFiles = useCallback((files: File[]) => {
    const maxBytes = Math.min(caps.maxUploadBytes, LOCAL_UPLOAD_LIMIT);
    const serverActiveIds = new Set(
      (jobsData?.jobs ?? [])
        .filter(job => job.state === "uploading" || job.state === "queued" || job.state === "processing")
        .map(job => job.id)
    );
    const localActiveNotYetCounted = uploadItemsRef.current.filter(item =>
      (item.status === "pending" || item.status === "reserving" || item.status === "uploading" || item.status === "completing") &&
      (!item.jobId || !serverActiveIds.has(item.jobId))
    ).length;
    let availableSlots = Math.max(
      0,
      MAX_QUEUED_UPLOADS - serverActiveIds.size - localActiveNotYetCounted
    );
    const additions = files.map((file, index): UploadItem => {
      const extension = file.name.toLowerCase().split(".").pop();
      const base = {
        id: `${Date.now()}-${index}-${file.name}-${file.size}`,
        filename: file.name,
        byteSize: file.size,
        contentType: file.type || "application/pdf",
        resumeAt: "reserve" as const
      };
      if (extension !== "ai") {
        return { ...base, status: "error", error: "Unsupported filename. SepScope accepts PDF-compatible .ai files only.", retryable: false };
      }
      if (file.size > maxBytes) {
        return { ...base, status: "error", error: `File exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB per-file limit.`, retryable: false };
      }
      if (availableSlots === 0) {
        return { ...base, file, status: "error", error: "Only 20 files can be queued at once. Retry this file after the current queue advances.", retryable: true };
      }
      availableSlots -= 1;
      return { ...base, file, status: "pending", retryable: true };
    });
    replaceUploadItems([...uploadItemsRef.current, ...additions]);
    void processUploads();
  }, [caps.maxUploadBytes, jobsData?.jobs, processUploads, replaceUploadItems]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files ?? []));
    e.target.value = "";
  };

  const retryUpload = (id: string) => {
    const item = uploadItemsRef.current.find(candidate => candidate.id === id);
    if (!item || item.status !== "error" || !item.retryable) return;
    updateUploadItem(id, { status: "pending", error: undefined });
    void processUploads();
  };

  const retryFailedUploads = () => {
    replaceUploadItems(uploadItemsRef.current.map(item =>
      item.status === "error" && item.retryable ? { ...item, status: "pending", error: undefined } : item
    ));
    void processUploads();
  };

  const hasActiveUploads = uploadItems.some(item =>
    item.status === "pending" || item.status === "reserving" || item.status === "uploading" || item.status === "completing"
  );
  const retryableFailures = uploadItems.filter(item => item.status === "error" && item.retryable).length;

  const reinspectJob = useReinspectPrintscopeJob();
  const handleReinspect = (id: string) => {
    reinspectJob.mutate({ id }, {
      onSuccess: (newJob) => {
        queryClient.invalidateQueries({ queryKey: getListPrintscopeJobsQueryKey({ limit: 50, offset: pageOffset }) });
        setLocation(`/printscope?job=${newJob.id}`);
      }
    });
  };

  const jobs = jobsData?.jobs || [];
  const tot = jobs.reduce((acc, j) => {
    const v = (j.result as any)?.verdict || j.state;
    acc[v] = (acc[v] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="wrap">
      <aside className="rail">
        <div className="railhead">
          <h1 style={{ fontSize: "13px" }}>Inspected</h1>
          <span className="lbl">{jobs.length} files &middot; {tot["fail"] || 0} failed &middot; {tot["flag"] || 0} flagged</span>
          
          <div className="ml-auto flex gap-2">
            <input 
              type="file" 
              accept=".ai"
              multiple
              ref={fileInputRef} 
              className="hidden" 
              onChange={handleFileChange}
            />
            {retryableFailures > 0 && (
              <button 
                className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded border border-red-200"
                onClick={retryFailedUploads}
              >
                Retry failed ({retryableFailures})
              </button>
            )}
            <button 
              className="flex items-center gap-1 text-xs bg-slate-800 text-white px-2 py-1 rounded hover:bg-slate-700"
              onClick={() => fileInputRef.current?.click()}
            >
              {hasActiveUploads ? <Loader2 size={12} className="animate-spin" /> : <UploadCloud size={12} />}
              Add files
            </button>
          </div>
        </div>

        <div
          className={`m-3 rounded-md border-2 border-dashed p-3 text-center text-xs transition-colors ${
            isDragging ? "border-[var(--accent)] bg-[var(--surface-2)] text-[var(--accent)]" : "border-line text-ink-3"
          }`}
          onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setIsDragging(true); }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            addFiles(Array.from(event.dataTransfer.files));
          }}
        >
          <UploadCloud size={18} className="mx-auto mb-1" />
          Drop PDF-compatible .ai files here
          <div className="mt-1 text-[10px]">Up to 20 queued files, 50 MiB each. Reloading loses local files that have not finished uploading.</div>
        </div>

        {uploadItems.length > 0 && (
          <div className="mx-3 mb-3 max-h-44 overflow-y-auto rounded border border-line bg-surface-2">
            {uploadItems.map(item => (
              <div key={item.id} className="flex w-full min-w-0 flex-wrap items-start gap-2 border-b border-line px-2 py-2 text-xs last:border-b-0">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold" title={item.filename}>{item.filename}</div>
                  <div className={item.status === "error" ? "mt-0.5 text-fail" : "mt-0.5 text-ink-3"}>
                    {item.status === "error"
                      ? item.error
                      : item.status === "queued"
                      ? item.serverState === "completed"
                        ? "Uploaded · inspection completed"
                        : item.serverState === "failed"
                        ? "Uploaded · inspection failed"
                        : item.serverState === "processing"
                        ? "Uploaded · inspection processing"
                        : "Uploaded · queued for inspection"
                      : item.status}
                    {item.jobId && item.status !== "queued" ? ` · job ${item.jobId}` : ""}
                  </div>
                </div>
                {item.status === "error" && item.retryable && (
                  <button className="font-semibold text-fail hover:underline" onClick={() => retryUpload(item.id)}>Retry</button>
                )}
                {(item.status === "queued" || (item.status === "error" && !item.retryable)) && (
                  <button
                    aria-label={`Dismiss ${item.filename}`}
                    className="text-ink-3 hover:text-ink-1"
                    onClick={() => replaceUploadItems(uploadItemsRef.current.filter(candidate => candidate.id !== item.id))}
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        
        <div className="qlist">
          {jobsLoading && <div className="p-4 text-center text-ink-3">Loading...</div>}
          {jobs.map((job) => {
            const res = job.result as any;
            const verdict = res?.verdict || job.state;
            const counts = res ? res.results?.reduce((acc: any, r: any) => {
              acc[r.status] = (acc[r.status] || 0) + 1;
              return acc;
            }, {}) || {} : {};
            
            return (
              <button 
                key={job.id}
                className="qitem" 
                data-v={verdict} 
                aria-current={selectedJobId === job.id ? "true" : "false"}
                onClick={() => setLocation(`/printscope?job=${job.id}`)}
              >
                <span className="stripe"></span>
                <span className="body flex flex-col">
                  <span className="fn">{job.filename}</span>
                  <span className="qmeta">
                    {res ? (
                      <>
                        <span className="num">{counts.fail || 0}F</span>
                        <span className="num">{counts.flag || 0}Y</span>
                        <span className="num">{counts.pass || 0}P</span>
                      </>
                    ) : (
                      <span className="uppercase text-[9px]">{job.state}</span>
                    )}
                    <span style={{ marginLeft: "auto" }}>
                      {new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        
        {jobsData && jobsData.total > 50 && (
          <div className="flex items-center justify-between p-3 border-t border-line text-xs font-semibold">
            <button 
              disabled={pageOffset === 0}
              onClick={() => setPageOffset(Math.max(0, pageOffset - 50))}
              className="text-ink-2 hover:text-accent disabled:opacity-50"
            >
              Previous
            </button>
            <span className="text-ink-3">
              {pageOffset + 1}-{Math.min(pageOffset + 50, jobsData.total)} of {jobsData.total}
            </span>
            <button 
              disabled={pageOffset + 50 >= jobsData.total}
              onClick={() => setPageOffset(pageOffset + 50)}
              className="text-ink-2 hover:text-accent disabled:opacity-50"
            >
              Next
            </button>
          </div>
        )}
      </aside>
      
      <main className="detail" id="detail">
        {!selectedJobId ? (
          <div className="flex h-full items-center justify-center text-ink-3">
            Select a file to inspect
          </div>
        ) : jobLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="animate-spin text-ink-3" />
          </div>
        ) : selectedJob ? (
          <PrintScopeDetail job={selectedJob} onReinspect={() => handleReinspect(selectedJob.id)} />
        ) : (
          <div className="flex h-full items-center justify-center text-ink-3">
            Job not found
          </div>
        )}
      </main>
    </div>
  );
}

export function PrintScopeDetail({ job, onReinspect }: { job: PrintscopeJob, onReinspect?: () => void }) {
  if (!job.result) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-ink-2">
        <h2 className="text-xl font-bold">{job.filename}</h2>
        <div className="uppercase tracking-widest text-sm font-semibold border px-4 py-2 rounded-full border-line">
          {job.state}
        </div>
        {job.state === "failed" && onReinspect && (
          <button 
            className="flex items-center gap-2 mt-4 px-4 py-2 bg-fail-bg text-fail border border-fail rounded-md font-semibold"
            onClick={onReinspect}
          >
            <RefreshCw size={16} /> Re-inspect
          </button>
        )}
        {job.error && (
          <div className="max-w-md p-4 bg-fail-bg text-fail border border-fail rounded-md text-sm font-mono mt-4">
            {JSON.stringify(job.error, null, 2)}
          </div>
        )}
      </div>
    );
  }

  const res = job.result as any;
  const comp = res.completeness || {};
  const c = res.results.reduce((acc: any, r: any) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  const words: Record<string, string> = { fail: "Send it back", flag: "Look at it", pass: "Clear to run" };
  
  const statusOrder = (s: string) => {
    const o: Record<string, number> = { fail: 0, error: 1, cannot_evaluate: 2, flag: 3, pass: 4, info: 5, not_applicable: 6, not_implemented: 7 };
    return o[s] ?? 9;
  };
  
  const LABEL: Record<string, string> = { not_applicable: "n/a", cannot_evaluate: "unverified", not_implemented: "not built", error: "error" };

  const attention = res.results.filter((r: any) => r.status === "fail" || r.status === "flag")
                               .sort((a: any, b: any) => statusOrder(a.status) - statusOrder(b.status));
  const unver = res.results.filter((r: any) => r.status === "cannot_evaluate" || r.status === "error")
                           .sort((a: any, b: any) => statusOrder(a.status) - statusOrder(b.status));
  const passed = res.results.filter((r: any) => r.status === "pass");
  const noted = res.results.filter((r: any) => r.status === "info");
  const na = res.results.filter((r: any) => r.status === "not_applicable");
  const nyb = res.results.filter((r: any) => r.status === "not_implemented");

  const RuleList = ({ rules }: { rules: any[] }) => (
    <div className="rules">
      {rules.map((r, i) => (
        <div key={i} className="rule">
          <div className={`st ${r.status}`}>{LABEL[r.status] || r.status}</div>
          <div className="rbody">
            <div><span className="rname">{r.name}</span><span className="rcode">{r.code}</span></div>
            <div className="rhead">{r.headline}</div>
            {r.detail && r.detail.length > 0 && (
              <ul className="rdet">
                {r.detail.map((d: string, di: number) => <li key={di}>{d}</li>)}
              </ul>
            )}
            {(r.status === "fail" || r.status === "flag") && r.remediation && (
              <div className="rfix">{r.remediation}</div>
            )}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <div className="banner" data-v={res.verdict} data-testid="banner-report">
        <div className="bline">
          <span className="verdict" data-testid="text-verdict">{words[res.verdict] || res.verdict}</span>
          <span className="fn" title={job.filename}>{job.filename}</span>
          <span className="tally">
            <span><b>{c.fail || 0}</b> failed</span>
            <span><b>{c.flag || 0}</b> flagged</span>
            <span><b>{c.pass || 0}</b> passed</span>
            <span><b>{c.info || 0}</b> noted</span>
          </span>
        </div>
        <details className="bmeta-fold" data-testid="details-report-meta">
          <summary>Details</summary>
          <div>
            {new Date(job.createdAt).toLocaleString().replace(',', '')}<br/>
            sha {job.sha256 ? job.sha256.substring(0,16) : ''}<br/>
            {Math.round(job.byteSize / 1024)} KB<br/>
            {job.ruleVersionId && `rules v${job.ruleVersionId}`}
          </div>
        </details>
        <div className="gaps">
        {!res.ctx?.local_underbase?.version && <div className="gap"><b>Legacy coverage check.</b><span>This result predates localized missing-underbase detection. Re-inspect before relying on its Pass result or approving archive/task actions.</span></div>}
        {comp.complete === false && (
          <div className="gap">
            <b>Not fully checked.</b>
            <span>{comp.cannot_evaluate || 0} check(s) could not be completed on this file{comp.errors ? ` and ${comp.errors} failed to run` : ""}. The verdict above covers what was checked — it is not a statement about what was not.</span>
          </div>
        )}
        
        {res.verdict === "pass" && comp.not_implemented > 0 && (
           <div className="gap" style={{ background: "var(--pass-bg)", color: "var(--pass)", borderColor: "var(--pass)" }}>
            <b>Clear to run (what was checked).</b>
            <span>The engine passed this file, but note that {comp.not_implemented} checks are not yet built.</span>
          </div>
        )}
        
        {comp.not_implemented > 0 && res.verdict !== "pass" && (
          <div className="gap" style={{ background: "var(--info-bg)", color: "var(--ink-2)", borderColor: "var(--line)" }}>
            <b>{comp.not_implemented} rule(s) not built yet.</b>
            <span>They are in the rule table but nothing evaluates them.</span>
          </div>
        )}
        
        {(res.previews || []).some((p: any) => p.choke_failed?.length > 0) && (
          <div className="gap">
            <b>Plates shown without their choke.</b>
            <span>The choke mask could not be built for this file, so the plates below are drawn at full un-choked size. Do not judge trap from these previews — the numeric checks above are unaffected.</span>
          </div>
        )}
        </div>
      </div>

      {(job as any).assetsExpiredAt ? (
        <section className="blk mt-4">
          <div className="bg-surface-2 p-4 text-center text-ink-2 text-sm border border-line rounded">
            Assets for this job have expired and were purged on {new Date((job as any).assetsExpiredAt).toLocaleDateString()}. Results and metadata remain for review history.
          </div>
        </section>
      ) : (
        <PlateViewer previews={res.previews || []} jobId={job.id} regions={res.ctx?.local_underbase?.regions || []} />
      )}

      <section className="blk">
        <div className="blkhead">
          <h2 style={{ fontSize: "15px" }}>Needs attention</h2>
          <span className="lbl">{attention.length} of {res.results.length} rules</span>
        </div>
        {attention.length > 0 ? (
          <RuleList rules={attention} />
        ) : (
          <div className="rules">
            <div className="rule">
              <div className="st pass">clear</div>
              <div className="rbody">
                <div className="rhead">Every rule that applies to this file passed.</div>
              </div>
            </div>
          </div>
        )}
      </section>

      {unver.length > 0 && (
        <section className="blk">
          <div className="blkhead">
            <h2 style={{ fontSize: "15px" }}>Could not be verified</h2>
            <span className="lbl">{unver.length} rule{unver.length === 1 ? '' : 's'}</span>
          </div>
          <RuleList rules={unver} />
        </section>
      )}

      <details className="fold">
        <summary>Passed — {passed.length}</summary>
        <RuleList rules={passed} />
      </details>
      <details className="fold">
        <summary>Reported, not judged — {noted.length}</summary>
        <RuleList rules={noted} />
      </details>
      <details className="fold">
        <summary>Does not apply to this file — {na.length}</summary>
        <RuleList rules={na} />
      </details>
      <details className="fold">
        <summary>Not built yet — {nyb.length}</summary>
        <RuleList rules={nyb} />
      </details>

      <div className="foot">
        Verdicts are the rule engine's alone — no human judgement is folded into this panel. A yellow means the rule cannot decide from the file and wants a person to look. <b>Could not be verified</b> is not a pass: those checks did not happen.
      </div>
      
      {job.result && onReinspect && (
        <div className="mt-8 pt-4 border-t border-line text-right">
          <button 
            className="flex items-center gap-2 ml-auto px-4 py-1.5 bg-surface-2 hover:bg-line text-ink-2 text-sm rounded-md font-semibold"
            onClick={onReinspect}
          >
            <RefreshCw size={14} /> Re-inspect
          </button>
        </div>
      )}
    </>
  );
}

export function PlateViewer({ previews, jobId, regions = [] }: { previews: any[], jobId: string; regions?: any[] }) {
  const [showDefects,setShowDefects] = useState(true);
  const [ab, setAb] = useState<number>(-1);
  const [zoomPct, setZoomPct] = useState<number>(100);
  const [colourPct, setColourPct] = useState<number>(100);
  const [basePct, setBasePct] = useState<number>(100);
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set());
  
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<{fx: number, fy: number} | null>(null);

  const toggleHidden = (k: string) => {
    setHiddenKeys(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const stackOrder = [...previews].sort((a, b) => 
    (b.is_underbase ? 1 : 0) - (a.is_underbase ? 1 : 0) || a.index - b.index
  );
  
  const shown = ab === -1 ? stackOrder : [previews.find(p => p.index === ab) || previews[0]];
  const maxW = Math.max(...shown.map(b => b.w || 0), 1);
  const maxH = Math.max(...shown.map(b => b.h || 0), 1);
  
  // Flatten before sorting so board grouping cannot override the ink numbers.
  const layerRows = sortPlateLayers(shown.flatMap(b => b.plates.map((p: any) =>
    ({ ...p, abIndex: b.index, abBase: b.is_underbase, wpct: 100 * (b.w || maxW) / maxW })
  )));
  
  const fallbacks = shown.reduce((n, b) => n + (b.raster_fallbacks || 0), 0);
  
  const captureFocus = useCallback(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const w = canvas.offsetWidth, h = canvas.offsetHeight;
    if (!w || !h) return;
    
    const next = focusRef.current ? { ...focusRef.current } : { fx: 0.5, fy: 0.5 };
    if (w > stage.clientWidth + 1) next.fx = (stage.scrollLeft + stage.clientWidth / 2) / w;
    if (h > stage.clientHeight + 1) next.fy = (stage.scrollTop + stage.clientHeight / 2) / h;
    focusRef.current = next;
  }, []);

  const applyFocus = useCallback(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas || !focusRef.current) return;
    const w = canvas.offsetWidth, h = canvas.offsetHeight;
    if (!w || !h) return;
    stage.scrollLeft = Math.max(0, focusRef.current.fx * w - stage.clientWidth / 2);
    stage.scrollTop  = Math.max(0, focusRef.current.fy * h - stage.clientHeight / 2);
  }, []);

  const focusOnArt = useCallback(() => {
    const bb = [1e9, 1e9, -1e9, -1e9];
    let bw = 0, bh = 0;
    shown.forEach(b => {
      if (!b.art) return;
      bw = Math.max(bw, b.w || 0); bh = Math.max(bh, b.h || 0);
      bb[0] = Math.min(bb[0], b.art[0]); bb[1] = Math.min(bb[1], b.art[1]);
      bb[2] = Math.max(bb[2], b.art[2]); bb[3] = Math.max(bb[3], b.art[3]);
    });
    focusRef.current = (bb[2] > -1e8 && bw && bh)
      ? { fx: ((bb[0] + bb[2]) / 2) / bw, fy: ((bb[1] + bb[3]) / 2) / bh }
      : { fx: 0.5, fy: 0.5 };
  }, [shown]);

  useEffect(() => {
    focusOnArt();
  }, [ab, focusOnArt]);

  useLayoutEffect(() => {
    applyFocus();
  }, [zoomPct, applyFocus]);

  const handleZoomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    captureFocus();
    setZoomPct(Number(e.target.value));
  };
  
  return (
    <section className="blk">
      <div className="blkhead">
        <h2 style={{ fontSize: "15px" }}>Plates</h2>
        <span className="lbl">{previews.length} artboard{previews.length === 1 ? '' : 's'}</span>
      </div>
      <div className="plate">
        <div className="ptools">
          <button className="tab" onClick={() => setAb(-1)} aria-pressed={ab === -1}>All stacked</button>
          {previews.map((p, i) => (
            <button key={p.index} className="tab" onClick={() => setAb(p.index)} aria-pressed={ab === p.index}>
              Artboard {p.index}{p.is_underbase ? ' · base' : ''}
            </button>
          ))}
          <span className="zoom"><span className="lbl">Colour</span>
            <input type="range" min="10" max="100" step="5" value={colourPct} onChange={e => setColourPct(Number(e.target.value))} />
            <span className="num">{colourPct}%</span>
          </span>
          <span className="zoom" style={{ marginLeft: 0 }}><span className="lbl">Base</span>
            <input type="range" min="10" max="100" step="5" value={basePct} onChange={e => setBasePct(Number(e.target.value))} />
            <span className="num">{basePct}%</span>
          </span>
          <span className="zoom"><span className="lbl">Zoom</span>
            <input type="range" min="100" max="1600" step="25" value={zoomPct} onChange={handleZoomChange} />
            <span className="num">{zoomPct}%</span>
          </span>
        </div>
        <div className="swatches">
          {layerRows.length ? layerRows.map((p, i) => {
            const first = i === 0 || layerRows[i-1].abIndex !== p.abIndex;
            const key = p.abIndex + '|' + p.ink;
            const isHidden = hiddenKeys.has(key);
            
            return (
              <span key={key} style={{ display: 'contents' }}>
                {ab === -1 && first && (
                  <>
                    {i > 0 && <span className="swsep"></span>}
                    <span className={`abtag${p.abBase ? ' base' : ''}`}>AB{p.abIndex}{p.abBase ? ' base' : ''}</span>
                  </>
                )}
                <button className="sw" aria-pressed={!isHidden} onClick={() => toggleHidden(key)}>
                  <i style={{ background: p.colour || '#888888' }}></i>{p.ink}
                </button>
              </span>
            );
          }) : <span className="lbl">no separations rendered</span>}
        </div>
        <div className="stage" id="stage" ref={stageRef}>
          <div className="canvas" id="canvas" ref={canvasRef} style={{
            width: zoomPct === 100 ? '100%' : `${zoomPct}%`,
            // Reserve the board envelope independently of which plates are visible.
            aspectRatio: `${maxW} / ${maxH}`
          }}>
            {showDefects && regions.filter(r=>ab===-1 || r.artboard===ab).map((r,i)=>{
              const board=previews.find(p=>p.index===r.artboard);
              if(!board || !Array.isArray(r.bbox)) return null;
              const [x,y,w,h]=r.bbox;
              return <div key={`defect-${i}`} title={`${r.ink}: ${r.status === "fail" ? "Missing underbase" : "Review coverage"} (${r.areaPt2} pt²)`}
                style={{position:"absolute",zIndex:20,left:`${100*x*board.w/maxW}%`,top:`${100*y*board.h/maxH}%`,
                  width:`${100*w*board.w/maxW}%`,height:`${100*h*board.h/maxH}%`,minWidth:3,minHeight:3,
                  border:`2px solid ${r.status==="fail"?"#ef4444":"#f59e0b"}`,background:"rgba(239,68,68,.15)"}} />;
            })}
            {layerRows.map((p, i) => {
              const key = p.abIndex + '|' + p.ink;
              const isHidden = hiddenKeys.has(key);
              return (
                <img 
                  key={key}
                  src={p.src} 
                  alt={`${p.ink} plate`}
                  className={p.kind === 'png' ? 'px' : 'vec'}
                  onLoad={(e) => {
                    if (i === 0) {
                      applyFocus();
                    }
                  }}
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: `${p.wpct}%`,
                    opacity: (p.abBase ? basePct : colourPct) / 100,
                    display: isHidden ? 'none' : 'block'
                  }}
                />
              );
            })}
          </div>
        </div>
        <div className="vecnote">
          {regions.length>0 && <label className="block mb-2"><input type="checkbox" checked={showDefects} onChange={e=>setShowDefects(e.target.checked)} /> Highlight underbase findings — red: missing, amber: review. Boxes locate regions, not exact contours.</label>}
          {'Swatches and layers run bottom to top by leading ink number (1, 2, 10); underbase stays beneath colour. Unnumbered inks follow in name order. '}
          {ab === -1 
            ? 'All artboards share this order. Fade the colour to read the trap: base pulled inside the colour edge is a choke, colour sitting proud of the base is a spread. '
            : 'Vector plates, in each ink\'s true colour. '
          }
          {shown.some(b => b.choked) ? 'Zero-ink knockout strokes are carved out, so the plates match what the RIP burns. ' : ''}
          {fallbacks > 0 
            ? `${fallbacks} plate(s) too dense for vector — shown at 600 dpi, so they soften at high zoom.`
            : 'Sharp at any zoom.'
          }
        </div>
      </div>
    </section>
  );
}
