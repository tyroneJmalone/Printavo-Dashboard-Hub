import type { ReportOrder } from "./dataset";

export function feeRows(orders: ReportOrder[], sources: Record<string, any>[]) {
  const byId = new Map(orders.filter(o => o.orderType === "invoice").map(o => [o.id, o]));
  const groups = new Map<string, { label: string; amount: number; invoices: { id: string; visualId: number; customer: string; nickname: string; amount: number }[] }>();
  let incomplete = 0;
  for (const source of sources) {
    const order = byId.get(source.printavo_id);
    if (!order) continue;
    if (!source.extras_synced_at || source.extras_stale || !Array.isArray(source.extras?.fees)) incomplete++;
    const perInvoice = new Map<string, number>();
    for (const fee of source.extras?.fees ?? []) {
      if (fee.amount == null || !Number.isFinite(Number(fee.amount))) continue;
      const cents = Math.round(Number(fee.amount) * 100);
      if (!cents) continue;
      const label = String(fee.description ?? "").trim() || "(Unnamed fee)";
      perInvoice.set(label, (perInvoice.get(label) ?? 0) + cents);
    }
    for (const [label, cents] of perInvoice) {
      const group = groups.get(label) ?? { label, amount: 0, invoices: [] };
      group.amount += cents;
      group.invoices.push({ id: order.id, visualId: order.visualId, customer: order.customerName ?? "", nickname: order.nickname ?? "", amount: cents / 100 });
      groups.set(label, group);
    }
  }
  return { incomplete, invoiceCount: byId.size, rows: [...groups.values()].map(g => ({ ...g, amount: g.amount / 100 })).sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label)) };
}