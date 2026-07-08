import { AppShell } from "@/components/layout/AppShell";
import { 
  useGetPaymentsReport, 
  useGetPaymentsStats,
  useGetReportFilterOptions,
  getGetPaymentsReportQueryKey,
  getGetPaymentsStatsQueryKey
} from "@workspace/api-client-react";
import { formatMoney, formatNumber } from "@/lib/format";
import { CreditCard, Loader2, Calendar, Filter, X } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { useState } from "react";

export default function Payments() {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  
  const { data: filterOpts } = useGetReportFilterOptions();
  const paymentTypes = filterOpts?.paymentTypes || [];

  const typesParam = types.length > 0 ? types.join("||") : undefined;

  const { data: reportData, isLoading: isReportLoading } = useGetPaymentsReport({ start: start || undefined, end: end || undefined, types: typesParam }, {
    query: { queryKey: getGetPaymentsReportQueryKey({ start: start || undefined, end: end || undefined, types: typesParam }) }
  });
  
  const { data: statsData, isLoading: isStatsLoading } = useGetPaymentsStats({ start: start || undefined, end: end || undefined }, {
    query: { queryKey: getGetPaymentsStatsQueryKey({ start: start || undefined, end: end || undefined }) }
  });

  const isLoading = isReportLoading || isStatsLoading;

  const toggleType = (t: string) => {
    setTypes(prev => prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]);
  };

  return (
    <AppShell>
      <div className="flex flex-col h-full">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
                <CreditCard className="text-[#10b981]" size={24} />
                Payments Report
              </h1>
              <p className="text-xs text-slate-400 mt-1">Cash flow and transaction history</p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-4 bg-slate-900/50 p-3 rounded-lg border border-slate-800">
            <div className="flex items-center gap-2">
              <Calendar size={16} className="text-slate-400" />
              <input type="date" value={start} onChange={e => setStart(e.target.value)} className="bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1" />
              <span className="text-slate-500 text-xs">to</span>
              <input type="date" value={end} onChange={e => setEnd(e.target.value)} className="bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1" />
            </div>

            <div className="h-6 w-px bg-slate-800"></div>

            <div className="flex items-center gap-2">
              <Filter size={16} className="text-slate-400" />
              <span className="text-xs text-slate-400 font-medium">Types:</span>
              <div className="flex flex-wrap gap-1">
                {paymentTypes.map(pt => (
                  <button 
                    key={pt} 
                    onClick={() => toggleType(pt)}
                    className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                      types.includes(pt) ? 'bg-[#10b981]/20 border-[#10b981] text-[#10b981]' : 'bg-slate-800 border-slate-700 text-slate-300'
                    }`}
                  >
                    {pt}
                  </button>
                ))}
                {types.length > 0 && (
                  <button onClick={() => setTypes([])} className="text-[10px] px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-400 hover:text-white flex items-center gap-1">
                    <X size={10} /> Clear
                  </button>
                )}
              </div>
            </div>
          </div>

          {!isLoading && reportData && statsData && (
            <div className="grid grid-cols-4 gap-4 mt-6">
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1">Total Processed (Filtered)</div>
                <div className="text-2xl font-bold text-[#10b981]">{formatMoney(reportData.total)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1">Transaction Count</div>
                <div className="text-2xl font-bold text-white">{formatNumber(reportData.count)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1">Overall Net</div>
                <div className="text-2xl font-bold text-white">{formatMoney(statsData.net)}</div>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto p-6 space-y-6">
          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="animate-spin text-[#10b981]" size={32} />
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div className="lg:col-span-2 bg-slate-900/30 border border-slate-800 rounded-xl p-6 shadow-2xl h-[400px]">
                  <h2 className="text-sm font-semibold text-white mb-6">Payment Volume Over Time</h2>
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={reportData?.buckets || []}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                      <XAxis 
                        dataKey="bucket" 
                        stroke="#64748b" 
                        fontSize={12} 
                        tickLine={false}
                        axisLine={false}
                        dy={10}
                      />
                      <YAxis 
                        stroke="#64748b" 
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(val) => `$${val/1000}k`}
                        dx={-10}
                      />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#0f172a', borderColor: '#1e293b', borderRadius: '8px' }}
                        itemStyle={{ color: '#10b981', fontWeight: 'bold' }}
                        formatter={(value: number) => [formatMoney(value), 'Amount']}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="amount" 
                        stroke="#10b981" 
                        strokeWidth={3}
                        dot={{ fill: '#0f172a', stroke: '#10b981', strokeWidth: 2, r: 4 }}
                        activeDot={{ r: 6, fill: '#10b981', stroke: '#fff' }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                
                <div className="bg-slate-900/30 border border-slate-800 rounded-xl p-6 shadow-2xl h-[400px] overflow-y-auto">
                   <h2 className="text-sm font-semibold text-white mb-4">Totals By Type</h2>
                   <div className="space-y-3">
                     {statsData?.byType?.map(typeStat => (
                       <div key={typeStat.typename} className="flex items-center justify-between p-3 bg-slate-800/50 rounded-lg border border-slate-700/50">
                         <div>
                           <div className="text-sm font-medium text-white">{typeStat.typename}</div>
                           <div className="text-xs text-slate-400">{formatNumber(typeStat.count)} txns</div>
                         </div>
                         <div className="text-right">
                           <div className={`text-sm font-bold font-mono ${typeStat.amount < 0 ? 'text-red-400' : 'text-[#10b981]'}`}>
                             {formatMoney(typeStat.amount)}
                           </div>
                         </div>
                       </div>
                     ))}
                   </div>
                </div>
              </div>

              <div className="bg-slate-900/30 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
                <table className="w-full text-sm text-left whitespace-nowrap">
                  <thead className="text-xs text-slate-400 bg-slate-900/80 uppercase font-semibold border-b border-slate-800 tracking-wider">
                    <tr>
                      <th className="px-6 py-4">Date</th>
                      <th className="px-6 py-4 text-right">Transactions</th>
                      <th className="px-6 py-4 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {reportData?.buckets?.map((bucket) => (
                      <tr key={bucket.bucket} className="hover:bg-slate-800/40 transition-colors">
                        <td className="px-6 py-4 font-medium text-slate-300">{bucket.bucket}</td>
                        <td className="px-6 py-4 text-right text-white">{formatNumber(bucket.count)}</td>
                        <td className="px-6 py-4 text-right font-mono font-bold text-[#10b981]">
                          {formatMoney(bucket.amount)}
                        </td>
                      </tr>
                    ))}
                    {reportData?.buckets?.length === 0 && (
                      <tr>
                        <td colSpan={3} className="px-6 py-12 text-center text-slate-500">
                          No payment data found for this period.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}
