import { formatNumber } from "@/lib/format";
import type { PipelineOwner } from "@workspace/api-client-react";

interface Props {
  owners: PipelineOwner[];
  activeOwner: string | undefined;
  onSelect: (email: string | undefined) => void;
}

function repName(email: string): string {
  const prefix = email.split("@")[0] ?? email;
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

export function PipelineRepTabs({ owners, activeOwner, onSelect }: Props) {
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
        All Team
      </button>
      {owners.map(o => (
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
          {repName(o.email)}
          <span className="ml-1.5 opacity-70">{formatNumber(o.count)}</span>
        </button>
      ))}
    </div>
  );
}
