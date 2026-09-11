import { AppShell } from "@/components/layout/AppShell";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { OrderLineItemHistory } from "@/components/OrderLineItemHistory";
import { 
  useGetOrdersReport, 
  useGetReportFilterOptions,
  useGetStatusBreakdown,
  useGetPricingMatrixBreakdown,
  useGetImprintsByTier,
  useGetOrderQuantityBreakdown,
  useGetStyleNumberBreakdown,
  useGetBrandBreakdown,
  useGetColorBreakdown,
  getGetOrdersReportQueryKey,
  getGetStatusBreakdownQueryKey,
  getGetPricingMatrixBreakdownQueryKey,
  getGetImprintsByTierQueryKey,
  getGetOrderQuantityBreakdownQueryKey,
  getGetStyleNumberBreakdownQueryKey,
  getGetBrandBreakdownQueryKey,
  getGetColorBreakdownQueryKey,
  GetOrdersReportParams
} from "@workspace/api-client-react";
import { formatMoney, formatNumber, formatDate } from "@/lib/format";
import { useEffect, useState } from "react";
import { Search, Filter, Loader2, FileText, ChevronLeft, ChevronRight, X, History } from "lucide-react";

type BreakdownType = 'table' | 'status' | 'pricing' | 'tier' | 'quantity' | 'style' | 'brand' | 'color';

