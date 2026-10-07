import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Info, Layers, X } from "lucide-react";
import {
  useGetDecorationProduction,
  getGetDecorationProductionQueryKey,
  type GetOrdersReportParams,
  type GetDecorationProductionParams,
  type DecorationProductionTotals,
  type DecorationProductionJob,
  type DecorationProductionLocation,
} from "@workspace/api-client-react";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { formatMoney, formatNumber } from "@/lib/format";

type Method = "print" | "embroidery";
const LIMIT = 20;

const num = (v: number | null | undefined, digits = 0) =>
  v === null || v === undefined ? "—" : digits ? v.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits }) : formatNumber(v);
const money = (v: number | null | undefined) => (v === null || v === undefined ? "—" : formatMoney(v));

function workLabel(method: Method) {
  return method === "print" ? "Impressions" : "Estimated stitches";
}

function WorkUnits({ t, method }: { t: DecorationProductionTotals; method: Method }) {
  if (t.workUnits !== null) return <span>{num(t.workUnits)}</span>;
  return (
    <span className="inline-flex flex-col">
      <span className="text-amber-300">Unknown / incomplete</span>
      <span className="text-[10px] font-normal text-slate-400">
        Known subtotal {num(t.knownWorkUnits)} · {num(t.unknownLocations)} unknown location{t.unknownLocations === 1 ? "" : "s"}
      </span>
      <span className="sr-only">{workLabel(method)}</span>
    </span>
  );
}

function Stat({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3" title={hint}>
      <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-bold tabular-nums text-white">{children}</div>
    </div>
  );
}

function LocationRow({ loc, method, qty }: { loc: DecorationProductionLocation; method: Method; qty: number }) {
  return (
    <tr className="border-t border-slate-800/70 align-top">
      <td className="py-1.5 pr-3 font-medium text-slate-200 whitespace-nowrap">{loc.label}</td>
      <td className="py-1.5 pr-3 tabular-nums text-slate-200">
        {loc.complexity === null ? <span className="text-amber-300">Unknown</span> : num(loc.complexity)}
        <span className="ml-1 text-[10px] text-slate-500">{method === "print" ? "colors" : "est. stitches/item"}</span>
      </td>
      <td className="py-1.5 pr-3 text-slate-400">{loc.tier ?? "—"}</td>
      <td className="py-1.5 pr-3 text-slate-400">{loc.matrix ?? "—"}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-slate-200" title={`${num(qty)} qty x ${loc.complexity ?? "?"}`}>
        {loc.workUnits === null ? <span className="text-amber-300">Unknown</span> : num(loc.workUnits)}
      </td>
      <td className="py-1.5 text-slate-400 whitespace-pre-wrap break-words max-w-xs">{loc.details || "—"}</td>
    </tr>
  );
}

