import { useMemo } from "react";
import { Link, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { useToast } from "@/hooks/use-toast";
import {
  useGetCustomerProfile,
  getGetCustomerProfileQueryKey,
  useListCustomerCategories,
  getListCustomerCategoriesQueryKey,
  useAssignCustomerCategory,
} from "@workspace/api-client-react";
import { formatMoney, formatNumber } from "@/lib/format";
import { Button } from "@/components/ui/button";
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
} from "lucide-react";

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

  const { data, isLoading, error } = useGetCustomerProfile(id, {
    query: { queryKey: getGetCustomerProfileQueryKey(id), enabled: !!id },
  });
  const { data: catData } = useListCustomerCategories({
    query: { queryKey: getListCustomerCategoriesQueryKey() },
  });
  const activeCategories = useMemo(
    () => (catData?.categories ?? []).filter((c) => c.active),
    [catData],
  );

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
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard label="Lifetime spend" value={formatMoney(s.lifetimeSpend)} sub="invoices only" />
          <StatCard label="This year" value={formatMoney(s.ytdSpend)} />
          <StatCard
            label="Invoices"
            value={formatNumber(s.invoiceCount)}
            sub={`${formatNumber(s.quoteCount)} quote${s.quoteCount === 1 ? "" : "s"}`}
          />
          <StatCard label="Avg invoice" value={formatMoney(s.avgOrder)} />
          <StatCard label="Outstanding" value={formatMoney(s.outstanding)} />
          <StatCard
            label="First / last order"
            value={s.lastOrderAt ?? "—"}
            sub={s.firstOrderAt ? `first ${s.firstOrderAt}` : undefined}
          />
        </div>

        <div>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-sm font-semibold text-slate-200">Order history</h2>
            <span className="text-xs text-slate-500 tabular-nums">
              {data.orders.length < data.ordersTotal
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
                      No orders on record.
                    </td>
                  </tr>
                ) : (
                  data.orders.map((o) => (
                    <tr key={o.printavoId} className="hover:bg-slate-900/40">
                      <td className="px-4 py-2.5 font-medium text-slate-200 tabular-nums">
                        #{o.visualId}
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
