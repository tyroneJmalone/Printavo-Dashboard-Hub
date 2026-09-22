import { useState, useRef, useMemo, useEffect, useLayoutEffect, useCallback } from "react";
import { useLocation, useSearch } from "wouter";
import { 
  useListPrintscopeJobs, 
  getListPrintscopeJobsQueryKey,
  useGetPrintscopeJob,
  getGetPrintscopeJobQueryKey,
  useCreatePrintscopeUpload,
  useCompletePrintscopeUpload,
  useReinspectPrintscopeJob,
  PrintscopeCapabilities,
  PrintscopeJob
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, UploadCloud, RefreshCw } from "lucide-react";

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
  const [uploadingState, setUploadingState] = useState<{status: string, error?: string}>({ status: "idle" });
  const [retryFile, setRetryFile] = useState<File | null>(null);

  const createUpload = useCreatePrintscopeUpload();
  const completeUpload = useCompletePrintscopeUpload();

  const handleUpload = async (file: File) => {
    try {
      setUploadingState({ status: "reserving" });
      setRetryFile(file);
      
      const { job, uploadURL } = await createUpload.mutateAsync({
        data: {
          filename: file.name,
          byteSize: file.size,
          contentType: file.type || "application/pdf"
        }
      });
      
      setLocation(`/printscope?job=${job.id}`);
      
      setUploadingState({ status: "uploading" });
      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/pdf" },
        body: file
      });
      
      if (!putRes.ok) {
        throw new Error("Failed to upload file to storage.");
      }
      
      setUploadingState({ status: "completing" });
      await completeUpload.mutateAsync({ id: job.id });
      
      setUploadingState({ status: "idle" });
      queryClient.invalidateQueries({ queryKey: getListPrintscopeJobsQueryKey({ limit: 50, offset: pageOffset }) });
      queryClient.invalidateQueries({ queryKey: getGetPrintscopeJobQueryKey(job.id) });
    } catch (e: any) {
      setUploadingState({ status: "error", error: e.message || "Upload failed." });
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (file.size > caps.maxUploadBytes) {
        alert(`File is too large. Maximum size is ${Math.round(caps.maxUploadBytes / 1024 / 1024)}MB.`);
        return;
      }
      handleUpload(file);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

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
              accept=".ai,.pdf" 
              ref={fileInputRef} 
              className="hidden" 
              onChange={handleFileChange}
            />
            {uploadingState.status === "error" && retryFile && (
              <button 
                className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded border border-red-200"
                onClick={() => handleUpload(retryFile)}
                title={uploadingState.error}
              >
                Retry {retryFile.name.substring(0, 10)}...
              </button>
            )}
            <button 
              className="flex items-center gap-1 text-xs bg-slate-800 text-white px-2 py-1 rounded hover:bg-slate-700"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingState.status !== "idle" && uploadingState.status !== "error"}
            >
              {uploadingState.status !== "idle" && uploadingState.status !== "error" ? <Loader2 size={12} className="animate-spin" /> : <UploadCloud size={12} />}
              Upload
            </button>
          </div>
        </div>
        
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

function PrintScopeDetail({ job, onReinspect }: { job: PrintscopeJob, onReinspect: () => void }) {
  if (!job.result) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-ink-2">
        <h2 className="text-xl font-bold">{job.filename}</h2>
        <div className="uppercase tracking-widest text-sm font-semibold border px-4 py-2 rounded-full border-line">
          {job.state}
        </div>
        {job.state === "failed" && (
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
      <div className="banner" data-v={res.verdict}>
        <div>
          <div className="verdict">{words[res.verdict] || res.verdict}</div>
          <div className="fn" style={{ marginTop: "4px", fontSize: "14px" }}>{job.filename}</div>
          <div className="tally">
            <span><b>{c.fail || 0}</b> failed</span>
            <span><b>{c.flag || 0}</b> flagged</span>
            <span><b>{c.pass || 0}</b> passed</span>
            <span><b>{c.info || 0}</b> noted</span>
          </div>
        </div>
        <div className="bmeta">
          {new Date(job.createdAt).toLocaleString().replace(',', '')}<br/>
          sha {job.sha256 ? job.sha256.substring(0,16) : ''}<br/>
          {Math.round(job.byteSize / 1024)} KB<br/>
          {job.ruleVersionId && `rules v${job.ruleVersionId}`}
        </div>
        
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

      <PlateViewer previews={res.previews || []} jobId={job.id} />

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
      
      {job.result && (
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

function PlateViewer({ previews, jobId }: { previews: any[], jobId: string }) {
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
  
  const layerRows: any[] = [];
  shown.forEach(b => b.plates.forEach((p: any) => 
    layerRows.push({ ...p, abIndex: b.index, abBase: b.is_underbase, wpct: 100 * (b.w || maxW) / maxW })
  ));
  
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
          <div className="canvas" id="canvas" ref={canvasRef} style={{ width: zoomPct === 100 ? '100%' : `${zoomPct}%` }}>
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
          {ab === -1 
            ? 'All artboards stacked in print order — underbase underneath. Fade the colour to read the trap: base pulled inside the colour edge is a choke, colour sitting proud of the base is a spread. '
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
