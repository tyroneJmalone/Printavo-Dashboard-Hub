import { AppShell } from "@/components/layout/AppShell";
import { ArtworkReport } from "@/components/ArtworkReport";
import { FeeReport } from "@/components/FeeReport";
import { DecorationProductionReport } from "@/components/DecorationProductionReport";
import { QuantityOrders } from "@/components/QuantityOrders";
import { REPORT_DATE_PRESETS, reportDateRange, type ReportDatePreset } from "@/lib/report-date-presets";
import { ChipplyReport, ReportSourceSelector } from "@/components/chipply/ChipplyReport";
import { SummaryComparison, BreakdownComparison, rangeLabel, type ComparableTab } from "@/components/ReportComparison";
import { previousYearRange, previousYearFilters, type ComparisonRange } from "@/lib/report-comparison";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { OrderLineItemHistory } from "@/components/OrderLineItemHistory";
import { ArtworkStatusFilter } from "@/components/ArtworkStatusFilter";
import { ActivityOrderDetailPanel } from "@/components/ActivityOrderDetailPanel";
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
  useGetCategoryBreakdown,
  getGetCategoryBreakdownQueryKey,
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
import { reportShare } from "@/lib/report-share";
import { useEffect, useState } from "react";
import { Search, Filter, Loader2, FileText, ChevronLeft, ChevronRight, X, History, Activity, CalendarDays, GitCompare } from "lucide-react";

type BreakdownType = 'table' | 'status' | 'pricing' | 'tier' | 'quantity' | 'style' | 'brand' | 'color' | 'fees' | 'category' | 'decoration' | 'artwork';
type ReportMode = "normal" | "activity";
type ActivityPreset = ReportDatePreset | "custom";

function activityPresetRange(preset: ActivityPreset): { start: string; end: string } {
  return preset === "custom" ? { start: "", end: "" } : reportDateRange(preset);
}

function formatObservedAt(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function ShareCell({ value, total }: { value: number; total: number }) {
  const percentage = reportShare(value, total);
  return (
    <td className="px-6 py-4 text-right">
      <div className="flex items-center justify-end gap-2">
        <span className="text-slate-400 font-mono text-xs w-12 text-right">
          {percentage.toFixed(1)}%
        </span>
        <div className="w-16 h-1.5 bg-slate-800 rounded-full overflow-hidden" aria-hidden="true">
          <div className="h-full bg-[#10b981] rounded-full" style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }} />
        </div>
      </div>
    </td>
  );
}

export default function Orders() {
  const [source, setSource] = useState<"printavo" | "chipply">(() => new URLSearchParams(window.location.search).get("source") === "chipply" ? "chipply" : "printavo");
  if (source === "chipply") return <AppShell><div className="flex h-full flex-col overflow-auto"><ReportSourceSelector source={source} onChange={setSource} /><ChipplyReport /></div></AppShell>;
  return <PrintavoReports onSourceChange={setSource} />;
}