export default function Orders() {
  const [activeTab, setActiveTab] = useState<BreakdownType>('table');
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(0);
  const limit = 100;
  
  // Filter state
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [orderType, setOrderType] = useState<"invoice" | "quote" | "all">("invoice");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [brands, setBrands] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [colors, setColors] = useState<string[]>([]);
  const [styleNumbers, setStyleNumbers] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  
  const [dateBasis, setDateBasis] = useState<"created" | "invoice" | "productionDue" | "due">("created");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  
  const [minQty, setMinQty] = useState("");
  const [maxQty, setMaxQty] = useState("");
  const [minTotal, setMinTotal] = useState("");
  const [maxTotal, setMaxTotal] = useState("");
  const [historyOrder, setHistoryOrder] = useState<{ id: string; visualId: number | null } | null>(null);

  const { data: filterOpts } = useGetReportFilterOptions();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Construct params
  const params: GetOrdersReportParams = {
    search: debouncedSearch || undefined,
    orderType,
    statuses: statuses.length ? statuses.join("||") : undefined,
    brands: brands.length ? brands.join("||") : undefined,
    categories: categories.length ? categories.join("||") : undefined,
    colors: colors.length ? colors.join("||") : undefined,
    styleNumbers: styleNumbers.length ? styleNumbers.join("||") : undefined,
    exclude: exclude.length ? exclude.join("||") : undefined,
    createdStart: dateBasis === "created" && dateStart ? dateStart : undefined,
    createdEnd: dateBasis === "created" && dateEnd ? dateEnd : undefined,
    invoiceStart: dateBasis === "invoice" && dateStart ? dateStart : undefined,
    invoiceEnd: dateBasis === "invoice" && dateEnd ? dateEnd : undefined,
    productionDueStart: dateBasis === "productionDue" && dateStart ? dateStart : undefined,
    productionDueEnd: dateBasis === "productionDue" && dateEnd ? dateEnd : undefined,
    dueStart: dateBasis === "due" && dateStart ? dateStart : undefined,
    dueEnd: dateBasis === "due" && dateEnd ? dateEnd : undefined,
    minQty: minQty ? Number(minQty) : undefined,
    maxQty: maxQty ? Number(maxQty) : undefined,
    minTotal: minTotal ? Number(minTotal) : undefined,
    maxTotal: maxTotal ? Number(maxTotal) : undefined,
  };

  const { data: ordersData, isLoading: isLoadingOrders } = useGetOrdersReport({ ...params, limit, offset: page * limit }, {
    query: { queryKey: getGetOrdersReportQueryKey({ ...params, limit, offset: page * limit }) }
  });

  const { data: statusBreakdown, isLoading: isLoadingStatus } = useGetStatusBreakdown(params, { query: { queryKey: getGetStatusBreakdownQueryKey(params), enabled: activeTab === 'status' } });
  const { data: pricingBreakdown, isLoading: isLoadingPricing } = useGetPricingMatrixBreakdown(params, { query: { queryKey: getGetPricingMatrixBreakdownQueryKey(params), enabled: activeTab === 'pricing' } });
  const { data: tierBreakdown, isLoading: isLoadingTier } = useGetImprintsByTier(params, { query: { queryKey: getGetImprintsByTierQueryKey(params), enabled: activeTab === 'tier' } });
  const { data: quantityBreakdown, isLoading: isLoadingQuantity } = useGetOrderQuantityBreakdown(params, { query: { queryKey: getGetOrderQuantityBreakdownQueryKey(params), enabled: activeTab === 'quantity' } });
  const { data: styleBreakdown, isLoading: isLoadingStyle } = useGetStyleNumberBreakdown(params, { query: { queryKey: getGetStyleNumberBreakdownQueryKey(params), enabled: activeTab === 'style' } });
  const { data: brandBreakdown, isLoading: isLoadingBrand } = useGetBrandBreakdown(params, { query: { queryKey: getGetBrandBreakdownQueryKey(params), enabled: activeTab === 'brand' } });
  const { data: colorBreakdown, isLoading: isLoadingColor } = useGetColorBreakdown(params, { query: { queryKey: getGetColorBreakdownQueryKey(params), enabled: activeTab === 'color' } });

  const activeBreakdownData = 
    activeTab === 'status' ? statusBreakdown :
    activeTab === 'pricing' ? pricingBreakdown :
    activeTab === 'tier' ? tierBreakdown :
    activeTab === 'quantity' ? quantityBreakdown :
    activeTab === 'style' ? styleBreakdown :
    activeTab === 'brand' ? brandBreakdown :
    activeTab === 'color' ? colorBreakdown : null;

  const isLoadingBreakdown = 
    (activeTab === 'status' && isLoadingStatus) ||
    (activeTab === 'pricing' && isLoadingPricing) ||
    (activeTab === 'tier' && isLoadingTier) ||
    (activeTab === 'quantity' && isLoadingQuantity) ||
    (activeTab === 'style' && isLoadingStyle) ||
    (activeTab === 'brand' && isLoadingBrand) ||
    (activeTab === 'color' && isLoadingColor);

  const toggleFilter = (setter: React.Dispatch<React.SetStateAction<string[]>>, val: string) => {
    setter(prev => prev.includes(val) ? prev.filter(x => x !== val) : [...prev, val]);
  };

  const clearAllFilters = () => {
    setSearch("");
    setOrderType("invoice");
    setStatuses([]);
    setBrands([]);
    setCategories([]);
    setColors([]);
    setStyleNumbers([]);
    setExclude([]);
    setDateStart("");
    setDateEnd("");
    setMinQty("");
    setMaxQty("");
    setMinTotal("");
    setMaxTotal("");
    setPage(0);
  };

  const hasActiveFilters = search || orderType !== "invoice" || statuses.length || brands.length || categories.length || colors.length || styleNumbers.length || exclude.length || dateStart || dateEnd || minQty || maxQty || minTotal || maxTotal;

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
                <FileText className="text-[#10b981]" size={24} />
                Orders Report
              </h1>
              <p className="text-xs text-slate-400 mt-1">Comprehensive view of all print jobs and quotes.</p>
            </div>
            
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
                <input 
                  type="text" 
                  placeholder="Search orders..." 
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                  className="w-64 bg-slate-900 border border-slate-700 text-sm text-white rounded-md pl-9 pr-4 py-2 focus:outline-none focus:border-[#10b981] focus:ring-1 focus:ring-[#10b981] transition-all"
                />
              </div>
              <button 
                onClick={() => setShowFilters(!showFilters)}
                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors border ${showFilters || hasActiveFilters ? 'bg-[#10b981]/20 border-[#10b981] text-[#10b981]' : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'}`}
              >
                <Filter size={16} /> Filters {hasActiveFilters ? " (Active)" : ""}
              </button>
            </div>
          </div>

          {showFilters && (
            <div className="mt-4 p-4 bg-slate-900/80 border border-slate-700 rounded-xl space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-white">Filter Orders</h3>
                <button onClick={clearAllFilters} className="text-xs text-slate-400 hover:text-white">Clear All</button>
              </div>
              <div className="grid grid-cols-4 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Order Type</label>
                  <select value={orderType} onChange={e => { setOrderType(e.target.value as any); setPage(0); }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5">
                    <option value="invoice">Invoice</option>
                    <option value="quote">Quote</option>
                    <option value="all">All</option>
                  </select>
                </div>
                <div className="space-y-1 col-span-2">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider flex items-center gap-2">
                    Date Range
                    <select value={dateBasis} onChange={e => { setDateBasis(e.target.value as any); setPage(0); }} className="bg-transparent border-none text-[#10b981] font-bold p-0 focus:ring-0">
                      <option value="created">Created</option>
                      <option value="invoice">Invoice Date</option>
                      <option value="productionDue">Production Due</option>
                      <option value="due">Customer Due</option>
                    </select>
                  </label>
                  <div className="flex items-center gap-2">
                    <input type="date" value={dateStart} onChange={e => { setDateStart(e.target.value); setPage(0); }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5" />
                    <span className="text-slate-500 text-xs">to</span>
                    <input type="date" value={dateEnd} onChange={e => { setDateEnd(e.target.value); setPage(0); }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5" />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Exclude Filters</label>
                  <select value="" onChange={e => {
                    const val = e.target.value;
                    if (val && !exclude.includes(val)) { setExclude([...exclude, val]); setPage(0); }
                  }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5">
                    <option value="">Select to exclude...</option>
                    <option value="statuses">Statuses</option>
                    <option value="brands">Brands</option>
                    <option value="categories">Categories</option>
                    <option value="colors">Colors</option>
                    <option value="styleNumbers">Style Numbers</option>
                  </select>
                  {exclude.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {exclude.map(ex => (
                        <span key={ex} className="text-[9px] bg-red-900/30 text-red-400 border border-red-800/50 px-1.5 py-0.5 rounded flex items-center gap-1">
                          NOT {ex} <X size={8} className="cursor-pointer" onClick={() => { setExclude(exclude.filter(x => x !== ex)); setPage(0); }} />
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-4 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Statuses</label>
                  <select value="" onChange={e => { if (e.target.value) { toggleFilter(setStatuses, e.target.value); setPage(0); } }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5">
                    <option value="">Add status...</option>
                    {filterOpts?.statuses?.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {statuses.map(s => <span key={s} className="text-[9px] bg-[#10b981]/20 text-[#10b981] border border-[#10b981]/30 px-1.5 py-0.5 rounded flex items-center gap-1">{s} <X size={8} className="cursor-pointer" onClick={() => { toggleFilter(setStatuses, s); setPage(0); }}/></span>)}
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Brands</label>
                  <select value="" onChange={e => { if (e.target.value) { toggleFilter(setBrands, e.target.value); setPage(0); } }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5">
                    <option value="">Add brand...</option>
                    {filterOpts?.brands?.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {brands.map(s => <span key={s} className="text-[9px] bg-[#10b981]/20 text-[#10b981] border border-[#10b981]/30 px-1.5 py-0.5 rounded flex items-center gap-1">{s} <X size={8} className="cursor-pointer" onClick={() => { toggleFilter(setBrands, s); setPage(0); }}/></span>)}
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Categories</label>
                  <select value="" onChange={e => { if (e.target.value) { toggleFilter(setCategories, e.target.value); setPage(0); } }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5">
                    <option value="">Add category...</option>
                    {filterOpts?.categories?.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {categories.map(s => <span key={s} className="text-[9px] bg-[#10b981]/20 text-[#10b981] border border-[#10b981]/30 px-1.5 py-0.5 rounded flex items-center gap-1">{s} <X size={8} className="cursor-pointer" onClick={() => { toggleFilter(setCategories, s); setPage(0); }}/></span>)}
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Colors</label>
                  <select value="" onChange={e => { if (e.target.value) { toggleFilter(setColors, e.target.value); setPage(0); } }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5">
                    <option value="">Add color...</option>
                    {filterOpts?.colors?.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {colors.map(s => <span key={s} className="text-[9px] bg-[#10b981]/20 text-[#10b981] border border-[#10b981]/30 px-1.5 py-0.5 rounded flex items-center gap-1">{s} <X size={8} className="cursor-pointer" onClick={() => { toggleFilter(setColors, s); setPage(0); }}/></span>)}
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Style Numbers</label>
                  <select value="" onChange={e => { if (e.target.value) { toggleFilter(setStyleNumbers, e.target.value); setPage(0); } }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5">
                    <option value="">Add style...</option>
                    {filterOpts?.styleNumbers?.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {styleNumbers.map(s => <span key={s} className="text-[9px] bg-[#10b981]/20 text-[#10b981] border border-[#10b981]/30 px-1.5 py-0.5 rounded flex items-center gap-1">{s} <X size={8} className="cursor-pointer" onClick={() => { toggleFilter(setStyleNumbers, s); setPage(0); }}/></span>)}
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Quantity Range</label>
                  <div className="flex items-center gap-2">
                    <input type="number" placeholder="Min" value={minQty} onChange={e => { setMinQty(e.target.value); setPage(0); }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5" />
                    <input type="number" placeholder="Max" value={maxQty} onChange={e => { setMaxQty(e.target.value); setPage(0); }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5" />
                  </div>
                </div>
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Total ($) Range</label>
                  <div className="flex items-center gap-2">
                    <input type="number" placeholder="Min $" value={minTotal} onChange={e => { setMinTotal(e.target.value); setPage(0); }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5" />
                    <input type="number" placeholder="Max $" value={maxTotal} onChange={e => { setMaxTotal(e.target.value); setPage(0); }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {!isLoadingOrders && ordersData?.stats && (
            <div className="grid grid-cols-4 gap-4 mt-6">
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1">Total Orders</div>
                <div className="text-2xl font-bold text-white">{formatNumber(ordersData.stats.orders)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1">Total Revenue</div>
                <div className="text-2xl font-bold text-white">{formatMoney(ordersData.stats.revenue)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1">Items Printed</div>
                <div className="text-2xl font-bold text-white">{formatNumber(ordersData.stats.quantity)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1">Avg Order Value</div>
                <div className="text-2xl font-bold text-[#10b981]">{formatMoney(ordersData.stats.avgOrderValue)}</div>
              </div>
            </div>
          )}

          <div className="mt-6 border-b border-slate-800 flex overflow-x-auto custom-scrollbar">
            {[
              { id: 'table', label: 'Orders List' },
              { id: 'status', label: 'By Status' },
              { id: 'pricing', label: 'By Pricing Matrix' },
              { id: 'tier', label: 'By Imprint Tier' },
              { id: 'quantity', label: 'By Order Size' },
              { id: 'style', label: 'By Style' },
              { id: 'brand', label: 'By Brand' },
              { id: 'color', label: 'By Color' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as BreakdownType)}
                className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                  activeTab === tab.id 
                    ? 'border-[#10b981] text-[#10b981]' 
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-auto p-6 bg-[#020617]">
          {activeTab === 'table' ? (
            <div className="flex flex-col h-full space-y-4">
              {isLoadingOrders ? (
                <div className="flex items-center justify-center flex-1">
                  <Loader2 className="animate-spin text-[#10b981]" size={32} />
                </div>
              ) : (
                <>
                  <div className="bg-slate-900/30 border border-slate-800 rounded-xl overflow-hidden shadow-2xl flex-1">
                    <table className="w-full text-sm text-left whitespace-nowrap">
                      <thead className="text-xs text-slate-400 bg-slate-900/80 uppercase font-semibold border-b border-slate-800 tracking-wider">
                        <tr>
                          <th className="px-6 py-4">ID</th>
                          <th className="px-6 py-4">Type</th>
                          <th className="px-6 py-4">Customer</th>
                          <th className="px-6 py-4">Details</th>
                          <th className="px-6 py-4">Status</th>
                          <th className="px-6 py-4">Created</th>
                          <th className="px-6 py-4 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                        {ordersData?.orders?.map((order) => (
                          <tr key={order.id} className="hover:bg-slate-800/40 transition-colors">
                            <td className="px-6 py-4 font-mono text-slate-300">
                              <div className="flex items-center gap-2">
                                <PrintavoOrderLink orderId={order.id} visualId={order.visualId} />
                                <button
                                  type="button"
                                  onClick={() => setHistoryOrder({ id: order.id, visualId: order.visualId })}
                                  className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-800 hover:text-[#10b981]"
                                  title="View line-item history"
                                  aria-label={`View line-item history for order ${order.visualId}`}
                                >
                                  <History size={14} />
                                </button>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-xs font-medium text-slate-400 capitalize">{order.orderType}</td>
                            <td className="px-6 py-4 font-medium text-white">{order.customerName}</td>
                            <td className="px-6 py-4 text-slate-400 max-w-[200px] truncate" title={order.nickname || ''}>
                              {order.nickname || '—'}
                            </td>
                            <td className="px-6 py-4">
                              <span className="inline-flex items-center px-2 py-1 rounded text-[10px] font-bold bg-slate-800/80 text-slate-300 border border-slate-700 shadow-sm">
                                {order.statusName || 'Unknown'}
                              </span>
                            </td>
                            <td className="px-6 py-4 text-slate-400 font-mono text-xs">{formatDate(order.createdAt)}</td>
                            <td className="px-6 py-4 text-right font-mono font-bold text-[#10b981]">
                              {formatMoney(order.total)}
                            </td>
                          </tr>
                        ))}
                        {ordersData?.orders?.length === 0 && (
                          <tr>
                            <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
                              No orders found matching your filters.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  
                  {ordersData && ordersData.total > 0 && (
                    <div className="flex items-center justify-between text-sm text-slate-400">
                      <div>
                        Showing {page * limit + 1} to {Math.min((page + 1) * limit, ordersData.total)} of {formatNumber(ordersData.total)} orders
                      </div>
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={() => setPage(p => Math.max(0, p - 1))}
                          disabled={page === 0}
                          className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <ChevronLeft size={16} />
                        </button>
                        <button 
                          onClick={() => setPage(p => p + 1)}
                          disabled={(page + 1) * limit >= ordersData.total}
                          className="p-1 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <ChevronRight size={16} />
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="h-full">
              {isLoadingBreakdown ? (
                <div className="flex items-center justify-center h-64">
                  <Loader2 className="animate-spin text-[#10b981]" size={32} />
                </div>
              ) : activeBreakdownData ? (
                <div className="bg-slate-900/30 border border-slate-800 rounded-xl overflow-hidden shadow-2xl">
                  <table className="w-full text-sm text-left whitespace-nowrap">
                    <thead className="text-xs text-slate-400 bg-slate-900/80 uppercase font-semibold border-b border-slate-800 tracking-wider">
                      <tr>
                        <th className="px-6 py-4 w-1/3">Label</th>
                        <th className="px-6 py-4 text-right">Orders</th>
                        <th className="px-6 py-4 text-right">Quantity</th>
                        <th className="px-6 py-4 text-right">Revenue</th>
                        <th className="px-6 py-4 text-right">% of Revenue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {activeBreakdownData.rows.map((row) => (
                        <tr key={row.label} className="hover:bg-slate-800/40 transition-colors">
                          <td className="px-6 py-4 font-medium text-white">{row.label}</td>
                          <td className="px-6 py-4 text-right text-slate-300">{formatNumber(row.orders)}</td>
                          <td className="px-6 py-4 text-right text-slate-300">{formatNumber(row.quantity)}</td>
                          <td className="px-6 py-4 text-right font-mono font-medium text-[#10b981]">
                            {formatMoney(row.revenue)}
                          </td>
                          <td className="px-6 py-4 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <span className="text-slate-400 font-mono text-xs w-12 text-right">
                                {row.pctOfRevenue.toFixed(1)}%
                              </span>
                              <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden">
                                <div className="h-full bg-[#10b981] rounded-full" style={{ width: `${Math.min(100, Math.max(2, row.pctOfRevenue))}%` }} />
                              </div>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {activeBreakdownData.rows.length === 0 && (
                        <tr>
                          <td colSpan={5} className="px-6 py-12 text-center text-slate-500">
                            No breakdown data found.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
      <OrderLineItemHistory
        orderId={historyOrder?.id ?? null}
        visualId={historyOrder?.visualId ?? null}
        open={historyOrder !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryOrder(null);
        }}
      />
    </AppShell>
  );
}
