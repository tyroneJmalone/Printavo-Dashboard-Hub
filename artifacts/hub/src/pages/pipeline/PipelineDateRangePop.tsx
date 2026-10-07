import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ReportDatePresets } from "@/components/ReportDatePresets";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Calendar, ChevronDown } from "lucide-react";
import type { PipelineViewConfig } from "@workspace/api-client-react";

interface Props {
  config: PipelineViewConfig;
  onChange: (updates: Partial<PipelineViewConfig>) => void;
}

function validateDateRange(from?: string, to?: string) {
  return from && to && from > to ? true : false;
}

function DateRangeField({ 
  label, 
  from, 
  to, 
  onChangeFrom, 
  onChangeTo,
  onRange,
}: { 
  label: string, 
  from: string, 
  to: string, 
  onChangeFrom: (v: string) => void, 
  onChangeTo: (v: string) => void;
  onRange: (range: { start: string; end: string }) => void;
}) {
  const isInvalid = validateDateRange(from, to);
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-semibold text-slate-300">{label}</Label>
      <div className="flex items-center gap-2">
        <Input 
          type="date" 
          value={from} 
          onChange={e => onChangeFrom(e.target.value)} 
          className={`bg-slate-950 border-slate-800 text-xs h-8 ${isInvalid ? "border-red-500 focus-visible:ring-red-500" : ""}`} 
        />
        <span className="text-slate-500 text-xs">to</span>
        <Input 
          type="date" 
          value={to} 
          onChange={e => onChangeTo(e.target.value)} 
          className={`bg-slate-950 border-slate-800 text-xs h-8 ${isInvalid ? "border-red-500 focus-visible:ring-red-500" : ""}`} 
        />
      </div>
      {isInvalid && <p className="text-[10px] text-red-400 font-medium leading-none">From date must be before To date.</p>}
      <ReportDatePresets onChange={onRange} />
    </div>
  );
}

export function PipelineDateRangePop({ config, onChange }: Props) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 gap-2 text-slate-300 border-slate-700 bg-slate-900 hover:bg-slate-800 hover:text-white">
          <Calendar size={14} /> 
          Dates
          <ChevronDown size={14} className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[340px] max-h-[80vh] overflow-y-auto p-4 bg-slate-900 border-slate-700 shadow-xl" align="end">
        <div className="space-y-4">
          <h4 className="font-medium text-sm text-slate-200">Date Filters</h4>
          <DateRangeField 
            label="Created Date" 
            onRange={r => onChange({ createdFrom: r.start, createdTo: r.end })}
            from={config.createdFrom || ""} to={config.createdTo || ""} 
            onChangeFrom={v => onChange({ createdFrom: v })} 
            onChangeTo={v => onChange({ createdTo: v })} 
          />
          <DateRangeField 
            label="Invoice Date" 
            onRange={r => onChange({ invoiceFrom: r.start, invoiceTo: r.end })}
            from={config.invoiceFrom || ""} to={config.invoiceTo || ""} 
            onChangeFrom={v => onChange({ invoiceFrom: v })} 
            onChangeTo={v => onChange({ invoiceTo: v })} 
          />
          <DateRangeField 
            label="Production Due" 
            onRange={r => onChange({ productionDueFrom: r.start, productionDueTo: r.end })}
            from={config.productionDueFrom || ""} to={config.productionDueTo || ""} 
            onChangeFrom={v => onChange({ productionDueFrom: v })} 
            onChangeTo={v => onChange({ productionDueTo: v })} 
          />
          <DateRangeField 
            label="Customer Due" 
            onRange={r => onChange({ customerDueFrom: r.start, customerDueTo: r.end })}
            from={config.customerDueFrom || ""} to={config.customerDueTo || ""} 
            onChangeFrom={v => onChange({ customerDueFrom: v })} 
            onChangeTo={v => onChange({ customerDueTo: v })} 
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}
