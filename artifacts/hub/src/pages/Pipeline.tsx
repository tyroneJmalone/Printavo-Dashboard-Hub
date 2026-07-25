import { AppShell } from "@/components/layout/AppShell";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { useStaff } from "@/components/auth/StaffGate";
import {
  useGetPipeline,
  getGetPipelineQueryKey,
  type GetPipelineParams,
  type PipelineRow,
} from "@workspace/api-client-react";
import { formatMoney, formatNumber, formatDate } from "@/lib/format";
import { Link } from "wouter";
import { useEffect, useRef, useState } from "react";
import { Filter, Loader2, ChevronLeft, ChevronRight, Flame } from "lucide-react";

/**
 * Sales Pipeline — quotes bucketed into funnel stages, plus recently won/done
 * invoices (a winning quote becomes an invoice in Printavo). All-team view
 * with per-rep tabs; defaults to "my pipeline" when the logged-in staff
 * member owns quotes.
 */

/** Stage ids the combined "Active" view covers (mirrors the API default). */
const ACTIVE_STAGE_IDS = new Set([
  "quote",
  "quote_sent",
  "follow_up_1",
  "follow_up_2",
  "nurturing",
  "art",
  "other",
]);

/** Terminal stages get muted cards so the working funnel stands out. */
const TERMINAL_STAGE_IDS = new Set([
  "won",
  "done",
  "dead",
  "contract_dead_archive",
  "archive",
]);

/** Stages where sitting >= AGING_DAYS means a follow-up is overdue. */
const AGING_STAGE_IDS = new Set([
  "quote",
  "quote_sent",
  "follow_up_1",
  "follow_up_2",
]);
const AGING_DAYS = 7;

const WON_WINDOW_OPTIONS = [30, 60, 90, 180, 365];

const PAGE_SIZE = 200;

