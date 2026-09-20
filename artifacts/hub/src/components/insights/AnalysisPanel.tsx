import { useState, useId, useEffect } from "react";
import { ChevronDown, ChevronRight, Calculator, AlertTriangle } from "lucide-react";
import type { InsightsAnalysis } from "@workspace/api-client-react";

export function AnalysisPanel({ analysis }: { analysis: InsightsAnalysis }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();

  // Reset expanded state whenever new analysis identity comes in
  useEffect(() => {
    setOpen(false);
  }, [analysis]);
  
  if (!analysis) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={contentId}
        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Calculator size={14} />
        {open ? "Hide calculation details" : "How this answer was calculated"}
      </button>
      
      {open && (
        <div id={contentId} className="mt-3 text-xs bg-slate-900/80 border border-slate-700/60 rounded-lg p-4 text-slate-300 space-y-4 shadow-sm">
          <p className="text-slate-400 italic mb-2 border-b border-slate-800/60 pb-3">
            {analysis.provenanceNote || "Data based on AI interpretation."}
          </p>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-5">
            <div>
              <strong className="block text-slate-200 mb-1.5 font-medium">Sources</strong>
              {analysis.sources.length > 0 ? (
                <ul className="list-disc pl-4 space-y-1 text-slate-400">
                  {analysis.sources.map((s, i) => (
                    <li key={i}>
                      <span className="text-slate-300">{s.name}</span> ({s.usage})
                      <span className="block text-slate-500 mt-0.5">{s.description}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-slate-500">Not reported</span>
              )}
            </div>
            
            <div>
              <strong className="block text-slate-200 mb-1.5 font-medium">Time Window</strong>
              {analysis.dateCoverage.status === "measured" ? (
                <div className="text-slate-400 space-y-1">
                  <div>From: <span className="text-slate-300">{analysis.dateCoverage.start || "Not measured"}</span></div>
                  <div>To: <span className="text-slate-300">{analysis.dateCoverage.end || "Not measured"}</span></div>
                  {analysis.dateCoverage.basis && (
                    <div className="text-slate-500 mt-0.5">Basis: {analysis.dateCoverage.basis}</div>
                  )}
                </div>
              ) : (
                <span className="text-slate-500">Not measured</span>
              )}
            </div>

            <div>
              <strong className="block text-slate-200 mb-1.5 font-medium">
                Filters Applied <span className="text-slate-500 font-normal italic ml-1">(AI-described)</span>
              </strong>
              {analysis.filters.length > 0 ? (
                <ul className="list-disc pl-4 space-y-1 text-slate-400">
                  {analysis.filters.map((f, i) => <li key={i}>{f.description}</li>)}
                </ul>
              ) : (
                <span className="text-slate-500">Not reported</span>
              )}
            </div>

            <div>
              <strong className="block text-slate-200 mb-1.5 font-medium">
                Logic & Equations <span className="text-slate-500 font-normal italic ml-1">(AI-described)</span>
              </strong>
              {analysis.calculations.length > 0 ? (
                <ul className="list-disc pl-4 space-y-1 text-slate-400">
                  {analysis.calculations.map((c, i) => <li key={i}>{c.description}</li>)}
                </ul>
              ) : (
                <span className="text-slate-500">Not reported</span>
              )}
            </div>

            <div>
              <strong className="block text-slate-200 mb-1.5 font-medium">
                Exclusions <span className="text-slate-500 font-normal italic ml-1">(AI-described)</span>
              </strong>
              {analysis.exclusions.length > 0 ? (
                <ul className="list-disc pl-4 space-y-1 text-slate-400">
                  {analysis.exclusions.map((e, i) => <li key={i}>{e.description}</li>)}
                </ul>
              ) : (
                <span className="text-slate-500">Not reported</span>
              )}
            </div>
            
            <div>
              <strong className="block text-slate-200 mb-1.5 font-medium">Data Freshness</strong>
              <div className="text-slate-400 space-y-1">
                {analysis.freshness.status === "known" ? (
                  <>
                    <div>As of: <span className="text-slate-300">{analysis.freshness.asOf || "Unknown"}</span></div>
                    {analysis.freshness.source && (
                      <div>Source: <span className="text-slate-300">{analysis.freshness.source}</span></div>
                    )}
                  </>
                ) : (
                  <span className="text-slate-500">Unknown</span>
                )}
                {analysis.freshness.note && (
                  <div className="text-slate-500 mt-0.5">{analysis.freshness.note}</div>
                )}
              </div>
            </div>

            <div className="sm:col-span-2">
              <strong className="block text-slate-200 mb-1.5 font-medium">Counts & Summary</strong>
              <div className="text-slate-400 space-y-1">
                <div>
                  Query returned <span className="text-slate-300">{analysis.summary.returnedRows}</span> result rows; 
                  AI summary reviewed <span className="text-slate-300">{analysis.summary.sampledRows}</span> of those rows.
                </div>
                {analysis.summary.truncated && (
                  <div className="text-amber-500/90 italic mt-1">Results were truncated.</div>
                )}
                <div className="text-slate-500 text-[11px] mt-1.5 italic">
                  Note: Result rows represent the output table lines, not necessarily individual invoices or orders.
                </div>
                {analysis.summary.note && (
                  <div className="text-slate-500 mt-1">{analysis.summary.note}</div>
                )}
              </div>
            </div>

            {analysis.limitations.length > 0 && (
              <div className="sm:col-span-2 pt-2 border-t border-slate-800/60">
                <strong className="block text-amber-500/90 mb-1.5 font-medium flex items-center gap-1.5">
                  <AlertTriangle size={14} />
                  Limitations
                </strong>
                <ul className="list-disc pl-4 space-y-1 text-slate-400">
                  {analysis.limitations.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}