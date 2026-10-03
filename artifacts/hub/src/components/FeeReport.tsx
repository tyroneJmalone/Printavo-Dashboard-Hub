import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { formatMoney } from "@/lib/format";
import type { GetOrdersReportParams } from "@workspace/api-client-react";

interface FeeReportData {
  incomplete: number;
  invoiceCount: number;
  rows: { label: string; amount: number; invoices: { id: string; visualId: number; customer: string; nickname: string; amount: number }[] }[];
}

export function FeeReport({ params }: { params: GetOrdersReportParams }) {
  const query = useQuery({
    queryKey: ["/api/reports/fees", params],
    queryFn: () => {
      const search = new URLSearchParams();
      for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) search.set(key, String(value));
      return apiFetch<FeeReportData>(`/reports/fees?${search}`);
    },
  });
  if (query.isLoading) return <p className="p-6 text-slate-400">Loading fees…</p>;
  if (query.isError) return <div role="alert" className="p-6 text-red-300">Unable to load fees. <button className="underline" onClick={() => query.refetch()}>Retry</button></div>;
  const data = query.data!;
  return <section className="space-y-3 text-slate-200">
    <p className="text-sm text-slate-400">Invoice fee charges, grouped by fee description. Expand a fee to see its invoices. Amounts are fee charges, not invoice revenue; an invoice can appear under multiple fees. Quotes are excluded.</p>
    {!!data.incomplete && <p role="status" className="text-sm text-amber-300">{data.incomplete} of {data.invoiceCount} invoices have missing or stale fee details. Results reflect available mirrored data and may be incomplete.</p>}
    {!data.rows.length && <p className="p-6 text-slate-400">No nonzero fee charges found for these filters.</p>}
    {data.rows.map(row => <details key={row.label} className="rounded-lg border border-slate-800 bg-slate-900">
      <summary className="cursor-pointer p-4"><span className="font-medium">{row.label}</span><span className="ml-4 text-slate-400">{row.invoices.length} invoices</span><span className="float-right text-emerald-400">{formatMoney(row.amount)}</span></summary>
      <div className="max-h-[480px] overflow-auto"><table className="w-full text-sm text-left"><thead><tr>{["Invoice", "Customer", "Details", "Fee charge"].map(h => <th key={h} className="p-3">{h}</th>)}</tr></thead>
      <tbody>{row.invoices.map(invoice => <tr key={invoice.id} className="border-t border-slate-800"><td className="p-3"><PrintavoOrderLink orderId={invoice.id} visualId={invoice.visualId} /></td><td className="p-3">{invoice.customer}</td><td className="p-3">{invoice.nickname}</td><td className="p-3 whitespace-nowrap">{formatMoney(invoice.amount)}</td></tr>)}</tbody></table></div>
    </details>)}
  </section>;
}