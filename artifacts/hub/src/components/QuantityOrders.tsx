import { useState } from "react";
import { useGetOrdersReport, getGetOrdersReportQueryKey, type GetOrdersReportParams } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { formatMoney } from "@/lib/format";

export function QuantityOrders({ range, params, onClose }: { range: string; params: GetOrdersReportParams; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const [min, max] = range.replace("+", "").split("-").map(Number);
  const upperBound = Math.min(max ?? Infinity, params.maxQty ?? Infinity);
  const queryParams = {
    ...params,
    minQty: Math.max(min, params.minQty ?? min),
    maxQty: Number.isFinite(upperBound) ? upperBound : undefined,
    limit: 50, offset: page * 50,
  };
  const emptyRange = queryParams.minQty > upperBound;
  const query = useGetOrdersReport(queryParams, { query: { queryKey: getGetOrdersReportQueryKey(queryParams), enabled: !emptyRange } });
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="sm:max-w-5xl max-h-[85vh] overflow-auto bg-slate-900 border-slate-700 text-slate-200">
      <DialogHeader><DialogTitle>Orders · QTY {range}</DialogTitle><DialogDescription>Orders matching this quantity range and your current report filters.</DialogDescription></DialogHeader>
      {emptyRange ? <p>No matching orders within your quantity filters.</p> : query.isLoading ? <p>Loading orders…</p> : query.isError ? <p role="alert">Unable to load orders. <button className="underline" onClick={() => query.refetch()}>Retry</button></p> : <>
        <p>{query.data?.total ?? 0} orders</p>
        <div className="overflow-x-auto"><table className="w-full text-sm text-left"><thead><tr>{["Order", "Type", "Customer", "Details", "Status", "QTY", "Total"].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead>
          <tbody>{query.data?.orders.map(order => <tr key={order.id} className="border-t border-slate-800">
            <td className="p-2"><PrintavoOrderLink orderId={order.id} visualId={order.visualId} /></td>
            <td className="p-2">{order.orderType}</td><td className="p-2">{order.customerName}</td><td className="p-2">{order.nickname}</td><td className="p-2">{order.statusName}</td><td className="p-2">{order.qty}</td><td className="p-2 whitespace-nowrap">{formatMoney(order.total)}</td>
          </tr>)}</tbody></table></div>
        {!query.data?.orders.length && <p>No matching orders.</p>}
        <div className="flex gap-4 items-center">
          <button disabled={page === 0 || query.isFetching} onClick={() => setPage(p => p - 1)} className="disabled:opacity-40">Previous</button>
          <span>Page {page + 1} of {Math.max(1, Math.ceil((query.data?.total ?? 0) / 50))}</span>
          <button disabled={(page + 1) * 50 >= (query.data?.total ?? 0) || query.isFetching} onClick={() => setPage(p => p + 1)} className="disabled:opacity-40">Next</button>
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}