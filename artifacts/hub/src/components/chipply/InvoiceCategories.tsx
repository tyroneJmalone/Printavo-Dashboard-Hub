import { useRef, useState } from "react";
import { getChipplyCategoryInvoice, useGetChipplyCategoryInvoice, useListChipplyCategoryInvoices, getGetChipplyCategoryInvoiceQueryKey, getListChipplyCategoryInvoicesQueryKey, type ChipplyCategoryInvoice } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { CategoryReviewDialog, categoryError, categoryInputClass } from "./CategoryReviewDialog";
import { selectionCounts, selectionKey, toggleSelection, type CategorySelection } from "./categorySelection";
import { loadInvoiceMissingLines, mergeInvoiceSelection } from "./invoiceSelection";

function InvoiceLines({ orderId, selected, onToggle }: {
  orderId: string;
  selected: CategorySelection[];
  onToggle: (selection: CategorySelection, checked: boolean) => void;
}) {
  const [page, setPage] = useState(1);
  const params = { page, pageSize: 25 };
  const detail = useGetChipplyCategoryInvoice(orderId, params, {
    query: { queryKey: getGetChipplyCategoryInvoiceQueryKey(orderId, params), staleTime: 0 },
  });
  if (detail.isPending) return <p role="status" className="p-3 text-sm">Loading product lines…</p>;
  if (detail.error) return <div role="alert" className="p-3 text-red-300">{categoryError(detail.error)} <Button data-testid={`button-retry-lines-${orderId}`} onClick={() => void detail.refetch()}>Retry</Button></div>;
  const lines = detail.data.lineItems;
  return <div className="p-3 space-y-2 bg-slate-950/50">
    <div className="flex flex-wrap gap-2 items-center">
      <Button data-testid={`button-select-missing-${orderId}`} size="sm" variant="outline" onClick={() => lines.filter((line) => !line.currentCategoryId).forEach((line) => onToggle({ orderId, lineItemId: line.lineItemId }, true))}>Select missing lines on this page</Button>
      <span className="text-xs text-slate-400">Select existing categories individually to include them in an overwrite review.</span>
    </div>
    {lines.length === 0 && <p className="text-sm text-slate-400">No product lines in the mirror for this invoice.</p>}
    {lines.map((line) => {
      const selection = { orderId, lineItemId: line.lineItemId };
      return <label key={line.lineItemId} className="flex items-center gap-3 rounded border border-slate-800 px-3 py-2 text-sm">
        <input data-testid={`checkbox-line-${orderId}-${line.lineItemId}`} type="checkbox" checked={selected.some((s) => selectionKey(s) === selectionKey(selection))} onChange={(event) => onToggle(selection, event.target.checked)} />
        <span className="flex-1">{line.description || `Product line ${line.lineItemId}`}</span>
        <span className="text-slate-400">Qty {line.quantity}</span>
        <span>{line.currentCategoryName || "Missing category"}</span>
      </label>;
    })}
    <p className="text-xs text-slate-400">{detail.data.coverage}</p>
    <div className="flex gap-3 items-center text-xs text-slate-400">
      <Button data-testid={`button-lines-previous-${orderId}`} size="sm" variant="outline" disabled={page <= 1 || detail.isFetching} onClick={() => setPage(page - 1)}>Previous lines</Button>
      <span>{detail.data.total} product lines · page {page}</span>
      <Button data-testid={`button-lines-next-${orderId}`} size="sm" variant="outline" disabled={page * detail.data.pageSize >= detail.data.total || detail.isFetching} onClick={() => setPage(page + 1)}>Next lines</Button>
    </div>
  </div>;
}