function JobCard({ job, method }: { job: DecorationProductionJob; method: Method }) {
  const t = job.totals;
  return (
    <article className="rounded-xl border border-slate-800 bg-slate-900/40" data-testid={`card-decoration-job-${job.id}`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 px-4 py-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <PrintavoOrderLink orderId={job.id} visualId={job.visualId} className="text-emerald-400 hover:underline" />
            <span>{job.customer ?? "Unknown customer"}</span>
          </div>
          {job.nickname && <div className="text-xs text-slate-400">{job.nickname}</div>}
        </div>
        <dl className="grid grid-cols-3 gap-x-5 gap-y-1 text-right text-xs sm:grid-cols-5">
          <div><dt className="text-slate-500">Qty</dt><dd className="font-semibold tabular-nums text-white">{num(t.quantity)}</dd></div>
          <div><dt className="text-slate-500">Imprints</dt><dd className="font-semibold tabular-nums text-white">{num(t.imprints)}</dd></div>
          <div><dt className="text-slate-500">{workLabel(method)}</dt><dd className="font-semibold tabular-nums text-white"><WorkUnits t={t} method={method} /></dd></div>
          {method === "print" && <div><dt className="text-slate-500">Est. screens</dt><dd className="font-semibold tabular-nums text-white">{num(t.estimatedScreens)}</dd></div>}
          <div><dt className="text-slate-500">Avg item price</dt><dd className="font-semibold tabular-nums text-white">{money(t.averageItemPrice)}</dd></div>
        </dl>
      </header>
      <div className="divide-y divide-slate-800/70">
        {job.groups.map((g) => (
          <section key={g.id} className="px-4 py-3">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <ul className="text-xs text-slate-300">
                {g.items.length ? g.items.map((it, i) => <li key={i}>{it}</li>) : <li className="text-slate-500">No item description</li>}
              </ul>
              <div className="text-xs text-slate-400">
                <span className="font-semibold text-white tabular-nums">{num(g.quantity)}</span> qty · {g.locations.length} location{g.locations.length === 1 ? "" : "s"} · {money(g.averageItemPrice)} avg
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="pb-1 pr-3 text-left">Location</th>
                    <th className="pb-1 pr-3 text-left">{method === "print" ? "Colors" : "Est. stitches / item"}</th>
                    <th className="pb-1 pr-3 text-left">Tier</th>
                    <th className="pb-1 pr-3 text-left">Matrix</th>
                    <th className="pb-1 pr-3 text-right">{method === "print" ? "Impressions" : "Est. stitches"}</th>
                    <th className="pb-1 text-left">Details</th>
                  </tr>
                </thead>
                <tbody>{g.locations.map((l) => <LocationRow key={l.id} loc={l} method={method} qty={g.quantity} />)}</tbody>
              </table>
            </div>
          </section>
        ))}
      </div>
    </article>
  );
}

export function DecorationProductionReport({ params }: { params: GetOrdersReportParams }) {
  const [method, setMethod] = useState<Method>("print");
  const [bucket, setBucket] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const filterKey = JSON.stringify(params);

  useEffect(() => { setPage(0); setBucket(null); }, [filterKey, method]);

  const query: GetDecorationProductionParams = useMemo(() => ({
    ...(JSON.parse(filterKey) as GetOrdersReportParams),
    method,
    locationCount: bucket ?? undefined,
    limit: LIMIT,
    offset: page * LIMIT,
  }), [filterKey, method, bucket, page]);

  const { data, isLoading, isFetching, isError, refetch } = useGetDecorationProduction(query, {
    query: { queryKey: getGetDecorationProductionQueryKey(query) },
  });

  const isQuote = params.orderType === "quote";
  const s = data?.summary;
  const totalPages = data ? Math.max(1, Math.ceil(data.totalJobs / LIMIT)) : 1;
  const caveats = data ? [
    [data.excludedIncompleteInvoices, "invoices excluded because detail data is incomplete"],
    [data.unclassifiedGroups, "groups excluded because at least one imprint has an unknown or conflicting method"],
    [data.unassignedGroups, "groups not assigned to a decoration location"],
    [data.excludedQuantityGroups, "groups excluded for missing, zero, or invalid quantity"],
  ].filter(([n]) => (n as number) > 0) as [number, string][] : [];

  return (
    <div className="space-y-4" data-testid="decoration-production-report">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-md border border-slate-700 bg-slate-900 p-0.5" role="tablist" aria-label="Decoration method">
          {(["print", "embroidery"] as Method[]).map((m) => (
            <button key={m} type="button" role="tab" aria-selected={method === m} data-testid={`button-method-${m}`}
              onClick={() => setMethod(m)}
              className={`px-4 py-1.5 text-xs font-medium rounded transition-colors ${method === m ? "bg-[#059669]/30 text-[#10b981]" : "text-slate-400 hover:text-white"}`}>
              {m === "print" ? "Print" : "Embroidery"}
            </button>
          ))}
        </div>
        <p className="flex items-start gap-1.5 text-[11px] text-slate-500 max-w-2xl">
          <Info size={12} className="mt-0.5 shrink-0" />
          Invoices only; Heat excluded. Workload recorded on invoices, not a verified completion log. Activity filters use the current snapshot, not historical reconstruction.
        </p>
      </div>

      {isQuote && (
        <div role="status" className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-3 text-sm text-amber-200">
          Decoration production counts invoices only. The current Order Type filter is Quote, so no results apply. Switch Order Type to Invoice (or All) in Filters.
        </div>
      )}

      {isError ? (
        <p role="alert" className="rounded-lg border border-red-900 bg-red-950/20 p-6 text-red-300">
          Unable to load decoration production. <button className="underline" onClick={() => refetch()} data-testid="button-retry-decoration">Retry</button>
        </p>
      ) : isLoading || !data || !s ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-16 animate-pulse rounded-lg bg-slate-800/60" />)}</div>
          <div className="h-40 animate-pulse rounded-xl bg-slate-800/40" />
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-5" data-testid="decoration-summary">
            <Stat label="Invoices">{num(s.invoices)}</Stat>
            <Stat label="Item qty">{num(s.quantity)}</Stat>
            <Stat label="Imprints" hint="Quantity x locations">{num(s.imprints)}</Stat>
            <Stat label={method === "print" ? "Impressions" : "Estimated stitches"} hint={method === "print" ? "Quantity x colors at each location" : "Tier midpoint estimate, not actual stitch counts"}>
              <WorkUnits t={s} method={method} />
            </Stat>
            {method === "print" && <Stat label="Est. screens" hint="Sum of colors, no screen reuse adjustment">{num(s.estimatedScreens)}</Stat>}
            <Stat label="Avg job qty">{num(s.averageJobQuantity, 1)}</Stat>
            <Stat label="Avg decorated item price" hint="Full decorated-item sale price, not decoration-only">{money(s.averageItemPrice)}</Stat>
            <Stat label="Avg locations / item">{num(s.averageLocationsPerItem, 2)}</Stat>
          </section>
          <section className="rounded-lg border border-slate-800 p-3">
            <h3 className="mb-2 text-sm font-semibold text-white">{method === "print" ? "By colors per location" : "By estimated stitches per location"}</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs whitespace-nowrap">
                <thead className="text-slate-400"><tr>
                  <th className="p-2">{method === "print" ? "Colors" : "Est. stitches / location"}</th>
                  <th className="p-2">Assigned tiers</th><th className="p-2">Invoices</th>
                  <th className="p-2">Item qty</th><th className="p-2">Imprints</th><th className="p-2">{workLabel(method)}</th>
                </tr></thead>
                <tbody>{data.complexityBreakdown?.map(row => <tr key={row.complexity ?? "unknown"} className="border-t border-slate-800 text-slate-200">
                  <td className="p-2">{row.complexity === null ? "Unknown" : num(row.complexity)}</td>
                  <td className="p-2 whitespace-normal min-w-40 max-w-sm">{row.tiers.join(", ")}</td>
                  <td className="p-2">{num(row.totals.invoices)}</td><td className="p-2">{num(row.totals.quantity)}</td>
                  <td className="p-2">{num(row.totals.imprints)}</td><td className="p-2"><WorkUnits t={row.totals} method={method} /></td>
                </tr>)}</tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Items and invoices may appear in multiple rows when locations use different colors or stitch tiers; do not add these row counts as unique totals.</p>
          </section>
          <p className="text-[11px] text-slate-500">
            {method === "print" ? "Screens are the sum of colors with no reuse adjustment." : "Stitches are estimated from tier midpoints, not actual stitch counts."}{" "}
            Average item price is the full decorated garment sale price. Mixed-method invoices appear in both Print and Embroidery; quantities overlap and must not be summed as unique garments.
            {" "}As elsewhere in Orders Report, item filters select matching invoices; this view includes their groups for the selected method. Setup/digitizing line items are excluded from garment quantities.
          </p>

          {caveats.length > 0 && (
            <div className="rounded-lg border border-amber-900/50 bg-amber-950/10 p-3 text-xs text-amber-200" data-testid="decoration-caveats">
              <div className="mb-1 flex items-center gap-1.5 font-semibold"><AlertTriangle size={13} /> Data caveats</div>
              <ul className="list-disc pl-5 space-y-0.5">{caveats.map(([n, label]) => <li key={label}><span className="tabular-nums font-semibold">{formatNumber(n)}</span> {label}</li>)}</ul>
            </div>
          )}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="flex items-center gap-1.5 text-sm font-bold text-white"><Layers size={14} className="text-[#10b981]" /> By location count</h3>
              <span className="text-[11px] text-slate-500">Whole {method} scope. An invoice can appear in multiple buckets. Click to narrow the invoice list.</span>
            </div>
            {data.buckets.length === 0 ? <p className="text-xs text-slate-500">No location buckets.</p> : (
              <div className="overflow-x-auto rounded-lg border border-slate-800">
                <table className="w-full text-xs">
                  <thead className="bg-slate-900 text-[10px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left">Locations</th><th className="px-3 py-2 text-right">Invoices</th><th className="px-3 py-2 text-right">Qty</th>
                      <th className="px-3 py-2 text-right">Imprints</th><th className="px-3 py-2 text-right">{workLabel(method)}</th>
                      {method === "print" && <th className="px-3 py-2 text-right">Est. screens</th>}
                      <th className="px-3 py-2 text-right">Avg job qty</th><th className="px-3 py-2 text-right">Avg item price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.buckets.map((b) => {
                      const active = bucket === b.locations;
                      return (
                        <tr key={b.locations} onClick={() => { setBucket(active ? null : b.locations); setPage(0); }}
                          data-testid={`row-bucket-${b.locations}`} aria-selected={active}
                          className={`cursor-pointer border-t border-slate-800 transition-colors ${active ? "bg-emerald-950/40 text-emerald-200" : "text-slate-300 hover:bg-slate-800/50"}`}>
                          <td className="px-3 py-2 font-semibold"><button type="button" className="underline underline-offset-4 decoration-emerald-600">{b.locations} location{b.locations === 1 ? "" : "s"}</button></td>
                          <td className="px-3 py-2 text-right tabular-nums">{num(b.totals.invoices)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{num(b.totals.quantity)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{num(b.totals.imprints)}</td>
                          <td className="px-3 py-2 text-right tabular-nums"><WorkUnits t={b.totals} method={method} /></td>
                          {method === "print" && <td className="px-3 py-2 text-right tabular-nums">{num(b.totals.estimatedScreens)}</td>}
                          <td className="px-3 py-2 text-right tabular-nums">{num(b.totals.averageJobQuantity, 1)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(b.totals.averageItemPrice)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-white">
                Invoices <span className="font-normal text-slate-400">({formatNumber(data.totalJobs)})</span>
                {isFetching && <span className="ml-2 text-[10px] text-slate-500">updating…</span>}
              </h3>
              {bucket !== null && (
                <button type="button" onClick={() => { setBucket(null); setPage(0); }} data-testid="button-clear-bucket"
                  className="flex items-center gap-1 rounded border border-emerald-700 bg-emerald-950/40 px-2 py-0.5 text-[11px] text-emerald-300">
                  Groups with {bucket} location{bucket === 1 ? "" : "s"} <X size={11} />
                </button>
              )}
            </div>
            {data.jobs.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-700 p-10 text-center text-sm text-slate-400">
                {isQuote ? "Quotes are not included. Switch Order Type to Invoice." : `No ${method} invoices match these filters.`}
              </div>
            ) : (
              <div className="space-y-3">{data.jobs.map((j) => <JobCard key={j.id} job={j} method={method} />)}</div>
            )}
            {data.totalJobs > LIMIT && (
              <div className="mt-3 flex items-center justify-end gap-3 text-xs text-slate-400">
                <span>Page {page + 1} of {totalPages}</span>
                <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} data-testid="button-decoration-prev" className="rounded border border-slate-700 p-1 disabled:opacity-40"><ChevronLeft size={14} /></button>
                <button type="button" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} data-testid="button-decoration-next" className="rounded border border-slate-700 p-1 disabled:opacity-40"><ChevronRight size={14} /></button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
