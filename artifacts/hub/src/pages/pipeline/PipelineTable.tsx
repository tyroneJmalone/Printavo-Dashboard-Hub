import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { Link } from "wouter";
import { formatMoney, formatNumber } from "@/lib/format";
import { ArrowUp, ArrowDown, Flame, Loader2 } from "lucide-react";
import type { 
  PipelineRow, 
  PipelineViewConfigSort, 
  PipelineViewConfigDirection,
  PipelineStageSummary
} from "@workspace/api-client-react";

interface Props {
  rows: PipelineRow[];
  stages: PipelineStageSummary[];
  sort?: PipelineViewConfigSort;
  direction?: PipelineViewConfigDirection;
  onSort: (column: PipelineViewConfigSort) => void;
  showRepColumn: boolean;
  showStageColumn: boolean;
  isLoading: boolean;
  isError: boolean;
  hasInvalidDates: boolean;
}

const AGING_STAGE_IDS = new Set([
  "quote",
  "quote_sent",
  "follow_up_1",
  "follow_up_2",
]);
const AGING_DAYS = 7;

function formatPipelineDate(value: string | null | undefined, calendarDate = false): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric",
    timeZone: calendarDate ? "UTC" : "America/New_York",
  }).format(date);
}

function daysInStatus(since: string | null | undefined): number | null {
  if (!since) return null;
  const ms = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.floor(ms / 86_400_000);
}

function timeInStatusLabel(row: PipelineRow): string {
  if (!row.statusSince) return "—";
  const ms = Date.now() - new Date(row.statusSince).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const days = Math.floor(ms / 86_400_000);
  let label: string;
  if (days >= 1) {
    label = `${days}d`;
  } else {
    const hours = Math.floor(ms / 3_600_000);
    label = hours >= 1 ? `${hours}h` : "<1h";
  }
  return row.statusSinceExact ? label : `${label}+`;
}

function isAging(row: PipelineRow): boolean {
  if (!AGING_STAGE_IDS.has(row.stageId)) return false;
  const days = daysInStatus(row.statusSince);
  return days !== null && days >= AGING_DAYS;
}

function repName(email: string): string {
  const prefix = email.split("@")[0] ?? email;
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
}

function SortHeader({ 
  field, 
  label, 
  sort,
  direction,
  onSort, 
  align = "left" 
}: { 
  field: PipelineViewConfigSort, 
  label: string, 
  sort?: PipelineViewConfigSort,
  direction?: PipelineViewConfigDirection,
  onSort: (c: PipelineViewConfigSort) => void, 
  align?: "left" | "right" 
}) {
  const isActive = sort === field;
  return (
    <th 
      aria-sort={isActive ? (direction === "asc" ? "ascending" : "descending") : "none"}
      className="p-0 font-semibold select-none whitespace-nowrap"
    >
      <button 
        type="button"
        className="w-full px-3 py-2.5 flex items-center group hover:bg-slate-800 transition-colors focus:outline-none focus:bg-slate-800"
        onClick={() => onSort(field)}
      >
        <div className={`flex items-center gap-1.5 w-full ${align === "right" ? "justify-end" : ""}`}>
          {label}
          <span className={`text-slate-500 group-hover:text-slate-300 ${isActive ? "opacity-100" : "opacity-0"}`}>
            {isActive && direction === "desc" ? <ArrowDown size={13} /> : <ArrowUp size={13} />}
          </span>
        </div>
      </button>
    </th>
  );
}

