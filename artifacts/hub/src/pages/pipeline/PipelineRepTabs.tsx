import { formatNumber } from "@/lib/format";
import type { PipelineOwner } from "@workspace/api-client-react";
import { PIPELINE_OWNERS } from "./owners";

interface Props {
  owners: PipelineOwner[];
  activeOwner: string | undefined;
  onSelect: (email: string | undefined) => void;
}

export function PipelineRepTabs({ owners, activeOwner, onSelect }: Props) {
  const counts = new Map<string, number>();
  for (const owner of owners) {
    const email = owner.email.trim().toLowerCase();
    counts.set(email, (counts.get(email) ?? 0) + owner.count);
  }
  return (
    <div className="flex items-center gap-1.5 mt-3 flex-wrap">
      <button
        onClick={() => onSelect(undefined)}
        className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
          !activeOwner
            ? "bg-[#10b981] text-slate-950"
            : "bg-slate-900 text-slate-300 border border-slate-700 hover:border-slate-500"
        }`}
      >
        All
      </button>
      {PIPELINE_OWNERS.map(o => (
        <button
          key={o.email}
          onClick={() => onSelect(o.email.toLowerCase())}
          className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
            activeOwner === o.email.toLowerCase()
              ? "bg-[#10b981] text-slate-950"
              : "bg-slate-900 text-slate-300 border border-slate-700 hover:border-slate-500"
          }`}
          title={o.email}
        >
          {o.name}
          <span className="ml-1.5 opacity-70">{formatNumber(counts.get(o.email) ?? 0)}</span>
        </button>
      ))}
    </div>
  );
}
