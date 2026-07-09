import { AppShell } from "@/components/layout/AppShell";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { useGetOrdersReport, useGetPaymentsStats, useGetStatusBreakdown } from "@workspace/api-client-react";
import { formatMoney, formatNumber } from "@/lib/format";
import { ArrowRight, BarChart3, TrendingUp, AlertCircle, PackageSearch, Clock, CreditCard } from "lucide-react";
import { Link } from "wouter";

export default function Dashboard() {
  const { data: reportData, isLoading: isReportLoading } = useGetOrdersReport({ limit: 10 });
  const { data: paymentsData, isLoading: isPaymentsLoading } = useGetPaymentsStats();
  const { data: statusBreakdown, isLoading: isStatusLoading } = useGetStatusBreakdown();

  const isLoading = isReportLoading || isPaymentsLoading || isStatusLoading;

  return (
    <AppShell>
      <div className="sticky top-0 z-10 bg-[#020617]/80 backdrop-blur-md border-b border-slate-800 px-8 py-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Dashboard Overview</h1>
          <p className="text-xs text-slate-400 mt-1">Live metrics from Printavo</p>
        </div>
      </div>

      <div className="px-8 py-8 max-w-7xl mx-auto space-y-8">
        {isLoading ? (
          <div className="animate-pulse space-y-8">
            <div className="grid grid-cols-4 gap-4">
              {[1,2,3,4].map(i => <div key={i} className="h-32 bg-slate-900 rounded-xl border border-slate-800"></div>)}
            </div>
            <div className="grid grid-cols-3 gap-6">
              <div className="col-span-2 h-96 bg-slate-900 rounded-xl border border-slate-800"></div>
              <div className="h-96 bg-slate-900 rounded-xl border border-slate-800"></div>
            </div>
          </div>
        ) : (
          <>
            {/* KPI Cards */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-5 relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <TrendingUp size={64} className="text-[#10b981]" />
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Total Orders</div>
                <div className="text-3xl font-bold text-white">{formatNumber(reportData?.stats.orders || 0)}</div>
                <div className="text-xs text-slate-500 mt-2 flex items-center gap-1.5">
                  <span className="text-[#10b981]">All time records</span>
                </div>
              </div>

              <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-5 relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <BarChart3 size={64} className="text-blue-500" />
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Total Revenue</div>
                <div className="text-3xl font-bold text-white">{formatMoney(reportData?.stats.revenue || 0)}</div>
                <div className="text-xs text-slate-500 mt-2">Historical volume</div>
              </div>

              <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-5 relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <PackageSearch size={64} className="text-amber-500" />
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Items Printed</div>
                <div className="text-3xl font-bold text-white">{formatNumber(reportData?.stats.quantity || 0)}</div>
                <div className="text-xs text-slate-500 mt-2">Total pieces</div>
              </div>

              <div className="bg-slate-900/50 rounded-xl border border-slate-800 p-5 relative overflow-hidden group">
                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                  <CreditCard size={64} className="text-indigo-500" />
                </div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Net Payments</div>
                <div className="text-3xl font-bold text-white">{formatMoney(paymentsData?.net || 0)}</div>
                <div className="text-xs text-slate-500 mt-2">Collected</div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Recent Orders */}
              <div className="lg:col-span-2 bg-slate-900/40 rounded-xl border border-slate-800 flex flex-col">
                <div className="px-6 py-5 border-b border-slate-800 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-bold text-white flex items-center gap-2">
                      <Clock size={18} className="text-[#10b981]" />
                      Recent Orders
                    </h2>
                  </div>
                  <Link href="/orders" className="text-sm font-medium text-[#10b981] hover:text-[#059669] flex items-center gap-1 transition-colors">
                    View all <ArrowRight size={16} />
                  </Link>
                </div>
                <div className="p-0 overflow-x-auto">
                  <table className="w-full text-sm text-left">
                    <thead className="text-xs text-slate-400 bg-slate-900/80 uppercase">
                      <tr>
                        <th className="px-6 py-3 font-semibold">Order</th>
                        <th className="px-6 py-3 font-semibold">Customer</th>
                        <th className="px-6 py-3 font-semibold">Status</th>
                        <th className="px-6 py-3 font-semibold text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {reportData?.orders?.slice(0, 7).map((order) => (
                        <tr key={order.id} className="hover:bg-slate-800/30 transition-colors group">
                          <td className="px-6 py-4">
                            <div className="font-medium text-slate-200">
                              <PrintavoOrderLink orderId={order.id} visualId={order.visualId} />
                            </div>
                            <div className="text-xs text-slate-500">{order.nickname || '—'}</div>
                          </td>
                          <td className="px-6 py-4 font-medium text-slate-300">
                            {order.customerName}
                          </td>
                          <td className="px-6 py-4">
                            <span className="inline-flex items-center px-2 py-1 rounded text-[11px] font-bold bg-slate-800 text-slate-300 border border-slate-700">
                              {order.statusName || 'Unknown'}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right font-mono font-medium text-[#10b981]">
                            {formatMoney(order.total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Status Breakdown */}
              <div className="bg-slate-900/40 rounded-xl border border-slate-800 flex flex-col">
                <div className="px-6 py-5 border-b border-slate-800">
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <AlertCircle size={18} className="text-amber-500" />
                    Top Statuses
                  </h2>
                </div>
                <div className="p-6 flex-1">
                  <div className="space-y-5">
                    {statusBreakdown?.rows?.slice(0, 6).map((row, i) => (
                      <div key={row.label}>
                        <div className="flex justify-between items-end mb-2">
                          <span className="text-sm font-semibold text-slate-200 truncate pr-4">{row.label}</span>
                          <span className="text-sm font-mono text-slate-400">{formatNumber(row.orders)}</span>
                        </div>
                        <div className="w-full bg-slate-800 rounded-full h-1.5 overflow-hidden">
                          <div 
                            className="bg-[#10b981] h-1.5 rounded-full" 
                            style={{ width: `${Math.max(2, (row.orders / (statusBreakdown.stats.orders || 1)) * 100)}%` }}
                          ></div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </AppShell>
  );
}
