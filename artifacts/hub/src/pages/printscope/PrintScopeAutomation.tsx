import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetSepscopeAutomation, getGetSepscopeAutomationQueryKey,
  useUpdateSepscopeAutomation, useScanSepscopeAutomation,
  usePreviewSepscopeActions, useApproveSepscopeActions, previewSepscopeActions,
} from "@workspace/api-client-react";
import { Loader2, Info, X, RefreshCw, Plus, AlertTriangle, FolderOpen } from "lucide-react";
import { useStaff } from "@/components/auth/StaffGate";
import { automationLogText } from "./automationLog";
import { ScanRunHistory } from "./ScanRunHistory";

type Settings = { version: number; enabled: boolean; times: string[]; weekdays: number[]; timezone: string; email: string; automaticActions: boolean; allowedStatusIds: string[]; settleMinutes: number; addedAfter: string; restrictedTestMode: boolean; automaticSince?: string | null };
type Item = { id: string; orderId: string; visualId: string | number; customerName: string | null; filename: string; jobId: string | null; state: string; verdict: string | null; error: string | null; createdAt: string };
type Run = { id: string; state: string; detail: unknown; createdAt: string };
type Action = { id: string; orderId: string; decision: string; state: string; detail: unknown; createdAt: string };
type Email = { id: string; state: string; error: string | null; createdAt: string };
type Data = { settings: Settings; environment: string; statuses: { id: string; name: string }[]; items: Item[]; runs: Run[]; actions: Action[]; emails: Email[]; limitations: string[] };
type Preview = { token: string; orderId: string; visualId: string | number; customerName: string | null; statusName: string | null; files: { id: string; name: string; jobId: string | null; state: string; verdict: string | null; error?: string }[]; task: { id: string; name: string; completed: boolean } | null; folder: { path: string; id: string } | null; blockers: string[]; canPass: boolean; canFail: boolean; testMode: boolean; emailRecipient: string; printImprints: number | null; completeness: string };

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const when = (s: string) => { const d = new Date(s); return isNaN(+d) ? s : d.toLocaleString(); };
const errMsg = (e: unknown) => {
  const x = e as { status?: number; message?: string; data?: { error?: string; message?: string } } | null;
  return x?.data?.error || x?.data?.message || x?.message || "Request failed";
};
const NOT_INSPECTED = new Set(["unavailable", "skipped", "processing", "queued", "pending", "uploading"]);