export function PipelineTable({ 
  rows, 
  stages, 
  sort, 
  direction, 
  onSort, 
  showRepColumn, 
  showStageColumn,
  isLoading,
  isError,
  hasInvalidDates
}: Props) {
  if (hasInvalidDates) {
    return (
      <div className="text-sm text-red-400 py-12 text-center flex flex-col items-center justify-center gap-2">
        <Flame size={24} className="opacity-50" />
        You have an invalid date range in your filters. Please correct it to view results.
      </div>
    );
  }

  if (isError) {
    return (
      <div className="text-sm text-red-400 py-8 text-center flex flex-col items-center gap-2">
        <Flame size={24} className="opacity-50" />
        Failed to load the pipeline. Try refreshing.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 className="animate-spin mr-2" size={18} />
        Loading pipeline…
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="text-sm text-slate-500 py-12 text-center">
        No orders in this view.
      </div>
    );
  }

  return (
    <div className="border border-slate-800 rounded-lg overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-900/70 text-left text-[11px] uppercase tracking-wider text-slate-400">
            <SortHeader field="visualId" label="Order" sort={sort} direction={direction} onSort={onSort} />
            <SortHeader field="customerName" label="Customer" sort={sort} direction={direction} onSort={onSort} />
            <SortHeader field="nickname" label="Nickname" sort={sort} direction={direction} onSort={onSort} />
            {showRepColumn && <SortHeader field="ownerEmail" label="Rep" sort={sort} direction={direction} onSort={onSort} />}
            {showStageColumn && <SortHeader field="stage" label="Stage" sort={sort} direction={direction} onSort={onSort} />}
            <SortHeader field="createdAt" label="Created" sort={sort} direction={direction} onSort={onSort} />
            <SortHeader field="invoiceAt" label="Invoice" sort={sort} direction={direction} onSort={onSort} />
            <SortHeader field="productionDueAt" label="Prod Due" sort={sort} direction={direction} onSort={onSort} />
            <SortHeader field="customerDueAt" label="Cust Due" sort={sort} direction={direction} onSort={onSort} />
            <SortHeader field="qty" label="Qty" sort={sort} direction={direction} onSort={onSort} align="right" />
            <SortHeader field="total" label="Total" sort={sort} direction={direction} onSort={onSort} align="right" />
            <SortHeader field="statusName" label="Status" sort={sort} direction={direction} onSort={onSort} />
            <SortHeader field="statusSince" label="In Status" sort={sort} direction={direction} onSort={onSort} align="right" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/70">
          {rows.map(row => {
            const aging = isAging(row);
            return (
              <tr
                key={row.id}
                className={`transition-colors ${
                  aging
                    ? "bg-amber-500/[0.06] hover:bg-amber-500/10"
                    : "hover:bg-slate-900/50"
                }`}
              >
                <td className="px-3 py-2 font-mono text-slate-200 whitespace-nowrap">
                  <PrintavoOrderLink
                    orderId={row.id}
                    visualId={row.visualId}
                  />
                </td>
                <td className="px-3 py-2 text-slate-200">
                  {row.customerId ? (
                    <Link
                      href={`/customers/${row.customerId}`}
                      className="hover:text-[#10b981] hover:underline underline-offset-2"
                    >
                      {row.customerName ?? "(no name)"}
                    </Link>
                  ) : (
                    (row.customerName ?? "—")
                  )}
                </td>
                <td
                  className="px-3 py-2 text-slate-400"
                  title={row.nickname ?? undefined}
                >
                  {row.nickname || "—"}
                </td>
                {showRepColumn && (
                  <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                    {row.ownerEmail ? repName(row.ownerEmail) : "—"}
                  </td>
                )}
                {showStageColumn && (
                  <td className="px-3 py-2 whitespace-nowrap">
                    <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                      {stages.find((s) => s.id === row.stageId)
                        ?.label ?? row.stageId}
                    </span>
                  </td>
                )}
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                  {formatPipelineDate(row.createdAt)}
                </td>
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                  {formatPipelineDate(row.invoiceAt, true)}
                </td>
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                  {formatPipelineDate(row.productionDueAt, true)}
                </td>
                <td className="px-3 py-2 text-slate-400 whitespace-nowrap">
                  {formatPipelineDate(row.customerDueAt, true)}
                </td>
                <td className="px-3 py-2 text-slate-300 text-right whitespace-nowrap">
                  {formatNumber(row.qty)}
                </td>
                <td className="px-3 py-2 text-slate-200 text-right whitespace-nowrap font-medium">
                  {formatMoney(row.total)}
                </td>
                <td
                  className="px-3 py-2 text-slate-300"
                  title={row.statusName}
                >
                  {row.statusName}
                </td>
                <td
                  className="px-3 py-2 text-right whitespace-nowrap"
                  title={
                    row.statusSince
                      ? `${row.statusSinceExact ? "Since" : "Since at least"} ${formatPipelineDate(row.statusSince)}`
                      : undefined
                  }
                >
                  <span
                    className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded ${
                      aging
                        ? "bg-amber-500/15 text-amber-400"
                        : "text-slate-400"
                    }`}
                  >
                    {aging && <Flame size={11} />}
                    {timeInStatusLabel(row)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
