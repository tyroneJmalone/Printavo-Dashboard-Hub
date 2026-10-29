import { automationLogText } from "./automationLog";

type Entry = {orderId?: string; visualId?: string; filename?: string; reason: string};
export function scanEntries(detail: unknown, key: "heldDetails" | "failedDetails"): Entry[] | null {
  if (!detail || typeof detail !== "object") return null;
  const values = (detail as Record<string, unknown>)[key];
  if (!Array.isArray(values)) return null;
  return values.filter((v): v is Entry => !!v && typeof v === "object" && typeof v.reason === "string");
}

export function ScanRunHistory({runs}: {runs: {id:string; state:string; detail:unknown; createdAt:string}[]}) {
  return <section className="border border-[var(--line)] rounded bg-[var(--surface)]">
    <h3 className="font-bold text-sm p-3 border-b border-[var(--line)]">Scan runs</h3>
    {!runs.length && <p className="p-4 text-xs text-[var(--ink-3)]">No scans have run.</p>}
    <ul className="max-h-[36rem] overflow-y-auto">
      {runs.map(run => {
        const d = run.detail && typeof run.detail === "object" ? run.detail as Record<string, unknown> : {};
        const held = scanEntries(run.detail,"heldDetails");
        const failed = scanEntries(run.detail,"failedDetails");
        const legacyErrors = Array.isArray(d.errors) ? d.errors.filter((v):v is string=>typeof v==="string") : [];
        if(typeof d.error==="string" && !legacyErrors.includes(d.error)) legacyErrors.push(d.error);
        return <li key={run.id} className="p-3 border-b border-[var(--line)] last:border-0 text-xs space-y-2">
          <div className="flex flex-wrap justify-between gap-2"><strong>{run.state.replace(/_/g," ")}</strong><time>{new Date(run.createdAt).toLocaleString()}</time></div>
          <p className="whitespace-pre-wrap break-words">{automationLogText({...d,errors:[],error:undefined})}</p>
          <DetailSection title="Held / Skipped" entries={held} count={typeof d.held==="number"?d.held:0}
            omitted={typeof d.heldDetailsOmitted==="number"?d.heldDetailsOmitted:0}
            legacy="This older scan saved only a total. Individual reasons will appear on new scans." />
          <DetailSection title="Failed" entries={failed ?? legacyErrors.map(reason=>({reason}))}
            count={(failed?.length ?? legacyErrors.length)+(typeof d.failedDetailsOmitted==="number"?d.failedDetailsOmitted:0)}
            omitted={typeof d.failedDetailsOmitted==="number"?d.failedDetailsOmitted:0}
            legacy="No failure details recorded." />
        </li>;
      })}
    </ul>
  </section>;
}

function DetailSection({title,entries,count,omitted,legacy}:{title:string;entries:Entry[]|null;count:number;omitted:number;legacy:string}) {
  return <details className="rounded border border-[var(--line-2)] p-2">
    <summary className="cursor-pointer font-semibold focus-visible:outline focus-visible:outline-2">{title} ({count})</summary>
    {title==="Failed" && <p className="mt-2 text-[var(--ink-3)]">Scan/download errors—not failed inspection verdicts.</p>}
    {entries===null ? <p className="mt-2">{legacy}</p> : !entries.length ? <p className="mt-2">None recorded.</p> :
      <ul className="mt-2 space-y-3">{entries.map((entry,i)=><li key={i} className="break-words">
        {entry.orderId && /^\d+$/.test(entry.orderId) ? <a className="underline font-semibold" href={`https://www.printavo.com/invoices/${entry.orderId}`} target="_blank" rel="noreferrer">
          {entry.visualId ? `Invoice #${entry.visualId}` : `Printavo order ${entry.orderId}`}
        </a> : <strong>Scan</strong>}
        {entry.filename && <div className="font-mono mt-1">{entry.filename}</div>}
        <p className="mt-1">{entry.reason}</p>
      </li>)}</ul>}
    {omitted>0 && <p className="mt-2">{omitted} additional entries omitted; this scan retains the first 500 details.</p>}
  </details>;
}
