import { formatMoney, formatNumber } from "@/lib/format";
import type { PipelineStageSummary, PipelineViewConfigStage } from "@workspace/api-client-react";

interface Props {
  stages: PipelineStageSummary[];
  activeStage: PipelineViewConfigStage;
  onSelect: (stageId: PipelineViewConfigStage) => void;
}

const ACTIVE_STAGE_IDS = new Set([
  "quote",
  "quote_sent",
  "follow_up_1",
  "follow_up_2",
  "nurturing",
  "art",
  "other",
]);

const TERMINAL_STAGE_IDS = new Set([
  "won",
  "done",
  "receivables",
  "dead",
  "contract_dead_archive",
  "archive",
]);

export function PipelineStageCards({ stages, activeStage, onSelect }: Props) {
  const activeCount = stages
    .filter(s => ACTIVE_STAGE_IDS.has(s.id))
    .reduce((sum, s) => sum + s.count, 0);
  
  const activeAmount = stages
    .filter(s => ACTIVE_STAGE_IDS.has(s.id))
    .reduce((sum, s) => sum + s.amount, 0);
  
  const otherStage = stages.find(s => s.id === "other");
  const visibleStages = stages.filter(
    s => s.id !== "other" || (otherStage?.count ?? 0) > 0,
  );

  return (
    <div className="flex gap-2 flex-wrap">
      <button
        onClick={() => onSelect("active")}
        className={`text-left rounded-lg border px-3 py-2 min-w-[120px] transition-colors ${
          activeStage === "active"
            ? "border-[#10b981] bg-[#10b981]/10"
            : "border-slate-700 bg-slate-900 hover:border-slate-500"
        }`}
      >
        <div className="text-[10px] uppercase tracking-wider font-semibold text-[#10b981]">
          Active Pipeline
        </div>
        <div className="text-lg font-bold text-white leading-tight">
          {formatNumber(activeCount)}
        </div>
        <div className="text-[10px] text-slate-400">
          {formatMoney(activeAmount)}
        </div>
      </button>
      {visibleStages.map(s => (
        <button
          key={s.id}
          onClick={() => onSelect(s.id as PipelineViewConfigStage)}
          className={`text-left rounded-lg border px-3 py-2 min-w-[110px] transition-colors ${
            activeStage === s.id
              ? "border-[#10b981] bg-[#10b981]/10"
              : TERMINAL_STAGE_IDS.has(s.id)
                ? "border-slate-800 bg-slate-950 hover:border-slate-600"
                : "border-slate-700 bg-slate-900 hover:border-slate-500"
          }`}
        >
          <div
            className={`text-[10px] uppercase tracking-wider font-semibold ${
              TERMINAL_STAGE_IDS.has(s.id)
                ? "text-slate-500"
                : "text-slate-300"
            }`}
          >
            {s.label}
          </div>
          <div className="text-lg font-bold text-white leading-tight">
            {formatNumber(s.count)}
          </div>
          <div className="text-[10px] text-slate-400">
            {formatMoney(s.amount)}
          </div>
        </button>
      ))}
    </div>
  );
}
