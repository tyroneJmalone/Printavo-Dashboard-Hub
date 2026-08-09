import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "wouter";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { useToast } from "@/hooks/use-toast";
import {
  useGetCustomerProfile,
  getGetCustomerProfileQueryKey,
  useListCustomerCategories,
  getListCustomerCategoriesQueryKey,
  useAssignCustomerCategory,
  useListCollections,
  getListCollectionsQueryKey
} from "@workspace/api-client-react";
import { formatMoney, formatNumber } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  Loader2,
  User,
  Mail,
  CalendarDays,
  Briefcase,
  Search,
  Shirt,
  Store,
  Palette,
  Star
} from "lucide-react";
import { fmtMoney, fmtDate } from "./ChipplyStores";

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">
        {label}
      </p>
      <p className="text-lg font-bold text-white tabular-nums mt-0.5">{value}</p>
      {sub ? <p className="text-xs text-slate-500 mt-0.5">{sub}</p> : null}
    </div>
  );
}

export default function CustomerProfile() {
  const { id = "" } = useParams<{ id: string }>();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [qInput, setQInput] = useState("");
  const [orderQ, setOrderQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setOrderQ(qInput.trim()), 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const params = useMemo(
    () => ({
      ...(statusFilter !== "all" ? { status: statusFilter } : {}),
      ...(orderQ !== "" ? { q: orderQ } : {}),
    }),
    [statusFilter, orderQ],
  );
  const filtersActive = statusFilter !== "all" || orderQ !== "";

  const { data, isLoading, error, isFetching } = useGetCustomerProfile(id, params, {
    query: {
      queryKey: getGetCustomerProfileQueryKey(id, params),
      enabled: !!id,
      placeholderData: keepPreviousData,
    },
  });
  const { data: catData } = useListCustomerCategories({
    query: { queryKey: getListCustomerCategoriesQueryKey() },
  });
  const activeCategories = useMemo(
    () => (catData?.categories ?? []).filter((c) => c.active),
    [catData],
  );

  const { data: collectionsData } = useListCollections(
    { customerId: data?.printavoId },
    { query: { enabled: !!data?.printavoId, queryKey: getListCollectionsQueryKey({ customerId: data?.printavoId }) } }
  );
  const collections = collectionsData?.collections ?? [];

  const assign = useAssignCustomerCategory({
    mutation: {
      onSuccess: (_r, vars) => {
        toast({
          title:
            vars.data.categoryId == null ? "Category cleared" : "Category updated",
        });
        qc.invalidateQueries({
          predicate: (q) =>
            typeof q.queryKey[0] === "string" &&
            q.queryKey[0].startsWith("/api/customers"),
        });
      },
      onError: () =>
        toast({
          title: "Assignment failed",
          description: "Please try again.",
          variant: "destructive",
        }),
    },
  });

  if (isLoading) {
    return (
      <AppShell>
        <div className="px-8 py-16 text-center text-slate-500">
          <Loader2 size={18} className="inline animate-spin mr-2" />
          Loading customer…
        </div>
      </AppShell>
    );
  }
  if (error || !data) {
    return (
      <AppShell>
        <div className="px-8 py-16 text-center text-slate-500">
          <p className="mb-4">Customer not found.</p>
          <Link href="/customers">
            <Button variant="outline" size="sm">
              <ArrowLeft size={14} className="mr-1" /> Back to directory
            </Button>
          </Link>
        </div>
      </AppShell>
    );
  }

  const s = data.stats;

  return (
    <AppShell>
      <div className="sticky top-0 z-10 bg-[#020617]/80 backdrop-blur-md border-b border-slate-800 px-8 py-5">
        <div className="flex items-center gap-3">
          <Link href="/customers">
            <Button variant="ghost" size="sm" className="px-2 -ml-2 text-slate-400">
              <ArrowLeft size={16} />
            </Button>
          </Link>
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-white tracking-tight truncate">
              {data.displayName}
            </h1>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400 mt-1">
              {data.contactName ? (
                <span className="inline-flex items-center gap-1">
                  <User size={12} /> {data.contactName}
                </span>
              ) : null}
              {data.contactEmail ? (
                <a
                  href={`mailto:${data.contactEmail}`}
                  className="inline-flex items-center gap-1 hover:text-slate-200"
                >
                  <Mail size={12} /> {data.contactEmail}
                </a>
              ) : null}
              {data.customerSince ? (
                <span className="inline-flex items-center gap-1">
                  <CalendarDays size={12} /> Customer since {data.customerSince}
                </span>
              ) : null}
              {data.ownerEmail ? (
                <span className="inline-flex items-center gap-1">
                  <Briefcase size={12} /> Owner: {data.ownerEmail}
                </span>
              ) : null}
            </div>
          </div>
          <div className="ml-auto w-60">
            <Select
              value={data.categoryId ?? "none"}
              onValueChange={(v) =>
                assign.mutate({
                  data: {
                    customerIds: [data.printavoId],
                    categoryId: v === "none" ? null : v,
                  },
                })
              }
            >
              <SelectTrigger
                className={`h-9 ${data.categoryId ? "" : "text-slate-500 border-dashed"}`}
              >
                <SelectValue>
                  {data.categoryName ?? "Set niche category…"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— No category —</SelectItem>
                {activeCategories.map((cat) => (
                  <SelectItem key={cat.id} value={cat.id}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="px-8 py-6 space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Lifetime spend" value={formatMoney(s.lifetimeSpend)} sub="invoices only" />
          <StatCard label="This year" value={formatMoney(s.ytdSpend)} />
          <StatCard
            label="Invoices"
            value={formatNumber(s.invoiceCount)}
            sub={`${formatNumber(s.quoteCount)} quote${s.quoteCount === 1 ? "" : "s"}`}
          />
          <StatCard label="Avg invoice" value={formatMoney(s.avgOrder)} />
          <StatCard
            label="Order frequency"
            value={
              s.ordersPerMonth != null
                ? `${s.ordersPerMonth >= 10 ? Math.round(s.ordersPerMonth) : s.ordersPerMonth.toFixed(1)} / mo`
                : "—"
            }
            sub={
              s.avgDaysBetween != null
                ? `every ~${Math.round(s.avgDaysBetween)} days`
                : undefined
            }
          />
          <StatCard
            label="Avg order qty"
            value={
              s.avgOrderQty != null ? `${formatNumber(Math.round(s.avgOrderQty))} pcs` : "—"
            }
            sub={
              s.totalItems != null && s.totalItems > 0
                ? `${formatNumber(s.totalItems)} pcs lifetime`
                : undefined
            }
          />
          <StatCard label="Outstanding" value={formatMoney(s.outstanding)} />
          <StatCard
            label="First / last order"
            value={s.lastOrderAt ?? "—"}
            sub={s.firstOrderAt ? `first ${s.firstOrderAt}` : undefined}
          />
        </div>

        {data.methodBreakdown.length > 0 ? (
          <div>
            <h2 className="text-sm font-semibold text-slate-200 mb-2 inline-flex items-center gap-1.5">
              <Palette size={14} className="text-slate-400" /> Decoration methods
              <span className="text-xs font-normal text-slate-500">
                Chipply excluded · multi-method orders count in each method
              </span>
            </h2>
            <div className="flex flex-wrap gap-2">
              {data.methodBreakdown.map((m) => (
                <div
                  key={m.method}
                  className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2"
                >
                  <p
                    className={`text-sm font-semibold ${m.method === "Unspecified" ? "text-slate-400" : "text-slate-200"}`}
                  >
                    {m.method === "Unspecified" ? "No method recorded" : m.method}
                  </p>
                  <p className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                    {formatNumber(m.totalQty)} pcs · {formatNumber(m.orderCount)}{" "}
                    order{m.orderCount === 1 ? "" : "s"}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {data.topStyles.length > 0 ? (
          <div>
            <h2 className="text-sm font-semibold text-slate-200 mb-2 inline-flex items-center gap-1.5">
              <Shirt size={14} className="text-slate-400" /> Common styles
              <span className="text-xs font-normal text-slate-500">
                by invoice count
              </span>
            </h2>
            <div className="flex flex-wrap gap-2">
              {data.topStyles.map((t) => (
                <div
                  key={`${t.brand ?? ""}|${t.itemNumber}`}
                  className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2"
                >
                  <p className="text-sm font-semibold text-slate-200">
                    {t.brand ? `${t.brand} ` : ""}
                    <span className="text-emerald-400">{t.itemNumber}</span>
                  </p>
                  <p className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                    {formatNumber(t.orderCount)} order
                    {t.orderCount === 1 ? "" : "s"} · {formatNumber(t.totalQty)} pcs
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {data.chipplyStores.length > 0 ||
        data.chipplyProduction.invoiceCount > 0 ? (
          <div>
            <h2 className="text-sm font-semibold text-slate-200 mb-2 inline-flex items-center gap-1.5">
              <Store size={14} className="text-emerald-400" /> Chipply web stores
              <span className="text-[10px] font-bold uppercase tracking-wide bg-emerald-950/60 text-emerald-300 border border-emerald-800/50 rounded px-1.5 py-0.5">
                separate from Printavo revenue
              </span>
            </h2>
            {data.chipplyStores.length > 0 ? (
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-xs text-slate-400">
                      <th className="px-4 py-2 font-semibold">Store</th>
                      <th className="px-4 py-2 font-semibold">Event #</th>
                      <th className="px-4 py-2 font-semibold">Closed</th>
                      <th className="px-4 py-2 font-semibold text-right">Orders</th>
                      <th className="px-4 py-2 font-semibold text-right">Total dollars</th>
                      <th className="px-4 py-2 font-semibold text-right">Fundraising</th>
                      <th className="px-4 py-2 font-semibold text-right">Invoices</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.chipplyStores.map(({ store, linkedInvoiceCount }) => (
                      <tr
                        key={store.id}
                        className="border-b border-slate-800/60"
                      >
                        <td className="px-4 py-2">
                          <Link
                            href={`/chipply/${store.id}`}
                            className="text-emerald-400 hover:underline font-semibold"
                          >
                            {store.storeName}
                          </Link>
                        </td>
                        <td className="px-4 py-2 text-slate-400 whitespace-nowrap">
                          {store.eventId ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-slate-300 whitespace-nowrap">
                          {fmtDate(store.closedAt)}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-200 tabular-nums">
                          {store.numOrders ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-200 tabular-nums">
                          {fmtMoney(store.totalDollars)}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-300 tabular-nums">
                          {fmtMoney(store.fundraising)}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-300 tabular-nums">
                          {linkedInvoiceCount}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-800/40 font-semibold">
                      <td className="px-4 py-2 text-slate-300" colSpan={4}>
                        Total Chipply dollars
                      </td>
                      <td className="px-4 py-2 text-right text-white tabular-nums">
                        {fmtMoney(
                          data.chipplyStores.reduce(
                            (sum, s) =>
                              sum + (Number(s.store.totalDollars) || 0),
                            0,
                          ),
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-200 tabular-nums">
                        {fmtMoney(
                          data.chipplyStores.reduce(
                            (sum, s) => sum + (Number(s.store.fundraising) || 0),
                            0,
                          ),
                        )}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-200 tabular-nums">
                        {data.chipplyStores.reduce(
                          (sum, s) => sum + s.linkedInvoiceCount,
                          0,
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            ) : null}
            {data.chipplyProduction.invoiceCount > 0 ? (
              <div className="mt-3">
                <p className="text-xs text-slate-400 mb-2">
                  <span className="font-semibold text-emerald-400">
                    Chipply production
                  </span>{" "}
                  · {formatNumber(data.chipplyProduction.invoiceCount)} shop
                  invoice
                  {data.chipplyProduction.invoiceCount === 1 ? "" : "s"} ·{" "}
                  {formatNumber(data.chipplyProduction.totalItems)} pcs
                  decorated — tracked here, excluded from the Printavo stats
                  above
                </p>
                {data.chipplyProduction.methods.length > 0 ? (
                  <div className="mb-2">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
                      By method
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {data.chipplyProduction.methods.map((m) => (
                        <div
                          key={m.method}
                          className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-3 py-2"
                        >
                          <p
                            className={`text-sm font-semibold ${m.method === "Unspecified" ? "text-slate-400" : "text-slate-200"}`}
                          >
                            {m.method === "Unspecified"
                              ? "No method in nickname"
                              : m.method}
                          </p>
                          <p className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                            {formatNumber(m.totalQty)} pcs ·{" "}
                            {formatNumber(m.orderCount)} invoice
                            {m.orderCount === 1 ? "" : "s"}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                {data.chipplyProduction.topStyles.length > 0 ? (
                  <div>
                    <p className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1.5">
                      Top styles
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {data.chipplyProduction.topStyles.map((t) => (
                        <div
                          key={`${t.brand ?? ""}|${t.itemNumber}`}
                          className="rounded-lg border border-emerald-900/50 bg-emerald-950/20 px-3 py-2"
                        >
                          <p className="text-sm font-semibold text-slate-200">
                            {t.brand ? `${t.brand} ` : ""}
                            <span className="text-emerald-400">
                              {t.itemNumber}
                            </span>
                          </p>
                          <p className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                            {formatNumber(t.totalQty)} pcs ·{" "}
                            {formatNumber(t.orderCount)} invoice
                            {t.orderCount === 1 ? "" : "s"}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {collections.length > 0 ? (
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-slate-200 inline-flex items-center gap-1.5">
                <Star size={14} className="text-[#10b981]" /> Style Collections
              </h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {collections.map(c => (
                <Link key={c.id} href={`/collections/${c.id}`}>
                  <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 hover:bg-slate-900/60 transition-colors cursor-pointer group">
                    <div className="flex items-center justify-between mb-1">
                       <h3 className="font-bold text-white text-sm truncate">{c.name}</h3>
                       <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">{c.itemCount} item{c.itemCount !== 1 ? 's' : ''}</span>
                    </div>
                    {c.previewImages.length > 0 ? (
                       <div className="flex gap-1.5 mb-2">
                          {c.previewImages.map((img, i) => (
                             <div key={i} className="w-8 h-8 rounded bg-white/5 border border-white/10 flex items-center justify-center p-0.5">
                               <img src={img} className="max-w-full max-h-full object-contain mix-blend-screen" alt="" />
                             </div>
                          ))}
                       </div>
                    ) : (
                       <div className="text-xs text-slate-500 italic mb-2">Empty collection</div>
                    )}
                    <div className="text-[10px] text-slate-500">Updated {c.updatedAt.split("T")[0]}</div>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-slate-200 inline-flex items-center gap-1.5">
                <Star size={14} className="text-slate-500" /> Style Collections
              </h2>
            </div>
            <div className="rounded-xl border border-slate-800 border-dashed bg-slate-900/20 px-4 py-6 text-center">
               <p className="text-sm text-slate-400 mb-3">No style collections linked to this customer.</p>
               <Link href="/collections">
                 <Button variant="outline" size="sm" className="bg-slate-800 border-slate-700 text-slate-300">
                   Go to Collections
                 </Button>
               </Link>
            </div>
          </div>
        )}

        <div>
          <div className="flex flex-wrap items-center gap-3 mb-2">
            <h2 className="text-sm font-semibold text-slate-200">Order history</h2>
            <div className="relative">
              <Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500"
              />
              <Input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search nickname or order #…"
                className="h-8 w-64 pl-8 text-sm"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-64 text-sm">
                <SelectValue>
                  {statusFilter === "all" ? "All statuses" : statusFilter}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {data.statuses.map((st) => (
                  <SelectItem key={st.name} value={st.name}>
                    {st.name} ({formatNumber(st.count)})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isFetching ? (
              <Loader2 size={14} className="animate-spin text-slate-500" />
            ) : null}
            <span className="ml-auto text-xs text-slate-500 tabular-nums">
              {filtersActive
                ? `${formatNumber(data.ordersTotal)} matching order${data.ordersTotal === 1 ? "" : "s"}${
                    data.orders.length < data.ordersTotal
                      ? ` (showing latest ${data.orders.length})`
                      : ""
                  }`
                : data.orders.length < data.ordersTotal
                  ? `Showing latest ${data.orders.length} of ${formatNumber(data.ordersTotal)}`
                  : `${formatNumber(data.ordersTotal)} order${data.ordersTotal === 1 ? "" : "s"}`}
            </span>
          </div>
          <div className="border border-slate-800 rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-900/60 text-slate-400 text-xs uppercase tracking-wider">
                  <th className="px-4 py-3 text-left font-semibold">Order</th>
                  <th className="px-4 py-3 text-left font-semibold">Nickname</th>
                  <th className="px-4 py-3 text-left font-semibold">Type</th>
                  <th className="px-4 py-3 text-left font-semibold">Status</th>
                  <th className="px-4 py-3 text-right font-semibold">Date</th>
                  <th className="px-4 py-3 text-right font-semibold">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {data.orders.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                      {filtersActive
                        ? "No orders match the current filters."
                        : "No orders on record."}
                    </td>
                  </tr>
                ) : (
                  data.orders.map((o) => (
                    <tr key={o.printavoId} className="hover:bg-slate-900/40">
                      <td className="px-4 py-2.5 font-medium text-slate-200 tabular-nums">
                        <PrintavoOrderLink
                          orderId={o.printavoId}
                          visualId={o.visualId}
                        />
                      </td>
                      <td className="px-4 py-2.5 text-slate-300 max-w-[320px] truncate">
                        {o.nickname ?? "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-md text-[11px] font-semibold ${
                            o.orderType === "invoice"
                              ? "bg-emerald-500/10 text-emerald-400"
                              : "bg-sky-500/10 text-sky-400"
                          }`}
                        >
                          {o.orderType}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-slate-400 max-w-[180px] truncate">
                        {o.statusName ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-400">
                        {o.orderDate ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-slate-200">
                        {o.total == null ? "—" : formatMoney(o.total)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