function Chip({ tone, children }: { tone: "fail" | "flag" | "pass" | "muted"; children: React.ReactNode }) {
  const cls = tone === "fail" ? "bg-fail-bg text-fail" : tone === "flag" ? "bg-flag-bg text-flag" : tone === "pass" ? "bg-pass-bg text-pass" : "bg-slate-200 text-slate-700";
  return <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider whitespace-nowrap ${cls}`}>{children}</span>;
}
const stateTone = (s: string): "fail" | "flag" | "pass" | "muted" =>
  /fail|error/.test(s) ? "fail" : /review|partial|unavail|skip/.test(s) ? "flag" : /complete|sent|pass|ok|success/.test(s) ? "pass" : "muted";

export function PrintScopeAutomation() {
  const { role } = useStaff();
  const isAdmin = role === "admin";
  const { data: raw, isLoading, error, refetch, isFetching } = useGetSepscopeAutomation({
    query: { queryKey: getGetSepscopeAutomationQueryKey(), refetchInterval: 15_000 },
  });
  const data = raw as unknown as Data | undefined;
  const [reviewOrder, setReviewOrder] = useState<string | null>(null);

  if (isLoading) return (
    <div className="p-6 space-y-3" style={{ height: "calc(100% - 48px)" }}>
      {[0, 1, 2, 3].map(i => <div key={i} className="h-16 rounded bg-surface-2 animate-pulse" />)}
    </div>
  );
  if (error || !data?.settings) return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center" style={{ height: "calc(100% - 48px)" }}>
      <AlertTriangle className="text-fail" />
      <p className="font-semibold">Scheduled inspection data could not be loaded.</p>
      <p className="text-sm text-ink-3 max-w-md">{error ? errMsg(error) : "The server returned no settings."}</p>
      <button className="border border-line rounded px-4 py-2 text-sm font-semibold" onClick={() => refetch()}>Retry</button>
    </div>
  );

  const inspected = data.items.filter(i => !NOT_INSPECTED.has(i.state) && i.state !== "error");
  const failed = inspected.filter(i => i.verdict === "fail");
  const pending = data.items.filter(i => NOT_INSPECTED.has(i.state));
  const errored = data.items.filter(i => i.state === "error" || (i.error && !NOT_INSPECTED.has(i.state)));
  const orders = Array.from(new Map(data.items.map(i => [i.orderId, i])).values());

  return (
    <div className="overflow-y-auto" style={{ height: "calc(100% - 48px)" }}>
      <div className="max-w-6xl mx-auto p-4 md:p-6 flex flex-col gap-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-xl font-bold">Scheduled output inspection</h2>
            <p className="text-sm text-ink-2 mt-1 max-w-2xl">SepScope checks Printavo OUTPUT files on a schedule. Staff review each invoice with live evidence before any status change. Nothing here sends a job back or clears it without a person confirming, unless automatic failures are switched on.</p>
          </div>
          <button className="flex items-center gap-2 text-xs font-semibold text-ink-2 border border-line rounded px-3 py-1.5" onClick={() => refetch()}>
            <RefreshCw size={13} className={isFetching ? "animate-spin" : ""} /> Refreshes every 15s
          </button>
        </div>

        {data.limitations.length > 0 && (
          <div className="border border-line bg-surface-2 rounded p-3 text-xs text-ink-2">
            <strong className="uppercase tracking-wider text-[10px] text-ink-1 mr-2">Limitations</strong>
            <ul className="list-disc pl-5 mt-1 space-y-0.5">{data.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul>
          </div>
        )}

        <SettingsPanel data={data} isAdmin={isAdmin} />

        <section>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            <Stat label="Failed inspection" value={failed.length} tone="fail" note="engine verdict: send it back" />
            <Stat label="Inspected" value={inspected.length} tone="pass" note="engine produced a verdict" />
            <Stat label="Not inspected yet" value={pending.length} tone="muted" note="processing, skipped or unavailable" />
            <Stat label="Errors" value={errored.length} tone="flag" note="could not be inspected" />
          </div>
          <h3 className="font-bold text-sm mb-2">Invoices found by scans</h3>
          {orders.length === 0 ? (
            <div className="border border-dashed border-line rounded p-8 text-center text-sm text-ink-3">
              No OUTPUT files have been picked up yet. Scans only look at invoices in the eligible source statuses chosen above.
            </div>
          ) : (
            <div className="border border-line rounded overflow-hidden bg-[var(--surface)]">
              {orders.map(o => {
                const files = data.items.filter(i => i.orderId === o.orderId);
                return (
                  <div key={o.orderId} className="border-b border-line last:border-b-0 p-3 flex flex-col md:flex-row gap-3 md:items-start">
                    <div className="md:w-56 shrink-0">
                      <div className="font-semibold">#{o.visualId}</div>
                      <div className="text-xs text-ink-3 truncate">{o.customerName || "Unknown customer"}</div>
                    </div>
                    <ul className="flex-1 min-w-0 space-y-1">
                      {files.map(f => (
                        <li key={f.id} className="flex items-center gap-2 text-[13px] flex-wrap">
                          <FileBadge state={f.state} verdict={f.verdict} />
                          {f.jobId ? <Link href={`/printscope?job=${f.jobId}`} className="font-mono truncate underline decoration-dotted">{f.filename}</Link> : <span className="font-mono truncate">{f.filename}</span>}
                          {f.error && <span className="text-xs text-fail">{f.error}</span>}
                        </li>
                      ))}
                    </ul>
                    <button className="bg-slate-800 text-white text-xs font-semibold rounded px-3 py-2 shrink-0 hover:bg-slate-700" onClick={() => setReviewOrder(o.orderId)}>Review invoice</button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <details className="border border-[var(--line)] rounded p-3 bg-[var(--surface)]">
          <summary className="cursor-pointer font-semibold text-sm">Failed inspections ({failed.length})</summary>
          <p className="text-xs text-[var(--ink-3)] my-2">Files with a failed inspection verdict in the recent intake list. Open a file to view its findings.</p>
          {!failed.length ? <p className="text-xs">No failed inspections in the recent intake list.</p> :
            <ul className="space-y-2 text-sm">{failed.map(f=><li key={f.id}>
              <span className="font-semibold">Invoice #{f.visualId} · </span>
              {f.jobId ? <Link className="underline break-words" href={`/printscope?job=${f.jobId}`}>{f.filename}</Link> : f.filename}
            </li>)}</ul>}
        </details>
        <div className="grid md:grid-cols-3 gap-4">
          <ScanRunHistory runs={data.runs} />
          <LogList title="Status actions" empty="No actions recorded." rows={data.actions.map(a => ({ id: a.id, state: a.state, text: [a.decision.toUpperCase(), `order ${a.orderId}`, automationLogText(a.detail)].filter(Boolean).join(" · "), at: a.createdAt }))} />
          <LogList title="Notification emails" empty="No emails sent." rows={data.emails.map(e => ({ id: e.id, state: e.state, text: e.error, at: e.createdAt }))} />
        </div>
      </div>
      {reviewOrder && <ReviewDialog orderId={reviewOrder} onClose={() => setReviewOrder(null)} />}
    </div>
  );
}

function FileBadge({ state, verdict }: { state: string; verdict: string | null }) {
  if (NOT_INSPECTED.has(state)) return <Chip tone="muted">{state}</Chip>;
  if (state === "error") return <Chip tone="flag">error</Chip>;
  if (verdict) return <Chip tone={verdict === "fail" ? "fail" : verdict === "pass" ? "pass" : "flag"}>{verdict}</Chip>;
  return <Chip tone="muted">{state}</Chip>;
}

function Stat({ label, value, tone, note }: { label: string; value: number; tone: string; note: string }) {
  return (
    <div className="border border-line rounded p-3 bg-[var(--surface)]" style={{ borderLeft: `4px solid var(--${tone === "muted" ? "ink-3" : tone})` }}>
      <div className="text-[10px] uppercase font-bold tracking-wider text-ink-3">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-[11px] text-ink-3">{note}</div>
    </div>
  );
}

function LogList({ title, empty, rows }: { title: string; empty: string; rows: { id: string; state: string; text: string | null; at: string }[] }) {
  return (
    <section className="border border-line rounded bg-[var(--surface)]">
      <h3 className="font-bold text-sm p-3 border-b border-line">{title}</h3>
      {rows.length === 0 ? <p className="p-4 text-xs text-ink-3">{empty}</p> : (
        <ul className="max-h-72 overflow-y-auto">
          {rows.map(r => (
            <li key={r.id} className="p-3 border-b border-line last:border-b-0 text-xs">
              <div className="flex items-center gap-2"><Chip tone={stateTone(r.state)}>{r.state.replace(/_/g, " ")}</Chip><span className="text-ink-3 ml-auto">{when(r.at)}</span></div>
              {r.text && <p className={`mt-1 whitespace-pre-wrap break-words ${stateTone(r.state) === "fail" ? "text-fail" : "text-ink-2"}`}>{r.text}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SettingsPanel({ data, isAdmin }: { data: Data; isAdmin: boolean }) {
  const qc = useQueryClient();
  const update = useUpdateSepscopeAutomation();
  const scan = useScanSepscopeAutomation();
  const [form, setForm] = useState<Settings>(data.settings);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [tip, setTip] = useState(false);
  const versionRef = useRef(data.settings.version);

  useEffect(() => {
    if (!dirty || versionRef.current !== data.settings.version) {
      versionRef.current = data.settings.version;
      if (!dirty) setForm(data.settings);
    }
  }, [data.settings, dirty]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => { setForm(f => ({ ...f, [k]: v })); setDirty(true); };
  const ro = !isAdmin;
  const noStatuses = form.allowedStatusIds.length === 0;

  const save = async () => {
    setMsg(null);
    try {
      const res = await update.mutateAsync({ data: {
        version: form.version, enabled: form.enabled, times: form.times, weekdays: [...form.weekdays].sort(),
        timezone: form.timezone, email: form.email, automaticActions: form.automaticActions,
        allowedStatusIds: form.allowedStatusIds, settleMinutes: Number(form.settleMinutes),
        addedAfter: form.addedAfter,
        restrictedTestMode: form.restrictedTestMode,
      } });
      setDirty(false);
      const next = (res as unknown as Data)?.settings;
      if (next) setForm(next);
      qc.invalidateQueries({ queryKey: getGetSepscopeAutomationQueryKey() });
      setMsg({ ok: true, text: "Settings saved." });
    } catch (e) {
      const status = (e as { status?: number })?.status;
      setMsg({ ok: false, text: status === 409 ? "Someone else changed these settings. Reload to see the saved version before editing again." : errMsg(e) });
    }
  };
  const runScan = async () => {
    setMsg(null);
    try {
      await scan.mutateAsync();
      qc.invalidateQueries({ queryKey: getGetSepscopeAutomationQueryKey() });
      setMsg({ ok: true, text: "Scan started. Results appear below as files are inspected." });
    } catch (e) { setMsg({ ok: false, text: errMsg(e) }); }
  };

  const input = "border border-[var(--line-2)] rounded px-2 py-1.5 text-sm bg-[var(--surface-2)] text-[var(--ink)] [color-scheme:dark] placeholder:text-[var(--ink-3)] disabled:text-[var(--ink-2)] disabled:opacity-75";
  return (
    <section className="border border-line rounded bg-surface-1">
      <div className="flex items-center justify-between p-3 border-b border-line flex-wrap gap-2">
        <h3 className="font-bold text-sm">Schedule and safety</h3>
        {!isAdmin && <span className="text-xs text-ink-3">Read only. Admins change the schedule and run scans.</span>}
      </div>
      <div className="p-4 grid md:grid-cols-2 gap-5">
        {data.environment==="development" && <div className="md:col-span-2 border border-amber-600 rounded p-3 text-sm">
          <label className="flex gap-2 font-semibold"><input type="checkbox" disabled={ro} checked={form.restrictedTestMode}
            onChange={e=>{setForm(f=>({...f,restrictedTestMode:e.target.checked,enabled:false,automaticActions:false}));setDirty(true);}} />
            Restricted live-test mode — invoices #20625 and #23450 only</label>
          <p className="text-xs mt-2">Real Printavo, email and Dropbox actions, individually confirmed by an administrator. Saving this mode disables scheduled scans and automatic actions. Scan now is limited to #20625 and #23450. All current OUTPUT files must be explicitly selected as test files before an action. No action runs merely by enabling this mode.</p>
        </div>}
        <div className="flex flex-col gap-4">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" disabled={ro || form.restrictedTestMode} checked={form.enabled} onChange={e => set("enabled", e.target.checked)} /> Scheduled scans enabled
          </label>
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-ink-3 mb-1">Run times ({form.timezone})</div>
            <div className="flex flex-wrap gap-2">
              {form.times.map((t, i) => (
                <span key={i} className="flex items-center gap-1">
                  <input type="time" disabled={ro} className={input} value={t} onChange={e => set("times", form.times.map((x, j) => j === i ? e.target.value : x))} />
                  {!ro && form.times.length > 1 && <button aria-label="Remove time" className="text-ink-3 hover:text-fail" onClick={() => set("times", form.times.filter((_, j) => j !== i))}><X size={14} /></button>}
                </span>
              ))}
              {!ro && <button className="flex items-center gap-1 text-xs font-semibold border border-line rounded px-2" onClick={() => set("times", [...form.times, "12:00"])}><Plus size={12} /> Add time</button>}
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-ink-3 mb-1">Weekdays</div>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((d, i) => {
                const on = form.weekdays.includes(i);
                return <button key={d} disabled={ro} aria-pressed={on} onClick={() => set("weekdays", on ? form.weekdays.filter(x => x !== i) : [...form.weekdays, i])}
                  className={`px-2.5 py-1 rounded text-xs font-semibold border ${on ? "bg-slate-800 text-white border-slate-800" : "border-line text-ink-2"}`}>{d}</button>;
              })}
            </div>
          </div>
          <div className="flex gap-3 flex-wrap">
            <label className="flex flex-col text-[10px] uppercase font-bold tracking-wider text-ink-3 gap-1">Added After
              <input type="date" required disabled={ro} className={input} value={form.addedAfter} onChange={e => set("addedAfter", e.target.value)} /></label>
            <label className="flex flex-col text-[10px] uppercase font-bold tracking-wider text-ink-3 gap-1">Timezone
              <input disabled={ro} className={input} value={form.timezone} onChange={e => set("timezone", e.target.value)} /></label>
            <label className="flex flex-col text-[10px] uppercase font-bold tracking-wider text-ink-3 gap-1">Settle minutes
              <input type="number" min={0} max={120} disabled={ro} className={`${input} w-24`} value={form.settleMinutes} onChange={e => set("settleMinutes", Number(e.target.value))} /></label>
            <p className="text-xs text-ink-3">0 = no settling delay. Staff approval and file-change checks still apply.</p>
          </div>
          <p className="text-xs text-ink-2">Only files added on or after this date in {form.timezone} are downloaded for inspection. Applies to every scan until changed; older files and files without an upload date are skipped.</p>
          <label className="flex flex-col text-[10px] uppercase font-bold tracking-wider text-ink-3 gap-1">Summary email
            <input type="email" disabled={ro} className={input} value={form.email} onChange={e => set("email", e.target.value)} /></label>
        </div>
        <div className="flex flex-col gap-4">
          <div>
            <div className="text-[10px] uppercase font-bold tracking-wider text-ink-3 mb-1">Eligible source statuses</div>
            <p className="text-xs text-ink-2 mb-2">Scans only touch invoices currently in these Printavo statuses. Pick them explicitly so historic, shipped and completed jobs are never inspected or moved. With none selected, scans do not run.</p>
            {noStatuses && <p className="text-xs font-semibold text-flag mb-2">No source statuses selected. Scans are blocked until at least one is chosen.</p>}
            <div className="max-h-48 overflow-y-auto border border-line rounded bg-[var(--surface-2)] text-[var(--ink)] [color-scheme:dark] p-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
              {data.statuses.length === 0 && <span className="text-xs text-ink-3">No Printavo statuses available.</span>}
              {data.statuses.map(s => (
                <label key={s.id} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" disabled={ro} checked={form.allowedStatusIds.includes(s.id)}
                    onChange={e => set("allowedStatusIds", e.target.checked ? [...form.allowedStatusIds, s.id] : form.allowedStatusIds.filter(x => x !== s.id))} />
                  {s.name}
                </label>
              ))}
            </div>
          </div>
          <div className="relative">
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" disabled={ro || form.restrictedTestMode} checked={form.automaticActions} onChange={e => set("automaticActions", e.target.checked)} /> Automatic failure actions
              <button type="button" aria-label="About automatic actions" onMouseEnter={() => setTip(true)} onMouseLeave={() => setTip(false)} onFocus={() => setTip(true)} onBlur={() => setTip(false)} className="text-ink-3"><Info size={14} /></button>
            </label>
            {tip && (
              <div role="tooltip" className="absolute z-10 mt-1 w-80 bg-slate-800 text-white text-xs rounded p-3 shadow-lg">
                Applies only to new, confirmed engine failures on invoices in eligible source statuses. Passes always require a staff member to confirm all output files are present until the file-count policy is verified. The existing backlog is never released automatically.
              </div>
            )}
            {form.automaticSince && <p className="text-xs text-ink-3 mt-1">Automatic since {when(form.automaticSince)}. Earlier files stay manual.</p>}
          </div>
        </div>
      </div>
      {isAdmin && (
        <div className="flex items-center gap-3 p-3 border-t border-line flex-wrap">
          <button disabled={!dirty || update.isPending} onClick={save} className="bg-slate-800 text-white px-4 py-2 rounded text-sm font-semibold disabled:opacity-50 flex items-center gap-2">
            {update.isPending && <Loader2 size={14} className="animate-spin" />} Save settings</button>
          {dirty && <button className="text-sm text-ink-2" onClick={() => { setForm(data.settings); setDirty(false); }}>Discard</button>}
          <button disabled={scan.isPending || noStatuses || dirty} onClick={runScan} title={noStatuses ? "Choose eligible source statuses first" : dirty ? "Save settings first" : undefined}
            className="border border-line px-4 py-2 rounded text-sm font-semibold disabled:opacity-50 flex items-center gap-2 ml-auto">
            {scan.isPending && <Loader2 size={14} className="animate-spin" />} Scan now</button>
          {msg && <span role={msg.ok ? "status" : "alert"} className={`text-sm font-semibold w-full ${msg.ok ? "text-pass" : "text-fail"}`}>{msg.text}</span>}
        </div>
      )}
    </section>
  );
}

function ReviewDialog({ orderId, onClose }: { orderId: string; onClose: () => void }) {
  const {role}=useStaff();
  const qc = useQueryClient();
  const preview = usePreviewSepscopeActions({mutation:{
    mutationFn: ({orderId}) => previewSepscopeActions(orderId,{signal:AbortSignal.timeout(90_000)}),
  }});
  const approve = useApproveSepscopeActions();
  const [p, setP] = useState<Preview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [decision, setDecision] = useState<"pass" | "fail" | "email" | null>(null);
  const [selectedFiles,setSelectedFiles]=useState<string[]>([]);
  const [complete, setComplete] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const previewRef = useRef(preview.mutateAsync);
  const loadSequence = useRef(0);
  previewRef.current = preview.mutateAsync;

  const load = async () => {
    const sequence=++loadSequence.current;
    setLoadErr(null);
    setP(null); setDecision(null); setComplete(false); setConfirmed(false);
    setSelectedFiles([]);
    try {
      const value=await previewRef.current({ orderId }) as unknown as Preview;
      if(sequence!==loadSequence.current) return;
      if(!value || !Array.isArray(value.files) || !Array.isArray(value.blockers)) throw new Error("The server returned an incomplete invoice preview. Please retry.");
      setP(value);
    }
    catch (e) { if(sequence===loadSequence.current) {
      setP(null); setLoadErr(e instanceof Error && /timeout|abort/i.test(e.name)
        ? "The live review took too long. No invoice changes were made. Please retry." : errMsg(e));
    }}
  };
  useEffect(() => { load(); setDecision(null); setComplete(false); setConfirmed(false); // eslint-disable-next-line react-hooks/exhaustive-deps
    return ()=>{loadSequence.current++;};
  }, [orderId]);

  const submit = async () => {
    if (!p || !decision) return;
    setResult(null);
    try {
      const res = (await approve.mutateAsync({ orderId, data: { token: p.token, decision, confirmComplete: decision === "pass" ? complete : false, note, testMode:p.testMode,selectedFileIds:p.testMode?selectedFiles:undefined } })) as unknown as { action: { state: string; detail: unknown } };
      qc.invalidateQueries({ queryKey: getGetSepscopeAutomationQueryKey() });
      const st = res?.action?.state;
      const detail=automationLogText(res?.action?.detail);
      setResult({ ok: st === "completed", text: st === "completed" ? `Recorded: ${decision.toUpperCase()}. ${detail ?? ""}` : `Needs review: ${detail ?? "The server could not confirm the status change. Check Printavo before trying again."}` });
      setDecision(null); setConfirmed(false);
    } catch (e) {
      if ((e as { status?: number })?.status === 409) {
        setResult({ ok: false, text: "This invoice changed since the preview. Fresh evidence has been loaded. Review it and confirm again if still correct." });
        setConfirmed(false); setComplete(false);
        await load();
      } else setResult({ ok: false, text: errMsg(e) });
    }
  };

  const canSubmit = !!p && !!decision && confirmed && !preview.isPending && !approve.isPending &&
    (!p.testMode || (role==="admin" && ["20625","23450"].includes(String(p.visualId)) && p.files.length>0 && selectedFiles.length===p.files.length)) &&
    (decision === "pass" ? p.canPass && complete : p.canFail);

  return (
    <div className="fixed inset-0 z-[80] bg-slate-900/70 flex items-center justify-center p-3" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Invoice review" className="bg-slate-900 text-slate-100 border border-slate-700 rounded-lg w-full max-w-2xl min-h-48 max-h-[92dvh] overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-line sticky top-0 bg-[var(--surface)]">
          <h3 className="font-bold">Invoice review{p ? ` · #${p.visualId}` : ""}</h3>
          <button aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="p-4 flex flex-col gap-4 text-sm">
          {!p && !loadErr && <div role="status" className="flex items-start gap-3 rounded bg-slate-800 text-slate-100 p-4">
            <Loader2 className="animate-spin shrink-0" size={20} />
            <div><p className="font-semibold">Loading live invoice review…</p>
              <p className="text-xs mt-1 text-slate-300">Checking Printavo files, inspection results and Dropbox. This may take a little while. No invoice changes are being made.</p></div>
          </div>}
          {loadErr && (
            <div role="alert" className="border border-fail bg-fail-bg rounded p-3">
              <p className="font-semibold text-fail">Live preview failed</p><p className="text-xs mt-1">{loadErr}</p>
              <button className="underline text-xs mt-2" onClick={load}>Retry</button>
            </div>
          )}
          {p && (
            <>
              {p.testMode && <div className="border border-amber-500 bg-amber-950 text-amber-100 rounded p-3 text-xs space-y-2">
                <strong>RESTRICTED LIVE TEST — invoice #{p.visualId}</strong>
                <p>These are real actions. Status changes may trigger Printavo’s own notifications. Verify those automations before confirming.</p>
                <p>Email recipient: <strong>{p.emailRecipient}</strong>. The email test sends a [TEST] failure notification only.</p>
                <p>Pass: copy selected OUTPUT files to <strong>{p.folder?.path ?? "unresolved Dropbox folder"}</strong>, verify each copy, remove those attachments from Printavo, then complete the prep task. No folders are created. Keep backup copies before confirming.</p>
                <p>Failure: change status to PRINT ERROR - REVIEW only; task and attachments remain unchanged.</p>
                {role!=="admin" && <p>Only administrators may execute live tests.</p>}
              </div>}
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-2">
                <span>Customer: <strong className="text-ink-1">{p.customerName || "Unknown"}</strong></span>
                <span>Status: <strong className="text-ink-1">{p.statusName || "Unknown"}</strong></span>
                <span>Print imprints: <strong className="text-ink-1">{p.printImprints ?? "not recorded"}</strong></span>
                <button className="flex items-center gap-1 underline" onClick={load} disabled={preview.isPending}><RefreshCw size={11} className={preview.isPending ? "animate-spin" : ""} /> Refresh preview</button>
              </div>
              <div>
                <h4 className="text-[10px] uppercase font-bold tracking-wider text-ink-3 mb-1">Output files ({p.files.length})</h4>
                {p.files.length === 0 ? <p className="text-xs text-ink-3">No output files found.</p> : (
                  <ul className="border border-line rounded divide-y divide-[var(--line)]">
                    {p.files.map(f => (
                      <li key={f.id} className="p-2 flex items-center gap-2 text-[13px] flex-wrap">
                        {p.testMode && <label className="flex gap-1 text-xs"><input type="checkbox" disabled={role!=="admin" || approve.isPending} checked={selectedFiles.includes(f.id)}
                          onChange={e=>{setSelectedFiles(ids=>e.target.checked?[...ids,f.id]:ids.filter(id=>id!==f.id));setConfirmed(false);}} />Test file</label>}
                        <FileBadge state={f.state} verdict={f.verdict} />
                        <span className="font-mono truncate flex-1">{f.name}</span>
                        {f.jobId && <Link href={`/printscope?job=${f.jobId}`} className="text-xs underline shrink-0" onClick={onClose}>Findings</Link>}
                        {f.error && <p className="w-full text-xs text-red-300 break-words">Not inspected: {f.error}</p>}
                        {f.state==="not_inspected" && <p className="w-full text-xs text-slate-300">No inspection is recorded for this file version. Run a scan to queue it.</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="grid sm:grid-cols-2 gap-3 text-xs">
                <div className="border border-line rounded p-2">
                  <div className="text-[10px] uppercase font-bold tracking-wider text-ink-3">Dropbox folder</div>
                  {p.folder ? <span className="flex items-center gap-1 mt-1 font-mono break-all"><FolderOpen size={12} className="shrink-0" />{p.folder.path}</span> : <span className="text-ink-3">No linked folder</span>}
                </div>
                <div className="border border-line rounded p-2">
                  <div className="text-[10px] uppercase font-bold tracking-wider text-ink-3">Printavo task</div>
                  {p.task ? <span className="mt-1 block">{p.task.name} · {p.task.completed ? "completed" : "open"}</span> : <span className="text-ink-3">No matching task</span>}
                </div>
              </div>
              <p className="text-xs text-ink-2">Completeness: <strong>{p.completeness}</strong>. File count is not verified automatically yet.</p>
              {p.blockers.length > 0 && (
                <div className="border border-flag bg-flag-bg rounded p-3">
                  <p className="font-semibold text-flag text-xs uppercase tracking-wider">Blockers</p>
                  <ul className="list-disc pl-5 text-xs mt-1 space-y-0.5">{p.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul>
                </div>
              )}
              <p className="text-xs bg-surface-2 border border-line rounded p-2">Approving changes this invoice's Printavo status. If that status has customer or staff notifications configured in Printavo, Printavo may send those emails as a result.</p>

              <div className="border-t border-line pt-3 flex flex-col gap-3">
                <div className="flex gap-2">
                  <button disabled={!p.canPass} onClick={() => { setDecision("pass"); setConfirmed(false); }} className={`flex-1 py-2 rounded font-semibold border ${decision === "pass" ? "bg-pass text-white border-pass" : "border-line"} disabled:opacity-40`}>Clear to run</button>
                  <button disabled={!p.canFail} onClick={() => { setDecision("fail"); setConfirmed(false); }} className={`flex-1 py-2 rounded font-semibold border ${decision === "fail" ? "bg-fail text-white border-fail" : "border-line"} disabled:opacity-40`}>Send it back</button>
                  {p.testMode && <button disabled={!p.canFail || role!=="admin"} onClick={()=>{setDecision("email");setConfirmed(false);}}
                    className="flex-1 py-2 rounded font-semibold border border-amber-500 disabled:opacity-40">Test failure email</button>}
                </div>
                {!p.canPass && !p.canFail && <p className="text-xs text-ink-3">No action is available for this invoice right now. See blockers above.</p>}
                {decision === "pass" && (
                  <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={complete} onChange={e => setComplete(e.target.checked)} className="mt-0.5" />
                    I checked that ALL required output files for this invoice are present. (The artwork approval part of the task is not part of this check.)</label>
                )}
                {decision && (
                  <>
                    <textarea maxLength={2000} value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)" className="border border-[var(--line-2)] rounded p-2 text-sm h-16 bg-[var(--surface-2)] text-[var(--ink)] placeholder:text-[var(--ink-3)] [color-scheme:dark]" />
                    <label className="flex items-start gap-2 text-xs font-semibold"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} className="mt-0.5" />
                      I confirm: {decision === "email" ? `send a real test failure email to ${p.emailRecipient}` : decision === "pass" ? "archive the reviewed files, remove their Printavo attachments and complete the prep task" : "change this invoice to PRINT ERROR - REVIEW"}{p.testMode ? ` for test invoice #${p.visualId}. I verified the test files, backups and notification side effects.` : "."}</label>
                    <button disabled={!canSubmit} onClick={submit} className="bg-slate-800 text-white py-2 rounded font-semibold disabled:opacity-40 flex items-center justify-center gap-2">
                      {approve.isPending && <Loader2 size={14} className="animate-spin" />} Approve {decision}</button>
                  </>
                )}
                {result && <p role={result.ok ? "status" : "alert"} className={`text-sm font-semibold ${result.ok ? "text-pass" : "text-fail"}`}>{result.text}</p>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
