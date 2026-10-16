import { useState } from "react";
import type { ChipplyProcessComparison, ChipplySplitPreview, ChipplySplitRequest } from "@workspace/api-client-react";

export interface SplitReviewContext {
  snapshotId: string;
  submit: (request: ChipplySplitRequest) => Promise<ChipplySplitPreview>;
}
export function SplitReview({ group, context }: { group: ChipplyProcessComparison; context: SplitReviewContext }) {
  const candidateIds = new Set(group.candidates.map(candidate => candidate.invoiceId));
  const unavailableIds = (group.splitReview?.invoiceIds ?? []).filter(id => !candidateIds.has(id));
  const [ids, setIds] = useState<string[]>(() => (group.splitReview?.invoiceIds ?? []).filter(id => candidateIds.has(id)));
  const [preview, setPreview] = useState<ChipplySplitPreview | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (action: ChipplySplitRequest["action"]) => {
    setBusy(true); setError("");
    try {
      const result = await context.submit({ snapshotId: context.snapshotId, processKey: group.processKey,
        invoiceIds: ids, action, revision: group.splitRevision ?? null,
        ...(action !== "preview" ? { reason: reason.trim() } : {}),
        ...(action === "approve" && preview ? { evidence: preview.evidence } : {}) });
      setPreview(action === "preview" ? result : null); setConfirmed(false);
    } catch (err) { setError((err as Error).message); setPreview(null); setConfirmed(false); }
    finally { setBusy(false); }
  };
  return <div className="space-y-3 rounded border border-emerald-900 p-3">
    <h4 className="text-sm font-semibold">Review an intentional invoice split</h4>
    <p className="text-xs text-slate-400">Hub-only review; never changes Printavo. Select only invoices that genuinely share this process. All selected garments must exactly cover it, with one common verified method. Identical garment breakdowns are blocked as possible duplicates. Approval replaces single-invoice selections for this process; new evidence invalidates it.</p>
    {!!unavailableIds.length && <p className="text-xs text-amber-300">Previously reviewed invoice IDs {unavailableIds.join(", ")} are no longer candidates and have been removed from this selection. The saved audit record is unchanged. Select current replacements and preview again.</p>}
    {group.candidates.map(c => <label key={c.invoiceId} className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={ids.includes(c.invoiceId)} disabled={busy} onChange={e => {
        setIds(e.target.checked ? [...ids, c.invoiceId] : ids.filter(id => id !== c.invoiceId)); setPreview(null); setConfirmed(false);
      }} /> Invoice {c.visualId == null ? `(number unavailable · ${c.invoiceId})` : `#${c.visualId}`} · {c.state}
    </label>)}
    <button type="button" className="text-xs text-emerald-400 underline disabled:opacity-50" disabled={busy || ids.length < 2 || ids.length > 20} onClick={() => run("preview")}>Preview selected invoices together</button>
    {preview && <div className="space-y-2 text-xs">
      <strong className={preview.eligible ? "text-emerald-400" : "text-amber-300"}>{preview.eligible ? "Full coverage verified · ready for explicit review" : "Cannot approve this selection"}</strong>
      <p>Common method: {preview.actualMethod ?? "Unresolved"}. Counts are from the local mirror, not a live Printavo fetch.</p>
      {preview.issues.map((issue, i) => <p key={i} className="text-amber-300">{issue}</p>)}
      {preview.oneSizeNotes.map(note => <p key={note}>{note}</p>)}
      <div className="max-h-72 overflow-auto"><table className="w-full text-left"><thead><tr>{["Style", "Color", "Size", "Chipply", "Combined Printavo", "Delta"].map(h => <th className="p-1" key={h}>{h}</th>)}</tr></thead>
        <tbody>{preview.rows.map(row => <tr key={`${row.style}|${row.color}|${row.size}`}><td className="p-1">{row.style}</td><td>{row.color}</td><td>{row.size}</td><td>{row.expected}</td><td>{row.actual}</td><td>{row.delta}</td></tr>)}</tbody>
      </table></div>
      {preview.eligible && <label className="flex gap-2"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I reviewed these invoices and confirm this is an intentional split, not duplicate orders.</label>}
    </div>}
    <label className="block text-xs">Review / revocation reason
      <textarea className="mt-1 w-full rounded bg-slate-800 p-2" value={reason} maxLength={1000} disabled={busy} onChange={e => setReason(e.target.value)} />
    </label>
    <div className="flex gap-4">
      <button type="button" className="text-xs text-emerald-400 underline disabled:opacity-50" disabled={busy || !preview?.eligible || !confirmed || reason.trim().length < 5} onClick={() => run("approve")}>Approve reviewed split in Hub</button>
      {group.splitReview && group.splitReview.state !== "revoked" && <button type="button" className="text-xs text-amber-300 underline disabled:opacity-50" disabled={busy || reason.trim().length < 5} onClick={() => run("revoke")}>Revoke split review</button>}
    </div>
    {busy && <p role="status" className="text-xs">Checking current evidence…</p>}
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </div>;
}
