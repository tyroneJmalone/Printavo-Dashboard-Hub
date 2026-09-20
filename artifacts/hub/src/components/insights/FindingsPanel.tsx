import { useState, useId } from "react";
import { Lightbulb, ChevronDown, ChevronRight } from "lucide-react";
import type { InsightsAnalysis } from "@workspace/api-client-react";
import { formatCell } from "./utils";

export function FindingsPanel({ findings }: { findings?: InsightsAnalysis['findings'] }) {
  if (!findings || findings.length === 0) return null;
  
  const displayFindings = findings.slice(0, 3);
  
  return (
    <div className="mt-5 space-y-3">
      <h3 className="text-xs font-semibold text-slate-400 flex items-center gap-1.5 uppercase tracking-wider">
        <Lightbulb size={14} className="text-amber-400" />
        Notable Findings
      </h3>
      <p className="text-xs text-slate-500">AI observations from the returned results. Expand each finding to see its supporting values.</p>
      <div className="grid gap-3 sm:grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {displayFindings.map((finding, idx) => (
          <FindingCard key={idx} finding={finding} />
        ))}
      </div>
    </div>
  );
}

function FindingCard({ finding }: { finding: NonNullable<InsightsAnalysis['findings']>[0] }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  
  return (
    <div className="rounded-lg border border-slate-700/60 bg-slate-800/40 overflow-hidden flex flex-col">
      <div className="px-3.5 py-3 text-sm text-slate-200 leading-relaxed flex-1">
        {finding.text}
      </div>
      {finding.evidence && finding.evidence.length > 0 && (
        <div className="border-t border-slate-700/60 mt-auto bg-slate-900/30">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-controls={contentId}
            className="w-full flex items-center justify-between px-3.5 py-2 text-xs text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
          >
            <span className="font-medium">{open ? "Hide evidence" : "Show evidence"}</span>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          
          {open && (
            <div id={contentId} className="px-3.5 py-2.5 bg-slate-900/60 text-xs text-slate-300 border-t border-slate-700/30 max-h-32 overflow-y-auto">
              <ul className="space-y-1.5">
                {finding.evidence.map((ev, i) => (
                  <li key={i} className="flex items-start gap-2 break-all">
                    <span className="text-slate-500 font-mono text-[10px] uppercase shrink-0 mt-0.5">Row {ev.row + 1}</span>
                    <div>
                      <span className="text-slate-400">{ev.column}:</span>{" "}
                      <span className="font-semibold text-slate-200">{formatCell(ev.value)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}