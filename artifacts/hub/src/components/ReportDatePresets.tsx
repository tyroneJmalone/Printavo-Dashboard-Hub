import { REPORT_DATE_PRESETS, reportDateRange } from "@/lib/report-date-presets";

/** Shared calendar presets for report filters; custom inputs remain owned by callers. */
export function ReportDatePresets({ onChange }: {
  onChange: (range: { start: string; end: string }) => void;
}) {
  return <div className="flex flex-wrap gap-1" role="group" aria-label="Date range presets">
    {REPORT_DATE_PRESETS.map(([id, label, title]) => <button key={id} type="button"
      title={`${title} · Eastern time, Monday-start weeks`} aria-label={title}
      onClick={() => onChange(reportDateRange(id))}
      className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300 hover:border-emerald-500 hover:text-emerald-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400">
      {label}
    </button>)}
  </div>;
}
