import { useState } from "react";
import { Link } from "wouter";
import { useGetDashboardDetails, getGetDashboardDetailsQueryKey, type GetDashboardDetailsParams } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { formatMoney, formatNumber } from "@/lib/format";
import { REPORT_DATE_PRESETS } from "@/lib/report-date-presets";

export function PerformanceDetails({ metric, period, label, note, money, onClose }: {
  metric: GetDashboardDetailsParams["metric"]; period: GetDashboardDetailsParams["period"];
  label: string; note: string; money?: boolean; onClose: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const params = { metric, period, offset };
  const query = useGetDashboardDetails(params, { query: { queryKey: getGetDashboardDetailsQueryKey(params), staleTime: 0 } });
  const data = query.data;
  const format = (value: number | null) => value == null ? "Unknown" : money ? formatMoney(value) : formatNumber(value);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto border-slate-700 bg-slate-950 text-slate-100">
      <DialogHeader>
        <DialogTitle>{label} · {REPORT_DATE_PRESETS.find(([key]) => key === period)?.[1]}</DialogTitle>
        <DialogDescription>{note}</DialogDescription>
      </DialogHeader>
      {query.isLoading && <p role="status">Loading included records…</p>}
      {query.isError && <p role="alert" className="text-red-300">Could not load the records. <button className="underline" onClick={() => query.refetch()}>Try again</button></p>}
      {data && !query.isError && <>
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          <span>{data.start} through {data.end} · Eastern time</span>
          <strong>{format(data.value)} · {formatNumber(data.total)} included records</strong>
        </div>
        <p className="text-xs text-slate-400">Current synced records; refreshed when opened. Invoice and customer links open their respective records.
          {metric === "netPayments" && " Each row is a transaction, so an invoice can appear more than once. Refunds retain their signed amounts."}
          {metric === "itemsDecorated" && " All invoices in the calculation are shown, including zero-piece and unknown-quantity invoices."}
        </p>
        {!data.items.length ? <p className="py-6 text-slate-400">No records included in this period.</p> : <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead><tr className="border-b border-slate-700 text-slate-400">
              <th className="p-2">Invoice / quote</th><th className="p-2">Customer / nickname</th><th className="p-2">Date</th><th className="p-2 text-right">{money ? "Amount" : metric === "itemsDecorated" ? "Pieces" : "Count"}</th>
            </tr></thead>
            <tbody>{data.items.map(row => <tr key={row.id} className="border-b border-slate-800 align-top">
              <td className="p-2 whitespace-nowrap"><PrintavoOrderLink orderId={row.orderId} visualId={row.visualId} className="text-emerald-300" /><div className="text-xs text-slate-400">{row.kind}</div></td>
              <td className="p-2">{row.customerId
                ? <Link href={`/customers/${encodeURIComponent(row.customerId)}`} className="text-emerald-300 hover:underline">{row.customerName || `Customer ${row.customerId}`}</Link>
                : row.customerName || "Customer unavailable"}
                {row.nickname && <div className="text-xs text-slate-400">{row.nickname}</div>}
                {row.note && <div className="text-xs text-amber-200">{row.note}</div>}
              </td>
              <td className="p-2 whitespace-nowrap">{row.date}</td>
              <td className="p-2 text-right tabular-nums whitespace-nowrap">{format(row.value)}</td>
            </tr>)}</tbody>
          </table>
        </div>}
        <div className="flex items-center justify-between text-sm">
          <button disabled={offset === 0 || query.isFetching} className="rounded border border-slate-700 px-3 py-1 disabled:opacity-40" onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>
          <span>{data.total ? `${offset + 1}–${Math.min(offset + 50, data.total)} of ${data.total}` : "0 records"}{query.isFetching ? " · Loading…" : ""}</span>
          <button disabled={offset + 50 >= data.total || query.isFetching} className="rounded border border-slate-700 px-3 py-1 disabled:opacity-40" onClick={() => setOffset(offset + 50)}>Next</button>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}