function PrintavoReports({ onSourceChange }: { onSourceChange: (source: "printavo" | "chipply") => void }) {
  const [activeTab, setActiveTab] = useState<BreakdownType>('table');
  const [artworkInitialized, setArtworkInitialized] = useState(false);
  const selectTab = (tab: BreakdownType) => {
    if (tab === 'artwork') {
      setShowFilters(true);
      if (!statuses.length) setExclude(prev => [...new Set([...prev, "statuses"])]);
    }
    if (tab === 'artwork' && !artworkInitialized) {
      setArtworkInitialized(true);
      setReportMode("normal");
      setNormalOrderType("invoice");
      setDateBasis("invoice");
      setPage(0);
    }
    setActiveTab(tab);
  };
  const [reportMode, setReportMode] = useState<ReportMode>("normal");
  const [activityPreset, setActivityPreset] = useState<ActivityPreset>("today");
  const defaultActivityRange = activityPresetRange("today");
  const [activityStart, setActivityStart] = useState(defaultActivityRange.start);
  const [activityEnd, setActivityEnd] = useState(defaultActivityRange.end);
  const [activityOwner, setActivityOwner] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [page, setPage] = useState(0);
  const [quantityRange, setQuantityRange] = useState<string | null>(null);
  const limit = 100;
  
  // Filter state
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [normalOrderType, setNormalOrderType] = useState<"invoice" | "quote" | "all">("invoice");
  const [activityOrderType, setActivityOrderType] = useState<"invoice" | "quote" | "all">("all");
  const [statuses, setStatuses] = useState<string[]>([]);
  const [brands, setBrands] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [colors, setColors] = useState<string[]>([]);
  const [styleNumbers, setStyleNumbers] = useState<string[]>([]);
  const [exclude, setExclude] = useState<string[]>([]);
  
  const [dateBasis, setDateBasis] = useState<"created" | "invoice" | "productionDue" | "due">("created");
  const [dateStart, setDateStart] = useState("");
  const [dateEnd, setDateEnd] = useState("");
  const [datePreset, setDatePreset] = useState<ReportDatePreset | null>(null);
  
  const [minQty, setMinQty] = useState("");
  const [maxQty, setMaxQty] = useState("");
  const [minTotal, setMinTotal] = useState("");
  const [maxTotal, setMaxTotal] = useState("");
  const [historyOrder, setHistoryOrder] = useState<{ id: string; visualId: number | null } | null>(null);
  const [activityDetailOrder, setActivityDetailOrder] = useState<{
    id: string;
    visualId: number | null;
    invoiceAt: string | null;
  } | null>(null);

  const { data: filterOpts } = useGetReportFilterOptions();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Construct params
  const params: GetOrdersReportParams = {
    search: debouncedSearch || undefined,
    orderType: reportMode === "activity" ? activityOrderType : normalOrderType,
    statuses: statuses.length ? statuses.join("||") : undefined,
    brands: brands.length ? brands.join("||") : undefined,
    categories: categories.length ? categories.join("||") : undefined,
    colors: colors.length ? colors.join("||") : undefined,
    styleNumbers: styleNumbers.length ? styleNumbers.join("||") : undefined,
    exclude: exclude.length ? exclude.join("||") : undefined,
    createdStart: reportMode === "normal" && dateBasis === "created" && dateStart ? dateStart : undefined,
    createdEnd: reportMode === "normal" && dateBasis === "created" && dateEnd ? dateEnd : undefined,
    invoiceStart: reportMode === "normal" && dateBasis === "invoice" && dateStart ? dateStart : undefined,
    invoiceEnd: reportMode === "normal" && dateBasis === "invoice" && dateEnd ? dateEnd : undefined,
    productionDueStart: reportMode === "normal" && dateBasis === "productionDue" && dateStart ? dateStart : undefined,
    productionDueEnd: reportMode === "normal" && dateBasis === "productionDue" && dateEnd ? dateEnd : undefined,
    dueStart: reportMode === "normal" && dateBasis === "due" && dateStart ? dateStart : undefined,
    dueEnd: reportMode === "normal" && dateBasis === "due" && dateEnd ? dateEnd : undefined,
    minQty: minQty ? Number(minQty) : undefined,
    maxQty: maxQty ? Number(maxQty) : undefined,
    minTotal: minTotal ? Number(minTotal) : undefined,
    maxTotal: maxTotal ? Number(maxTotal) : undefined,
    activityOnly: reportMode === "activity" ? true : undefined,
    activityStart: reportMode === "activity" && activityStart ? activityStart : undefined,
    activityEnd: reportMode === "activity" && activityEnd ? activityEnd : undefined,
    activityOwner: reportMode === "activity" && activityOwner ? activityOwner : undefined,
  };

  const [compare, setCompare] = useState(false);
  let comparison: { current: ComparisonRange; previous: ComparisonRange; previousParams: GetOrdersReportParams } | null = null;
  let comparisonError = "";
  if (compare && reportMode === "normal") {
    try {
      const previous = previousYearRange(dateStart, dateEnd);
      comparison = { current: { start: dateStart, end: dateEnd }, previous, previousParams: previousYearFilters(params, dateBasis, previous) };
    } catch (e) { comparisonError = e instanceof Error ? e.message : "Choose a complete date range to compare."; }
  }
  const comparableTabs: BreakdownType[] = ["status", "pricing", "tier", "quantity", "style", "brand", "color", "category"];
  const comparingBreakdown = compare && reportMode === "normal" && comparableTabs.includes(activeTab);
  const enableCompare = (on: boolean) => {
    setCompare(on);
    if (on && !dateStart && !dateEnd) { const range = reportDateRange("ytd"); setDatePreset("ytd"); setDateStart(range.start); setDateEnd(range.end); setPage(0); }
  };
  const applyComparePreset = (id: ReportDatePreset) => { const range = reportDateRange(id); setCompare(true); setDatePreset(id); setDateStart(range.start); setDateEnd(range.end); setPage(0); };

  const { data: ordersData, isLoading: isLoadingOrders, isFetching: isFetchingOrders, isError: isOrdersError } = useGetOrdersReport({ ...params, limit, offset: page * limit }, {
    query: { queryKey: getGetOrdersReportQueryKey({ ...params, limit, offset: page * limit }) }
  });
  const reportOrders = ordersData?.orders ?? [];

  useEffect(() => {
    if (ordersData && ordersData.total > 0 && page * limit >= ordersData.total) {
      setPage(0);
    }
  }, [ordersData, page]);

  const { data: statusBreakdown, isLoading: isLoadingStatus } = useGetStatusBreakdown(params, { query: { queryKey: getGetStatusBreakdownQueryKey(params), enabled: activeTab === 'status' && !comparingBreakdown } });
  const { data: pricingBreakdown, isLoading: isLoadingPricing } = useGetPricingMatrixBreakdown(params, { query: { queryKey: getGetPricingMatrixBreakdownQueryKey(params), enabled: activeTab === 'pricing' && !comparingBreakdown } });
  const { data: tierBreakdown, isLoading: isLoadingTier } = useGetImprintsByTier(params, { query: { queryKey: getGetImprintsByTierQueryKey(params), enabled: activeTab === 'tier' && !comparingBreakdown } });
  const { data: quantityBreakdown, isLoading: isLoadingQuantity } = useGetOrderQuantityBreakdown(params, { query: { queryKey: getGetOrderQuantityBreakdownQueryKey(params), enabled: activeTab === 'quantity' && !comparingBreakdown } });
  const { data: styleBreakdown, isLoading: isLoadingStyle } = useGetStyleNumberBreakdown(params, { query: { queryKey: getGetStyleNumberBreakdownQueryKey(params), enabled: activeTab === 'style' && !comparingBreakdown } });
  const { data: brandBreakdown, isLoading: isLoadingBrand } = useGetBrandBreakdown(params, { query: { queryKey: getGetBrandBreakdownQueryKey(params), enabled: activeTab === 'brand' && !comparingBreakdown } });
  const { data: colorBreakdown, isLoading: isLoadingColor } = useGetColorBreakdown(params, { query: { queryKey: getGetColorBreakdownQueryKey(params), enabled: activeTab === 'color' && !comparingBreakdown } });

  const categoryQuery = useGetCategoryBreakdown(params, { query: { queryKey: getGetCategoryBreakdownQueryKey(params), enabled: activeTab === 'category' && !comparingBreakdown } });
  const activeBreakdownData = 
    activeTab === 'category' ? categoryQuery.data :
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
    setNormalOrderType("invoice");
    setActivityOrderType("all");
    setStatuses([]);
    setBrands([]);
    setCategories([]);
    setColors([]);
    setStyleNumbers([]);
    setExclude([]);
    setDateStart("");
    setDateEnd("");
    setDatePreset(null);
    setCompare(false);
    setMinQty("");
    setMaxQty("");
    setMinTotal("");
    setMaxTotal("");
    const todayRange = activityPresetRange("today");
    setActivityPreset("today");
    setActivityStart(todayRange.start);
    setActivityEnd(todayRange.end);
    setActivityOwner("");
    setPage(0);
  };

  const hasActiveFilters = search || (reportMode === "normal" ? normalOrderType !== "invoice" : activityOrderType !== "all") || statuses.length || brands.length || categories.length || colors.length || styleNumbers.length || exclude.length || (reportMode === "normal" && (dateStart || dateEnd)) || minQty || maxQty || minTotal || maxTotal || (reportMode === "activity" && (activityOwner || activityPreset !== "today"));

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-auto">
        <ReportSourceSelector source="printavo" onChange={onSourceChange} />
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
                 {reportMode === "activity" ? <Activity className="text-[#10b981]" size={24} /> : <FileText className="text-[#10b981]" size={24} />}
                 {reportMode === "activity" ? "Activity Report" : "Orders Report"}
              </h1>
               <p className="text-xs text-slate-400 mt-1">
                 {reportMode === "activity"
                   ? "Orders with recorded changes observed in the selected range."
                   : "Comprehensive view of all print jobs and quotes."}
               </p>
            </div>
            
            <div className="flex items-center gap-3">
               <div className="flex rounded-md border border-slate-700 bg-slate-900 p-0.5" role="tablist" aria-label="Report mode">
                 <button
                   type="button"
                   role="tab"
                   aria-selected={reportMode === "normal"}
                   onClick={() => { setReportMode("normal"); setPage(0); }}
                   className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${reportMode === "normal" ? "bg-slate-700 text-white" : "text-slate-400 hover:text-white"}`}
                 >
                   Orders
                 </button>
                 <button
                   type="button"
                   role="tab"
                   aria-selected={reportMode === "activity"}
                   onClick={() => { setReportMode("activity"); setPage(0); }}
                   className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${reportMode === "activity" ? "bg-[#059669]/30 text-[#10b981]" : "text-slate-400 hover:text-white"}`}
                 >
                   Activity
                 </button>
               </div>
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

          {reportMode === "normal" && (
            <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2" data-testid="panel-compare-controls">
              <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-slate-200">
                <input type="checkbox" role="switch" aria-checked={compare} checked={compare} onChange={e => enableCompare(e.target.checked)} className="h-4 w-4 accent-[#10b981]" data-testid="toggle-compare-last-year" />
                <GitCompare size={14} className="text-[#10b981]" /> Compare with last year
              </label>
              <div className="flex flex-wrap items-center gap-1.5 text-xs">
                <select aria-label="Comparison date basis" value={dateBasis} onChange={e => { setDateBasis(e.target.value as typeof dateBasis); setPage(0); }} className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-white">
                  <option value="created">Created</option><option value="invoice">Invoice date</option><option value="productionDue">Production due</option><option value="due">Customer due</option>
                </select>
                <input aria-label="Comparison start date" type="date" value={dateStart} onChange={e => { setDatePreset(null); setDateStart(e.target.value); setPage(0); }} className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white" />
                <span className="text-slate-500">to</span>
                <input aria-label="Comparison end date" type="date" value={dateEnd} onChange={e => { setDatePreset(null); setDateEnd(e.target.value); setPage(0); }} className="rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-white" />
              </div>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Comparison presets">
                {REPORT_DATE_PRESETS.map(([id, label, description]) => <button key={id} type="button" title={`${description} compared with the same calendar dates a year earlier`} onClick={() => applyComparePreset(id)} aria-pressed={compare && datePreset === id} data-testid={`button-compare-preset-${id}`}
                  className={`rounded border px-2 py-1 text-[11px] ${compare && datePreset === id ? "border-emerald-500 bg-emerald-950 text-emerald-300" : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500"}`}>{label} vs prior year</button>)}
              </div>
              {compare && (comparison ? (
                <p className="text-[11px] text-slate-400" data-testid="text-compare-ranges">Current <span className="font-mono text-slate-200">{rangeLabel(comparison.current)}</span> vs prior <span className="font-mono text-slate-200">{rangeLabel(comparison.previous)}</span> <span className="text-slate-500">(inclusive)</span></p>
              ) : (
                <p role="alert" className="text-[11px] text-amber-300" data-testid="text-compare-invalid">{comparisonError} Comparison is paused until the range is complete.</p>
              ))}
            </div>
          )}

          {showFilters && (
            <div className="mt-4 p-4 bg-slate-900/80 border border-slate-700 rounded-xl space-y-4">
              <div className="flex items-center justify-between">
                 <h3 className="text-sm font-bold text-white">{reportMode === "activity" ? "Filter Activity" : "Filter Orders"}</h3>
                <button onClick={clearAllFilters} className="text-xs text-slate-400 hover:text-white">Clear All</button>
              </div>
               {reportMode === "activity" && (
                 <div className="grid grid-cols-4 gap-4 rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-3">
                   <div className="space-y-1">
                     <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider flex items-center gap-1">
                       <CalendarDays size={12} /> Activity Range
                     </label>
                     <select
                       value={activityPreset}
                       onChange={(e) => {
                         const next = e.target.value as ActivityPreset;
                         setActivityPreset(next);
                         if (next !== "custom") {
                           const range = activityPresetRange(next);
                           setActivityStart(range.start);
                           setActivityEnd(range.end);
                         }
                         setPage(0);
                       }}
                       className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5"
                     >
                       <option value="today">Today</option>
                       {REPORT_DATE_PRESETS.filter(([id]) => id !== "today").map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                       <option value="custom">Custom dates</option>
                     </select>
                   </div>
                   <div className="space-y-1 col-span-2">
                     <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Observed between</label>
                     <div className="flex items-center gap-2">
                       <input
                         type="date"
                         value={activityStart}
                         onChange={(e) => { setActivityPreset("custom"); setActivityStart(e.target.value); setPage(0); }}
                         className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5"
                       />
                       <span className="text-slate-500 text-xs">to</span>
                       <input
                         type="date"
                         value={activityEnd}
                         onChange={(e) => { setActivityPreset("custom"); setActivityEnd(e.target.value); setPage(0); }}
                         className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5"
                       />
                     </div>
                   </div>
                   <div className="space-y-1">
                     <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Current invoice owner</label>
                     <select
                       value={activityOwner}
                       onChange={(e) => { setActivityOwner(e.target.value); setPage(0); }}
                       className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5"
                     >
                       <option value="">All owners</option>
                       {filterOpts?.owners?.map((owner) => <option key={owner} value={owner}>{owner}</option>)}
                     </select>
                   </div>
                 </div>
               )}
              <div className="grid grid-cols-4 gap-4">
                <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Order Type</label>
                  <select
                    value={reportMode === "activity" ? activityOrderType : normalOrderType}
                    onChange={e => {
                      const next = e.target.value as "invoice" | "quote" | "all";
                      if (reportMode === "activity") setActivityOrderType(next);
                      else setNormalOrderType(next);
                      setPage(0);
                    }}
                    className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5"
                  >
                    <option value="invoice">Invoice</option>
                    <option value="quote">Quote</option>
                    <option value="all">All</option>
                  </select>
                </div>
                {reportMode === "normal" && <div className="space-y-1 col-span-2">
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
                    <input aria-label="Report start date" type="date" value={dateStart} onChange={e => { setDatePreset(null); setDateStart(e.target.value); setPage(0); }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5" />
                    <span className="text-slate-500 text-xs">to</span>
                    <input aria-label="Report end date" type="date" value={dateEnd} onChange={e => { setDatePreset(null); setDateEnd(e.target.value); setPage(0); }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5" />
                  </div>
                  <div className="flex flex-wrap gap-1 pt-1" role="group" aria-label="Date range presets">
                    {REPORT_DATE_PRESETS.map(([id, label, title]) => <button key={id} type="button" title={title} aria-label={title} aria-pressed={datePreset === id}
                      data-testid={`report-date-preset-${id}`}
                      onClick={() => { const range = reportDateRange(id); setDatePreset(id); setDateStart(range.start); setDateEnd(range.end); setPage(0); }}
                      className={`rounded border px-2 py-1 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 ${datePreset === id ? "border-emerald-500 bg-emerald-950 text-emerald-300" : "border-slate-700 bg-slate-800 text-slate-300 hover:border-slate-500"}`}>{label}</button>)}
                  </div>
                  <p className="text-[10px] text-slate-500">Eastern time · Monday–Sunday weeks · Calendar quarters</p>
                </div>}
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {activeTab === 'artwork' ? <ArtworkStatusFilter options={filterOpts?.statuses ?? []} selected={statuses}
                  excluding={exclude.includes("statuses")} onChange={(next, excluding) => {
                    setStatuses(next);
                    setExclude(prev => excluding ? [...new Set([...prev, "statuses"])] : prev.filter(v => v !== "statuses"));
                    setPage(0);
                  }} /> : <div className="space-y-1">
                  <label className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Statuses</label>
                  <select value="" onChange={e => { if (e.target.value) { toggleFilter(setStatuses, e.target.value); setPage(0); } }} className="w-full bg-slate-800 border border-slate-700 text-white text-xs rounded px-2 py-1.5">
                    <option value="">Add status...</option>
                    {filterOpts?.statuses?.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {statuses.map(s => <span key={s} className="text-[9px] bg-[#10b981]/20 text-[#10b981] border border-[#10b981]/30 px-1.5 py-0.5 rounded flex items-center gap-1">{s} <X size={8} className="cursor-pointer" onClick={() => { toggleFilter(setStatuses, s); setPage(0); }}/></span>)}
                  </div>
                </div>}
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

           {!isLoadingOrders && !isFetchingOrders && ordersData?.stats && (
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
               {reportMode === "activity" && (
                 <>
                   <div className="bg-emerald-950/20 rounded-lg border border-emerald-900/50 p-4">
                     <div className="text-xs text-slate-400 font-medium mb-1">Affected Orders</div>
                     <div className="text-2xl font-bold text-[#10b981]">{formatNumber(ordersData.stats.activity.affectedOrders)}</div>
                     <div className="text-[10px] text-slate-500 mt-1">Distinct invoices/quotes with activity</div>
                   </div>
                   <div className="bg-emerald-950/20 rounded-lg border border-emerald-900/50 p-4">
                     <div className="text-xs text-slate-400 font-medium mb-1">Recorded Changes</div>
                     <div className="text-2xl font-bold text-white">{formatNumber(ordersData.stats.activity.changes)}</div>
                     <div className="text-[10px] text-slate-500 mt-1">Status, field, updated, and line-item changes</div>
                   </div>
                   <div className="bg-emerald-950/20 rounded-lg border border-emerald-900/50 p-4">
                     <div className="text-xs text-slate-400 font-medium mb-1">Invoice / Quote</div>
                     <div className="text-lg font-bold text-white">
                       {formatNumber(ordersData.stats.activity.byOrderType.invoice)} <span className="text-slate-500 font-normal">/</span>{" "}
                       {formatNumber(ordersData.stats.activity.byOrderType.quote)}
                     </div>
                     <div className="text-[10px] text-slate-500 mt-1">Affected orders by current type</div>
                   </div>
                 </>
               )}
            </div>
          )}
           {!isLoadingOrders && !isFetchingOrders && reportMode === "activity" && ordersData?.stats && (
             <div className="mt-4 rounded-lg border border-emerald-900/40 bg-emerald-950/10 p-4">
               <div className="flex items-center justify-between mb-3">
                 <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Changes by category</div>
                 <div className="text-xs text-slate-500">
                   Total: <span className="font-mono text-slate-300">{formatNumber(ordersData.stats.activity.changes)}</span>
                 </div>
               </div>
                <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
                 {([
                   ["quantity", "Qty"],
                   ["lineItem", "Line Item"],
                   ["price", "Price"],
                    ["balance", "Balance / payment"],
                   ["status", "Status"],
                   ["order", "Other order changes"],
                 ] as const).map(([key, label]) => (
                   <div key={key} className="rounded border border-slate-800 bg-slate-900/60 px-3 py-2">
                     <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
                     <div className="mt-1 font-mono text-lg font-bold text-white">
                       {formatNumber(ordersData.stats.activity.byCategory[key])}
                     </div>
                   </div>
                 ))}
               </div>
             </div>
           )}

          <div className="mt-6 border-b border-slate-800 flex overflow-x-auto custom-scrollbar">
            {[
              { id: 'table', label: 'Orders List' },
              { id: 'status', label: 'By Status' },
              { id: 'pricing', label: 'By Pricing Matrix' },
              { id: 'tier', label: 'By Imprint Tier' },
              { id: 'quantity', label: 'By QTY' },
              { id: 'style', label: 'By Style' },
              { id: 'brand', label: 'By Brand' },
              { id: 'color', label: 'By Color' },
              { id: 'fees', label: 'By Fees' },
              { id: 'category', label: 'By Category' },
              { id: 'decoration', label: 'Decoration Production' },
              { id: 'artwork', label: 'Artwork & Proofing' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => selectTab(tab.id as BreakdownType)}
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

        <div className="flex-1 shrink-0 p-6 bg-[#020617]">
          {activeTab === 'table' ? (
            <div className="flex flex-col space-y-4">
                {comparison && <SummaryComparison currentParams={params} previousParams={comparison.previousParams} currentRange={comparison.current} previousRange={comparison.previous} />}
                {isLoadingOrders || isFetchingOrders ? (
                <div className="flex items-center justify-center flex-1">
                  <Loader2 className="animate-spin text-[#10b981]" size={32} />
                </div>
               ) : isOrdersError ? (
                 <div className="flex items-center justify-center flex-1 text-sm text-red-400">
                   We couldn't load this report. Please try again.
                 </div>
              ) : (
                <>
                  <div className="bg-slate-900/30 border border-slate-800 rounded-xl overflow-x-auto shadow-2xl shrink-0">
                    <table className="w-full text-sm text-left whitespace-nowrap">
                      <thead className="text-xs text-slate-400 bg-slate-900/80 uppercase font-semibold border-b border-slate-800 tracking-wider">
                        <tr>
                          <th className="px-6 py-4">ID</th>
                          <th className="px-6 py-4">Type</th>
                          <th className="px-6 py-4">Customer</th>
                          <th className="px-6 py-4">Details</th>
                          <th className="px-6 py-4">Status</th>
                            {reportMode === "activity" && <th className="px-6 py-4">Activity Count</th>}
                           {reportMode === "activity" && <th className="px-6 py-4">Latest observed</th>}
                          <th className="px-6 py-4">Created</th>
                          <th className="px-6 py-4 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800">
                         {reportOrders.map((order) => (
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
                             {reportMode === "activity" && (
                                <td className="px-6 py-4 font-mono text-[#10b981]">
                                  <button
                                    type="button"
                                    data-testid={`button-activity-count-${order.id}`}
                                    disabled={order.activityCount <= 0}
                                    onClick={() =>
                                      setActivityDetailOrder({
                                        id: order.id,
                                        visualId: order.visualId,
                                        invoiceAt: order.invoiceAt,
                                      })
                                    }
                                    className="rounded px-1.5 py-1 text-left underline decoration-dotted underline-offset-4 transition-colors hover:bg-emerald-950/40 hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/60 disabled:cursor-default disabled:no-underline disabled:opacity-60"
                                    title="View qualifying activity details"
                                    aria-label={`View ${order.activityCount} activity changes for order ${order.visualId ?? order.id}`}
                                  >
                                    {formatNumber(order.activityCount)}
                                  </button>
                               </td>
                             )}
                             {reportMode === "activity" && (
                               <td className="px-6 py-4 text-slate-400 text-xs">
                                 {formatObservedAt(order.latestActivityAt)}
                               </td>
                             )}
                            <td className="px-6 py-4 text-slate-400 font-mono text-xs">{formatDate(order.createdAt)}</td>
                            <td className="px-6 py-4 text-right font-mono font-bold text-[#10b981]">
                              {formatMoney(order.total)}
                            </td>
                          </tr>
                        ))}
                         {ordersData && reportOrders.length === 0 && (
                          <tr>
                             <td colSpan={reportMode === "activity" ? 9 : 7} className="px-6 py-12 text-center text-slate-500">
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
              {activeTab === 'quantity' && <p className="mb-3 text-sm text-slate-400">Click a range or order count to see matching orders. Ranges use total order quantity and include both endpoints. Orders with zero quantity are excluded.</p>}
              {activeTab === 'category' && <p className="mb-3 text-sm text-slate-400">Line-item categories: revenue is price × quantity, excluding invoice fees and taxes. Orders count once per category and may appear in more than one. Missing categories appear as Uncategorized.</p>}
              {!comparingBreakdown && activeTab !== 'artwork' && <p className="mb-3 text-xs text-slate-400">
                Percentages use the full filtered report totals. Orders may appear in multiple groups,
                so their percentages may add up to more than 100%. Quantity uses each row’s existing allocation.
              </p>}
              {comparison && (activeTab === 'fees' || activeTab === 'decoration') && (
                <div className="mb-4 space-y-3">
                  <SummaryComparison currentParams={params} previousParams={comparison.previousParams} currentRange={comparison.current} previousRange={comparison.previous} />
                  <p className="text-xs text-slate-400" data-testid="text-summary-only-note">Last-year comparison for {activeTab === 'fees' ? 'fees' : 'decoration production'} is summary-only. This breakdown has no prior-year version, so the report below shows the current period only.</p>
                </div>
              )}
              {comparingBreakdown ? (comparison ? <BreakdownComparison tab={activeTab as ComparableTab} currentParams={params} previousParams={comparison.previousParams} currentRange={comparison.current} previousRange={comparison.previous} /> : <div className="rounded-xl border border-dashed border-amber-800/60 p-10 text-center text-sm text-amber-300">Choose a complete, valid date range to compare. {comparisonError}</div>) : activeTab === 'category' && categoryQuery.isError ? <p role="alert" className="p-6 text-red-300">Unable to load categories. <button className="underline" onClick={() => categoryQuery.refetch()}>Retry</button></p> : activeTab === 'fees' ? <FeeReport params={params} /> : activeTab === 'decoration' ? <DecorationProductionReport params={params} /> : activeTab === 'artwork' ? <ArtworkReport params={params} dateBasis={dateBasis} /> : isLoadingBreakdown || (activeTab === 'category' && categoryQuery.isLoading) ? (
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
                        <th className="px-6 py-4 text-right whitespace-nowrap">% of Orders</th>
                        <th className="px-6 py-4 text-right">Quantity</th>
                        <th className="px-6 py-4 text-right whitespace-nowrap">% of QTY</th>
                        <th className="px-6 py-4 text-right">Revenue</th>
                        <th className="px-6 py-4 text-right">% of Revenue</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800">
                      {activeBreakdownData.rows.map((row) => (
                        <tr key={row.label} className="hover:bg-slate-800/40 transition-colors">
                          <td className="px-6 py-4 font-medium text-white">{activeTab === 'quantity' ? <button className="text-emerald-400 underline underline-offset-4" onClick={() => setQuantityRange(row.label)}>QTY {row.label}</button> : row.label}</td>
                          <td className="px-6 py-4 text-right text-slate-300">{activeTab === 'quantity' ? <button aria-label={`View ${row.orders} orders with quantity ${row.label}`} className="text-emerald-400 underline underline-offset-4" onClick={() => setQuantityRange(row.label)}>{formatNumber(row.orders)}</button> : formatNumber(row.orders)}</td>
                          <ShareCell value={row.orders} total={activeBreakdownData.stats.orders} />
                          <td className="px-6 py-4 text-right text-slate-300">{formatNumber(row.quantity)}</td>
                          <ShareCell value={row.quantity} total={activeBreakdownData.stats.quantity} />
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
                          <td colSpan={7} className="px-6 py-12 text-center text-slate-500">
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
      {quantityRange && <QuantityOrders key={`${quantityRange}:${JSON.stringify(params)}`} range={quantityRange} params={params} onClose={() => setQuantityRange(null)} />}
      <OrderLineItemHistory
        orderId={historyOrder?.id ?? null}
        visualId={historyOrder?.visualId ?? null}
        open={historyOrder !== null}
        onOpenChange={(open) => {
          if (!open) setHistoryOrder(null);
        }}
      />
      <ActivityOrderDetailPanel
        orderId={activityDetailOrder?.id ?? null}
        visualId={activityDetailOrder?.visualId ?? null}
        invoiceAt={activityDetailOrder?.invoiceAt ?? null}
        open={activityDetailOrder !== null}
        activityStart={activityStart}
        activityEnd={activityEnd}
        activityOwner={activityOwner}
        onOpenChange={(open) => {
          if (!open) setActivityDetailOrder(null);
        }}
      />
    </AppShell>
  );
}
