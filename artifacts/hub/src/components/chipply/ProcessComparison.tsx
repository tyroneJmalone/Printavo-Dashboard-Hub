import type { ChipplyProcessComparison, ChipplyQuantityCandidate } from "@workspace/api-client-react";

function Candidate({ candidate, ambiguous }: { candidate: ChipplyQuantityCandidate; ambiguous: boolean }) {
  const reliable = candidate.state === "matched" || candidate.state === "different";
  const differences = candidate.rows.filter(row => row.result !== "matched");
  return <details className="rounded border border-slate-700 p-3" open={candidate.state !== "matched"}>
    <summary className="cursor-pointer text-sm">
      {candidate.visualId == null ? "Invoice number unavailable" : `Invoice #${candidate.visualId}`}
      {" · "}{!reliable ? "Incomplete evidence" : candidate.state === "matched" ? "Quantities match" : `${differences.length} differing combinations`}
      {ambiguous && " · candidate only"}
    </summary>
    <div className="mt-3 space-y-2">
      {candidate.visualId != null && <a className="text-xs text-emerald-400 underline" href={`https://www.printavo.com/invoices/${candidate.visualId}`} target="_blank" rel="noopener noreferrer">Open Printavo invoice #{candidate.visualId} ↗</a>}
      <p className="text-xs text-slate-400">Details synced: {candidate.detailSyncedAt ? new Date(candidate.detailSyncedAt).toLocaleString() : "Not available"} · Source updated: {candidate.sourceUpdatedAt ? new Date(candidate.sourceUpdatedAt).toLocaleString() : "Not available"}</p>
      {!reliable && <p className="text-xs text-amber-300">{candidate.state === "stale" ? "Mirror details are stale or not fully synced." : "Size breakdown or product identity is invalid or incomplete."} Counts below are provisional, not confirmed discrepancies. Sync or correct the source details, then refresh.</p>}
      {candidate.issues.map((issue, index) => <p key={index} className="text-xs text-amber-300">{issue}</p>)}
      {candidate.oneSizeNotes.map(note => <p key={note} className="text-xs text-slate-400">{note}</p>)}
      <p className="text-xs text-slate-400">Delta = mirrored Printavo − Chipply. Missing / extra refer to this candidate versus the complete process group.{!reliable && " A displayed zero may reflect missing evidence."}</p>
      <div className="max-h-96 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-slate-900 text-slate-400"><tr>{["Style", "Color", "Size", "Chipply", "Printavo", "Delta", reliable ? "Comparison" : "Provisional comparison"].map(label => <th className="p-2" key={label}>{label}</th>)}</tr></thead>
          <tbody>{candidate.rows.map(row => <tr key={`${row.style}|${row.color}|${row.size}`} className="border-t border-slate-800">
            <td className="p-2">{row.style || "(missing)"}</td><td className="p-2">{row.color || "(missing)"}</td><td className="p-2">{row.size || "(missing)"}</td>
            <td className="p-2">{row.expected}</td><td className="p-2">{row.actual}</td><td className="p-2">{row.delta > 0 ? "+" : ""}{row.delta}</td>
            <td className={`p-2 ${row.result === "matched" ? "text-slate-400" : "text-amber-300"}`}>{row.result}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>
  </details>;
}

export function ProcessComparisons({ comparisons }: { comparisons: ChipplyProcessComparison[] }) {
  return <section className="space-y-3" aria-label="Garment quantities by process">
    <h3 className="font-semibold text-white">Garment quantities by process</h3>
    <p className="text-xs text-slate-400">Read-only comparison of the complete source process group using normalized style, color and size labels. Equal grand totals do not prove matching garments. Colors are not substituted; generic Other stays distinct unless the existing product-specific one-size rule applies. Quantity matching alone does not verify a production method.</p>
    {comparisons.map(group => <details key={group.processKey} className="rounded-lg border border-slate-700 p-3">
      <summary className="cursor-pointer text-sm text-emerald-400">{group.processNames.join(" / ")} · {group.state === "ambiguous" ? "Multiple candidates — split invoices unsupported" : group.state === "unmatched" ? "No supported invoice candidate" : group.candidates[0]?.state === "different" ? "Quantity differences" : group.candidates[0]?.state === "matched" ? "Quantities match" : "Incomplete evidence"}</summary>
      <div className="mt-3 space-y-3">
        {group.state === "ambiguous" && <p className="text-xs text-amber-300">These invoices may be duplicates or a split process. Each is compared separately against the full Chipply process; candidate differences do not establish a process-level shortage. Hub does not combine invoices or infer a split. Any existing reviewed selection remains subject to full quantity verification.</p>}
        {group.state === "unmatched" && <p className="text-xs text-amber-300">No invoice satisfies the existing event and process-name rules. This is missing match evidence, not a confirmed garment shortage.</p>}
        {group.candidates.map(candidate => <Candidate key={candidate.invoiceId} candidate={candidate} ambiguous={group.state === "ambiguous"} />)}
      </div>
    </details>)}
  </section>;
}
