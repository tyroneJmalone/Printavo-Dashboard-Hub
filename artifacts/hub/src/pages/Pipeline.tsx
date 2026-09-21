import { AppShell } from "@/components/layout/AppShell";
import { useStaff } from "@/components/auth/StaffGate";
import { formatNumber } from "@/lib/format";
import { useEffect, useRef, useState } from "react";
import { Filter, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { 
  useGetPipeline, 
  getGetPipelineQueryKey,
} from "@workspace/api-client-react";
import type { 
  PipelineViewConfig, 
  PipelineViewConfigStage, 
  PipelineViewConfigSort,
  GetPipelineParams
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";

import { usePipelineViews } from "./pipeline/usePipelineViews";
import { PipelineViewMenu } from "./pipeline/PipelineViewMenu";
import { PipelineDateRangePop } from "./pipeline/PipelineDateRangePop";
import { PipelineStageCards } from "./pipeline/PipelineStageCards";
import { PipelineRepTabs } from "./pipeline/PipelineRepTabs";
import { PipelineTable } from "./pipeline/PipelineTable";

const WON_WINDOW_OPTIONS = [30, 60, 90, 180, 365];
const PAGE_SIZE = 200;

export const DEFAULT_CONFIG: PipelineViewConfig = {
  q: "",
  createdFrom: "",
  createdTo: "",
  invoiceFrom: "",
  invoiceTo: "",
  productionDueFrom: "",
  productionDueTo: "",
  customerDueFrom: "",
  customerDueTo: "",
  stage: "active",
  owner: undefined,
  wonDays: 90,
  sort: undefined,
  direction: undefined,
};

function normalizeConfig(c: Partial<PipelineViewConfig>): PipelineViewConfig {
  return {
    q: c.q ?? "",
    createdFrom: c.createdFrom ?? "",
    createdTo: c.createdTo ?? "",
    invoiceFrom: c.invoiceFrom ?? "",
    invoiceTo: c.invoiceTo ?? "",
    productionDueFrom: c.productionDueFrom ?? "",
    productionDueTo: c.productionDueTo ?? "",
    customerDueFrom: c.customerDueFrom ?? "",
    customerDueTo: c.customerDueTo ?? "",
    stage: c.stage ?? "active",
    owner: c.owner === null ? undefined : c.owner,
    wonDays: c.wonDays ?? 90,
    sort: c.sort,
    direction: c.direction,
  };
}

function isConfigEqual(a: PipelineViewConfig, b: PipelineViewConfig) {
  return (
    a.q === b.q &&
    a.createdFrom === b.createdFrom &&
    a.createdTo === b.createdTo &&
    a.invoiceFrom === b.invoiceFrom &&
    a.invoiceTo === b.invoiceTo &&
    a.productionDueFrom === b.productionDueFrom &&
    a.productionDueTo === b.productionDueTo &&
    a.customerDueFrom === b.customerDueFrom &&
    a.customerDueTo === b.customerDueTo &&
    a.stage === b.stage &&
    a.owner === b.owner &&
    a.wonDays === b.wonDays &&
    a.sort === b.sort &&
    a.direction === b.direction
  );
}

function validateDateRange(from?: string, to?: string) {
  return from && to && from > to ? true : false;
}

export default function Pipeline() {
  const { email } = useStaff();
  return <PipelineContent key={email} />;
}

function PipelineContent() {
  const { email: myEmail } = useStaff();
  const { 
    views, 
    viewsLoaded, 
    viewsError, 
    refetchViews,
    isMutating, 
    saveView, 
    createNewView, 
    toggleDefault, 
    renameView, 
    deleteViewById 
  } = usePipelineViews(myEmail);

  const [initMode, setInitMode] = useState<"pending" | "view-loaded" | "no-default" | "error">("pending");
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
  
  const [config, setConfig] = useState<PipelineViewConfig>(DEFAULT_CONFIG);
  const debouncedQ = useDebounce(config.q || "", 400);
  const [page, setPage] = useState(0);

  const appliedDefaultRep = useRef(false);

  // 1. Initialize from default view, fallback to pending, or handle error
  useEffect(() => {
    if (initMode !== "pending") return;
    if (viewsError) {
      setInitMode("error");
      return;
    }
    if (viewsLoaded) {
      const defaultView = views.find(v => v.isDefault);
      if (defaultView) {
        setConfig(normalizeConfig(defaultView.config));
        setSelectedViewId(defaultView.id);
        setInitMode("view-loaded");
      } else {
        setInitMode("no-default");
      }
    }
  }, [viewsLoaded, viewsError, views, initMode]);

  const selectedView = views.find(v => v.id === selectedViewId);
  const hasExplicitDates = [
    config.createdFrom, config.createdTo, config.invoiceFrom, config.invoiceTo,
    config.productionDueFrom, config.productionDueTo, config.customerDueFrom, config.customerDueTo,
  ].some(Boolean);
  const isDirty = selectedView ? !isConfigEqual(config, normalizeConfig(selectedView.config)) : false;

  const hasInvalidDates = validateDateRange(config.createdFrom, config.createdTo) ||
                          validateDateRange(config.invoiceFrom, config.invoiceTo) ||
                          validateDateRange(config.productionDueFrom, config.productionDueTo) ||
                          validateDateRange(config.customerDueFrom, config.customerDueTo);

  // 2. Main Data Query
  const params: GetPipelineParams = {
    stage: config.stage as any,
    wonDays: config.wonDays,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  if (config.owner !== undefined && config.owner !== null) params.owner = config.owner;
  if (debouncedQ) params.q = debouncedQ;
  if (config.createdFrom) params.createdFrom = config.createdFrom;
  if (config.createdTo) params.createdTo = config.createdTo;
  if (config.invoiceFrom) params.invoiceFrom = config.invoiceFrom;
  if (config.invoiceTo) params.invoiceTo = config.invoiceTo;
  if (config.productionDueFrom) params.productionDueFrom = config.productionDueFrom;
  if (config.productionDueTo) params.productionDueTo = config.productionDueTo;
  if (config.customerDueFrom) params.customerDueFrom = config.customerDueFrom;
  if (config.customerDueTo) params.customerDueTo = config.customerDueTo;
  if (config.sort) params.sort = config.sort;
  if (config.direction) params.direction = config.direction;

  const { data, isLoading, isError } = useGetPipeline(params, {
    query: {
      enabled: initMode !== "pending" && !hasInvalidDates && debouncedQ === (config.q || ""),
      queryKey: getGetPipelineQueryKey(params)
    }
  });

  // 3. Default rep logic if no view was loaded
  useEffect(() => {
    if ((initMode === "no-default" || initMode === "error") && data && !appliedDefaultRep.current) {
      appliedDefaultRep.current = true;
      const mine = data.owners?.find(o => o.email.toLowerCase() === myEmail.toLowerCase());
      if (mine) {
        setConfig(c => ({ ...c, owner: mine.email.toLowerCase() }));
      }
    }
  }, [initMode, data, myEmail]);

  // Snap page on dataset shrinking
  useEffect(() => {
    if (data && data.rows?.length === 0 && page > 0) setPage(0);
  }, [data, page]);

  const updateConfig = (updates: Partial<PipelineViewConfig>) => {
    setConfig(c => ({ ...c, ...updates }));
    setPage(0);
  };

  const handleSort = (column: PipelineViewConfigSort) => {
    setConfig(c => {
      if (c.sort === column) {
        if (c.direction === "asc") return { ...c, direction: "desc" };
        if (c.direction === "desc") return { ...c, sort: undefined, direction: undefined };
      }
      return { ...c, sort: column, direction: "asc" };
    });
    setPage(0);
  };

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const showRepColumn = config.owner === undefined || config.owner === null;
  const showStageColumn = config.stage === "active";

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-4">
              <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
                <Filter className="text-[#10b981]" size={24} />
                Pipeline
              </h1>
              
              <div className="h-6 w-px bg-slate-800 hidden md:block" />

              <PipelineViewMenu
                views={views}
                selectedViewId={selectedViewId}
                isDirty={isDirty}
                isMutating={isMutating || !viewsLoaded}
                onSelect={(val) => {
                  if (val === null) {
                    setSelectedViewId(null);
                    setConfig(DEFAULT_CONFIG);
                  } else {
                    const v = views.find(x => x.id === val);
                    if (v) {
                      setSelectedViewId(v.id);
                      setConfig(normalizeConfig(v.config));
                    }
                  }
                  setPage(0);
                }}
                onSave={() => {
                  if (selectedViewId) saveView(selectedViewId, config);
                }}
                onSaveAs={async (name) => {
                  const res = await createNewView(name, config);
                  if (res && res.id) setSelectedViewId(res.id);
                  return !!res;
                }}
                onToggleDefault={() => {
                  if (selectedViewId && selectedView) {
                    toggleDefault(selectedViewId, selectedView.isDefault);
                  }
                }}
                onRename={async (name) => {
                  if (!selectedViewId) return false;
                  return await renameView(selectedViewId, name);
                }}
                onDelete={async () => {
                  if (selectedViewId) {
                    const success = await deleteViewById(selectedViewId);
                    if (success) {
                      setSelectedViewId(null);
                      setConfig(DEFAULT_CONFIG);
                    }
                  }
                }}
              />
            </div>

            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative w-64">
                <Search className="absolute left-2.5 top-2 text-slate-400" size={14} />
                <Input
                  className="pl-8 h-8 bg-slate-900 border-slate-700 text-xs focus-visible:ring-[#10b981]"
                  placeholder="Search invoice, nickname, customer..."
                  value={config.q || ""}
                  onChange={(e) => updateConfig({ q: e.target.value })}
                />
              </div>

              <PipelineDateRangePop config={config} onChange={updateConfig} />

              <label className="flex items-center gap-2 text-xs text-slate-400">
                Won/Done window
                <select
                  disabled={hasExplicitDates}
                  title={hasExplicitDates ? "Your explicit date filters replace this window." : undefined}
                  value={config.wonDays}
                  onChange={(e) => updateConfig({ wonDays: Number(e.target.value) })}
                  className="bg-slate-900 border border-slate-700 rounded px-2 py-1 h-8 text-xs text-slate-200 focus:outline-none focus:border-[#10b981]"
                >
                  {WON_WINDOW_OPTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d} days
                    </option>
                  ))}
                </select>
              </label>
              {hasExplicitDates && <span className="text-xs text-slate-400">Using selected date ranges</span>}
            </div>
          </div>

          {viewsError && (
            <div role="alert" className="mt-3 text-sm text-amber-300">
              Saved views could not be loaded. Your saved default has not been applied.{" "}
              <button type="button" className="underline" onClick={async () => {
                const result = await refetchViews();
                if (result.isSuccess) setInitMode("pending");
              }}>Retry</button>
            </div>
          )}

          <PipelineRepTabs 
            owners={data?.owners ?? []} 
            activeOwner={config.owner} 
            onSelect={owner => updateConfig({ owner })} 
          />
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="px-6 pt-4">
            <PipelineStageCards 
              stages={data?.stages ?? []} 
              activeStage={config.stage as PipelineViewConfigStage} 
              onSelect={stage => updateConfig({ stage })} 
            />
          </div>

          <div className="px-6 py-4">
            <PipelineTable 
              rows={data?.rows ?? []}
              stages={data?.stages ?? []}
              sort={config.sort}
              direction={config.direction}
              onSort={handleSort}
              showRepColumn={showRepColumn}
              showStageColumn={showStageColumn}
              isLoading={isLoading || initMode === "pending"}
              isError={isError}
              hasInvalidDates={hasInvalidDates}
            />

            {/* Pagination */}
            {total > PAGE_SIZE && !hasInvalidDates && (
              <div className="flex items-center justify-between mt-3 text-xs text-slate-400">
                <span>
                  Showing {page * PAGE_SIZE + 1}–
                  {Math.min((page + 1) * PAGE_SIZE, total)} of{" "}
                  {formatNumber(total)}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    className="p-1.5 rounded border border-slate-700 disabled:opacity-40 hover:border-slate-500 transition-colors"
                  >
                    <ChevronLeft size={14} />
                  </button>
                  <span>
                    Page {page + 1} / {pageCount}
                  </span>
                  <button
                    disabled={page + 1 >= pageCount}
                    onClick={() => setPage((p) => p + 1)}
                    className="p-1.5 rounded border border-slate-700 disabled:opacity-40 hover:border-slate-500 transition-colors"
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>
            )}

            <p className="text-[11px] text-slate-600 mt-4">
              Times marked with "+" predate status tracking (began July 8) —
              the order has been in its status at least that long. Merch store
              source quotes are excluded. Won/Done show invoices, since a
              winning quote becomes an invoice in Printavo. Search applies to Invoice Number, Nickname, Customer Name, and Company Name.
            </p>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