export function InvoiceCategories() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [missingOnly, setMissingOnly] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [selected, setSelected] = useState<CategorySelection[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [reviewSelection, setReviewSelection] = useState<CategorySelection[] | null>(null);
  const [selectingInvoice, setSelectingInvoice] = useState<string | null>(null);
  const [selectionNotice, setSelectionNotice] = useState("");
  const selectionLock = useRef(false);
  const params = { page, pageSize: 25, search, status, missingOnly, ...(categoryId ? { categoryId } : {}) };
  const query = useListChipplyCategoryInvoices(params, {
    query: { queryKey: getListChipplyCategoryInvoicesQueryKey(params), staleTime: 30_000 },
  });
  const categories = query.data?.categories ?? [];
  const selectionCap = query.data?.selectionCap ?? 100;
  const counts = selectionCounts(selected);
  function toggle(selection: CategorySelection, checked: boolean) {
    if (selectionLock.current) return;
    setSelected((previous) => toggleSelection(previous, selection, checked, selectionCap));
  }
  async function selectMissingInvoice(invoice: ChipplyCategoryInvoice) {
    if (selectionLock.current) return;
    selectionLock.current = true;
    setSelectingInvoice(invoice.orderId);
    setSelectionNotice(`Loading all product-line pages for invoice #${invoice.visualId}…`);
    try {
      const missing = await loadInvoiceMissingLines(invoice.orderId, (detailPage) =>
        getChipplyCategoryInvoice(invoice.orderId, { page: detailPage, pageSize: 100 }));
      const merged = mergeInvoiceSelection(selected, missing, selectionCap);
      setSelected(merged);
      setSelectionNotice(`Invoice #${invoice.visualId}: all ${missing.length} missing-category lines across every detail page are selected (${merged.length - selected.length} newly added). ${missing.length ? "Existing nonempty categories were left unselected by this action." : "No missing-category lines were found."}`);
    } catch (error) {
      setSelectionNotice(`Invoice #${invoice.visualId}: ${categoryError(error)} No selection changes were made.`);
    } finally {
      selectionLock.current = false;
      setSelectingInvoice(null);
    }
  }
  function changeFilter(change: () => void) {
    change(); setPage(1); setExpanded(null);
  }
  return <section className="space-y-4">
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-2">
      <h2 className="text-lg font-semibold text-white">Invoice categories</h2>
      <p className="text-sm text-slate-400">All nickname-recognized Chipply invoices in the Printavo mirror, including stores not imported here and every status. This is not a live completeness guarantee; newly synced invoices appear after refresh.</p>
      <p className="text-xs text-slate-400">MERCH PRINT → Screen Printing · MERCH EMB → Embroidery · MERCH HEAT → HEAT APPLIED GRAPHICS · MERCH MIXED → Mixed Decoration. Recommendations cover waiting, ready, and complete stages. Unrecognized statuses require a manual category choice.</p>
    </div>
    <div className="flex flex-wrap gap-3 items-center">
      <input data-testid="input-category-search" aria-label="Search invoices" placeholder="Search nickname or invoice…" className={`${categoryInputClass} flex-1 min-w-48`} value={search} onChange={(event) => changeFilter(() => setSearch(event.target.value))} />
      <select data-testid="select-category-status" aria-label="Invoice status" className={categoryInputClass} value={status} onChange={(event) => changeFilter(() => setStatus(event.target.value))}>
        <option value="">All statuses</option>
        {(query.data?.statuses ?? []).map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
      <select data-testid="select-current-category" aria-label="Current category" className={categoryInputClass} value={categoryId} onChange={(event) => changeFilter(() => { setCategoryId(event.target.value); if (event.target.value) setMissingOnly(false); })}>
        <option value="">Any current category</option>
        {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
      </select>
      <label className="flex items-center gap-2 text-sm text-slate-300"><input data-testid="checkbox-missing-categories" type="checkbox" checked={missingOnly} onChange={(event) => changeFilter(() => setMissingOnly(event.target.checked))} />Missing categories only</label>
      <Button data-testid="button-refresh-category-invoices" variant="outline" disabled={query.isFetching} onClick={() => void query.refetch()}>Refresh</Button>
    </div>
    <p role="status" className="text-xs text-amber-300">Review limit: {selectionCap} lines. {selected.length >= selectionCap ? "Limit reached; clear some selections before adding more." : "Only explicitly selected lines will be reviewed."}</p>
    {selectionNotice && <p role="status" data-testid="text-invoice-selection-notice" className="rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-sm text-amber-200">{selectionNotice}</p>}
    <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg border border-emerald-900 bg-emerald-950/30">
      <p data-testid="text-selected-categories" className="text-sm text-emerald-100 flex-1">{counts.invoices} invoices · {counts.lines} product lines explicitly selected across pages. Nothing else is selected.</p>
      <Button data-testid="button-clear-category-selection" variant="outline" disabled={!selected.length || !!selectingInvoice} onClick={() => { setSelected([]); setSelectionNotice(""); }}>Clear selection</Button>
      <Button data-testid="button-review-categories" disabled={!selected.length || !query.data || query.isFetching || !!selectingInvoice} className="bg-emerald-700 hover:bg-emerald-600" onClick={() => setReviewSelection([...selected])}>Review selected lines</Button>
    </div>
    {query.isPending ? <p role="status" className="text-slate-400">Loading invoices…</p> : query.error ? <p role="alert" className="text-red-300">{categoryError(query.error)} Use Refresh to try again.</p> : <>
      <p data-testid="text-category-total" className="text-sm text-slate-400">{query.data.total} matching invoices · page {page}</p>
      <p data-testid="text-category-coverage" className="text-xs text-slate-400">{query.data.coverage}</p>
      {!query.data.invoices.length && <p className="p-8 text-center text-slate-400">No invoices match these filters. Try showing all categories or clearing your search.</p>}
      <div className="space-y-3">{query.data.invoices.map((invoice) => <article key={invoice.orderId} className="rounded-xl border border-slate-800 bg-slate-900 overflow-hidden">
        <div className="p-4 flex flex-wrap gap-3 items-center">
          <div className="flex-1 min-w-48">
            <h3 className="font-semibold text-slate-100">{invoice.nickname}</h3>
            <a data-testid={`link-category-invoice-${invoice.orderId}`} className="text-sm text-emerald-400 underline" href={`https://www.printavo.com/invoices/${encodeURIComponent(String(invoice.visualId))}`} target="_blank" rel="noopener noreferrer">Invoice #{invoice.visualId} ↗</a>
          </div>
          <span data-testid={`status-category-invoice-${invoice.orderId}`} className="rounded border border-slate-600 bg-slate-800 px-3 py-1 text-sm font-semibold text-white">{invoice.statusName || "Unknown status"}</span>
          <Button data-testid={`button-select-invoice-missing-${invoice.orderId}`} variant="outline" disabled={!!selectingInvoice} onClick={() => void selectMissingInvoice(invoice)}>{selectingInvoice === invoice.orderId ? "Loading all lines…" : "Select all missing on invoice"}</Button>
          <Button data-testid={`button-expand-invoice-${invoice.orderId}`} variant="outline" aria-expanded={expanded === invoice.orderId} onClick={() => setExpanded(expanded === invoice.orderId ? null : invoice.orderId)}>{expanded === invoice.orderId ? "Hide lines" : "Select lines"}</Button>
          <p className="w-full text-xs text-slate-400">{invoice.lineItemCount} product lines · Qty {invoice.quantity} · {invoice.missingCategoryCount} missing categories · Recommended: <span className="text-slate-200">{invoice.recommendation.category?.name ?? "No automatic match — choose manually in review"}</span></p>
          <p className="w-full text-xs text-slate-500">{invoice.recommendation.message} · Detail sync: {invoice.detailSyncState}{invoice.detailSyncedAt ? ` · ${new Date(invoice.detailSyncedAt).toLocaleString()}` : ""}</p>
          {invoice.detailSyncState !== "complete" && <p className="w-full text-xs text-amber-300">Incomplete mirror: invoice-wide selection is blocked until detail sync completes. Counts may not include every product line.</p>}
        </div>
        {expanded === invoice.orderId && <fieldset disabled={!!selectingInvoice}><InvoiceLines orderId={invoice.orderId} selected={selected} onToggle={toggle} /></fieldset>}
      </article>)}</div>
      <div className="flex justify-between">
        <Button data-testid="button-category-previous" variant="outline" disabled={page <= 1 || query.isFetching} onClick={() => { setPage(page - 1); setExpanded(null); }}>Previous</Button>
        <Button data-testid="button-category-next" variant="outline" disabled={page * 25 >= query.data.total || query.isFetching} onClick={() => { setPage(page + 1); setExpanded(null); }}>Next</Button>
      </div>
    </>}
    {reviewSelection && <CategoryReviewDialog selections={reviewSelection} categories={categories} onClose={() => setReviewSelection(null)} onWritten={() => setSelected([])} />}
  </section>;
}