function repName(email: string): string {
  const prefix = email.split("@")[0] ?? email;
  return prefix.charAt(0).toUpperCase() + prefix.slice(1);
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

export default function Pipeline() {
  const { email: myEmail } = useStaff();
  const [stage, setStage] = useState<string>("active");
  const [owner, setOwner] = useState<string | null>(null);
  const [wonDays, setWonDays] = useState(90);
  const [page, setPage] = useState(0);
  const appliedDefaultRep = useRef(false);

  const params: GetPipelineParams = {
    stage: stage as GetPipelineParams["stage"],
    owner: owner ?? undefined,
    wonDays,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const { data, isLoading, isError } = useGetPipeline(params, {
    query: { queryKey: getGetPipelineQueryKey(params) },
  });

  // If the dataset shrinks while sitting on a later page, snap back to page 1.
  useEffect(() => {
    if (data && data.rows.length === 0 && page > 0) setPage(0);
  }, [data, page]);

  // Default to "my pipeline" once, if the logged-in staff member owns quotes.
  useEffect(() => {
    if (!data || appliedDefaultRep.current) return;
    appliedDefaultRep.current = true;
    const mine = data.owners.find(
      (o) => o.email.toLowerCase() === myEmail.toLowerCase(),
    );
    if (mine) setOwner(mine.email.toLowerCase());
  }, [data, myEmail]);

  const selectStage = (id: string) => {
    setStage((prev) => (prev === id ? "active" : id));
    setPage(0);
  };
  const selectOwner = (o: string | null) => {
    setOwner(o);
    setPage(0);
  };

  const stages = data?.stages ?? [];
  const activeCount = stages
    .filter((s) => ACTIVE_STAGE_IDS.has(s.id))
    .reduce((sum, s) => sum + s.count, 0);
  const activeAmount = stages
    .filter((s) => ACTIVE_STAGE_IDS.has(s.id))
    .reduce((sum, s) => sum + s.amount, 0);
  const otherStage = stages.find((s) => s.id === "other");
  const visibleStages = stages.filter(
    (s) => s.id !== "other" || (otherStage?.count ?? 0) > 0,
  );

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showRepColumn = owner === null;
  const showStageColumn = stage === "active";

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
                <Filter className="text-[#10b981]" size={24} />
                Sales Pipeline
              </h1>
              <p className="text-xs text-slate-400 mt-1">
                Quotes by stage, plus invoices won in the last {wonDays} days.
                Rows glowing amber have sat {AGING_DAYS}+ days without a status
                change — that's the follow-up list.
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-400">
              Won/Done window
              <select
                value={wonDays}
                onChange={(e) => {
                  setWonDays(Number(e.target.value));
                  setPage(0);
                }}
                className="bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-[#10b981]"
              >
                {WON_WINDOW_OPTIONS.map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* Rep tabs */}
          <div className="flex items-center gap-1.5 mt-3 flex-wrap">
            <button
              onClick={() => selectOwner(null)}
              className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                owner === null
                  ? "bg-[#10b981] text-slate-950"
                  : "bg-slate-900 text-slate-300 border border-slate-700 hover:border-slate-500"
              }`}
            >
              All Team
            </button>
            {(data?.owners ?? []).map((o) => (
              <button
                key={o.email}
                onClick={() => selectOwner(o.email.toLowerCase())}
                className={`px-3 py-1.5 rounded text-xs font-semibold transition-colors ${
                  owner === o.email.toLowerCase()
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
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          {/* Stage cards */}
          <div className="px-6 pt-4">
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => selectStage("active")}
                className={`text-left rounded-lg border px-3 py-2 min-w-[120px] transition-colors ${
                  stage === "active"
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
              {visibleStages.map((s) => (
                <button
                  key={s.id}
                  onClick={() => selectStage(s.id)}
                  className={`text-left rounded-lg border px-3 py-2 min-w-[110px] transition-colors ${
                    stage === s.id
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
          </div>

          {/* Table */}
          <div className="px-6 py-4">
            {isError ? (
              <div className="text-sm text-red-400 py-8 text-center">
                Failed to load the pipeline. Try refreshing.
              </div>
            ) : isLoading ? (
              <div className="flex items-center justify-center py-16 text-slate-400">
                <Loader2 className="animate-spin mr-2" size={18} />
                Loading pipeline…
              </div>
            ) : rows.length === 0 ? (
              <div className="text-sm text-slate-500 py-12 text-center">
                No orders in this view.
              </div>
            ) : (
              <div className="border border-slate-800 rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-900/70 text-left text-[11px] uppercase tracking-wider text-slate-400">
                      <th className="px-3 py-2.5 font-semibold">Order</th>
                      <th className="px-3 py-2.5 font-semibold">Customer</th>
                      <th className="px-3 py-2.5 font-semibold">Nickname</th>
                      {showRepColumn && (
                        <th className="px-3 py-2.5 font-semibold">Rep</th>
                      )}
                      {showStageColumn && (
                        <th className="px-3 py-2.5 font-semibold">Stage</th>
                      )}
                      <th className="px-3 py-2.5 font-semibold">Created</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Qty</th>
                      <th className="px-3 py-2.5 font-semibold text-right">Total</th>
                      <th className="px-3 py-2.5 font-semibold">Status</th>
                      <th className="px-3 py-2.5 font-semibold text-right">
                        In Status
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70">
                    {rows.map((row) => {
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
                          <td className="px-3 py-2 text-slate-200 max-w-[220px] truncate">
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
                            className="px-3 py-2 text-slate-400 max-w-[240px] truncate"
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
                            {formatDate(row.createdAt)}
                          </td>
                          <td className="px-3 py-2 text-slate-300 text-right whitespace-nowrap">
                            {formatNumber(row.qty)}
                          </td>
                          <td className="px-3 py-2 text-slate-200 text-right whitespace-nowrap font-medium">
                            {formatMoney(row.total)}
                          </td>
                          <td
                            className="px-3 py-2 text-slate-300 max-w-[260px] truncate"
                            title={row.statusName}
                          >
                            {row.statusName}
                          </td>
                          <td
                            className="px-3 py-2 text-right whitespace-nowrap"
                            title={
                              row.statusSince
                                ? `${row.statusSinceExact ? "Since" : "Since at least"} ${formatDate(row.statusSince)}`
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
            )}

            {/* Pagination */}
            {total > PAGE_SIZE && (
              <div className="flex items-center justify-between mt-3 text-xs text-slate-400">
                <span>
                  Showing {page * PAGE_SIZE + 1}–
                  {Math.min((page + 1) * PAGE_SIZE, total)} of{" "}
                  {formatNumber(total)}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    className="p-1.5 rounded border border-slate-700 disabled:opacity-40 hover:border-slate-500 transition-colors"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span>
                    Page {page + 1} / {pageCount}
                  </span>
                  <button
                    disabled={page + 1 >= pageCount}
                    onClick={() => setPage((p) => p + 1)}
                    className="p-1.5 rounded border border-slate-700 disabled:opacity-40 hover:border-slate-500 transition-colors"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            )}

            <p className="text-[11px] text-slate-600 mt-4">
              Times marked with "+" predate status tracking (began July 8) —
              the order has been in its status at least that long. Merch store
              source quotes are excluded. Won/Done show invoices, since a
              winning quote becomes an invoice in Printavo.
            </p>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
