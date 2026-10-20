import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Eye,
  Layers,
  Loader2,
  Lock,
  Search,
  Send,
} from "lucide-react";
import {
  useCommitHubCalculatorHandoff,
  usePreviewHubCalculatorHandoff,
  useSearchAiQuoteCustomers,
  getSearchAiQuoteCustomersQueryKey,
  type AiQuoteCustomerCandidate,
  type HubCalculatorHandoffPreview,
  type HubCalculatorHandoffRequest,
  type HubCalculatorHandoffResult,
} from "@workspace/api-client-react";

const inputCls =
  "w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669]";
const labelCls =
  "block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5";

const money = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export type NewQuoteTarget = {
  customer: AiQuoteCustomerCandidate | null;
  nickname: string;
  dueDate: string;
};

function errorMessage(error: unknown): { message: string; status?: number } {
  const status =
    typeof error === "object" && error !== null && "status" in error ? Number(error.status) : undefined;
  const data =
    typeof error === "object" && error !== null && "data" in error
      ? (error as { data?: { error?: string } | null }).data
      : null;
  return {
    status,
    message: data?.error ?? (error instanceof Error ? error.message : "Request failed"),
  };
}

export function NewQuoteFields({
  value,
  onChange,
}: {
  value: NewQuoteTarget;
  onChange: (next: NewQuoteTarget) => void;
}) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const enabled = debounced.length >= 2 && !value.customer;
  const { data, isLoading } = useSearchAiQuoteCustomers(
    { query: debounced },
    { query: { enabled, queryKey: getSearchAiQuoteCustomersQueryKey({ query: debounced }) } },
  );

  return (
    <div className="space-y-3" data-testid="new-quote-fields">
      <div>
        <label className={labelCls}>Customer + contact</label>
        {value.customer ? (
          <div className="flex items-start justify-between gap-2 bg-[#3b82f6]/10 border border-[#3b82f6]/20 rounded-lg p-2.5">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-slate-200 truncate" data-testid="text-selected-customer">
                {value.customer.companyName}
              </div>
              <div className="text-[10px] text-slate-400 truncate">
                {value.customer.contactName ?? "No contact"}
                {value.customer.contactEmail ? ` · ${value.customer.contactEmail}` : ""}
              </div>
            </div>
            <button
              onClick={() => onChange({ ...value, customer: null })}
              className="text-[10px] font-semibold text-slate-400 hover:text-white shrink-0"
              data-testid="button-change-customer"
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={14} />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Company, contact name, or email"
                className={`${inputCls} pl-9`}
                data-testid="input-customer-search"
              />
            </div>
            {enabled && isLoading && (
              <div className="mt-2 space-y-1.5">
                {[0, 1].map((i) => (
                  <div key={i} className="h-9 rounded-md bg-slate-800/60 animate-pulse" />
                ))}
              </div>
            )}
            {enabled && data && data.customers.length > 0 && (
              <div className="bg-slate-900 border border-slate-700 rounded-lg max-h-48 overflow-y-auto mt-2" data-testid="customer-search-results">
                {data.customers.map((c) => (
                  <button
                    key={`${c.customerId}:${c.contactId ?? ""}`}
                    disabled={!c.contactId}
                    onClick={() => onChange({ ...value, customer: c })}
                    className="w-full text-left px-3 py-2 hover:bg-slate-800 border-b border-slate-800 last:border-0 disabled:opacity-40 disabled:cursor-not-allowed"
                    data-testid={`customer-result-${c.customerId}-${c.contactId ?? "none"}`}
                  >
                    <div className="text-xs font-semibold text-slate-200 truncate">{c.companyName}</div>
                    <div className="text-[10px] text-slate-500 truncate">
                      {c.contactName ?? "No contact on file"}
                      {c.contactEmail ? ` · ${c.contactEmail}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {enabled && data && data.customers.length === 0 && !isLoading && (
              <p className="text-[11px] text-slate-500 mt-2">No Printavo customers match "{debounced}".</p>
            )}
          </>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Quote nickname</label>
          <input
            value={value.nickname}
            onChange={(e) => onChange({ ...value, nickname: e.target.value.slice(0, 120) })}
            placeholder="e.g. Spring staff tees"
            className={inputCls}
            data-testid="input-quote-nickname"
          />
        </div>
        <div>
          <label className={labelCls}>Customer due date</label>
          <input
            type="date"
            value={value.dueDate}
            onChange={(e) => onChange({ ...value, dueDate: e.target.value })}
            className={`${inputCls} [color-scheme:dark]`}
            data-testid="input-quote-due-date"
          />
        </div>
      </div>
    </div>
  );
}

function sizeLabel(size: string) {
  return size.replace(/^size_/, "").toUpperCase();
}

export function HandoffPanel({
  request,
  blockers,
  destinationLabel,
  isNewQuote,
  onResult,
}: {
  request: HubCalculatorHandoffRequest | null;
  blockers: string[];
  destinationLabel: string | null;
  isNewQuote: boolean;
  onResult?: (result: HubCalculatorHandoffResult) => void;
}) {
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  // Non-idempotent writes: never auto-retry.
  const previewMutation = usePreviewHubCalculatorHandoff({ mutation: { retry: false } });
  const commitMutation = useCommitHubCalculatorHandoff({ mutation: { retry: false } });
  const [preview, setPreview] = useState<HubCalculatorHandoffPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [result, setResult] = useState<HubCalculatorHandoffResult | null>(null);
  const [commitError, setCommitError] = useState<{ message: string; locked: boolean } | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const requestKey = useMemo(() => (request ? JSON.stringify(request) : null), [request]);
  const requestKeyRef = useRef(requestKey);
  requestKeyRef.current = requestKey;
  const stale = preview !== null && previewKey !== requestKey;

  useEffect(() => {
    setConfirmed(false);
  }, [requestKey]);

  const runPreview = () => {
    if (!request || previewMutation.isPending) return;
    setPreviewError(null);
    setCommitError(null);
    setResult(null);
    const key = requestKey;
    previewMutation.mutate(
      { data: request },
      {
        onSuccess: (res) => {
          if (requestKeyRef.current !== key) return;
          setPreview(res);
          setPreviewKey(key);
          if (res.existing) {
            setResult(res.existing);
            onResultRef.current?.(res.existing);
          }
        },
        onError: (err) => {
          setPreview(null);
          setPreviewError(errorMessage(err).message);
        },
      },
    );
  };

  const runCommit = () => {
    if (!request || !preview || stale || !confirmed || commitMutation.isPending) return;
    setCommitError(null);
    const key = requestKey;
    commitMutation.mutate(
      { data: { ...request, expectedSnapshotHash: preview.snapshotHash } },
      {
        onSuccess: (res) => {
          if (requestKeyRef.current !== key) return;
          setResult(res);
          onResultRef.current?.(res);
        },
        onError: (err) => {
          const { message, status } = errorMessage(err);
          setCommitError({ message, locked: status === 409 || status === undefined || status >= 500 });
        },
      },
    );
  };

  const snap = preview?.snapshot;
  const locked = (commitError?.locked ?? false) || (result !== null && result.status !== "ok");
  const done = result?.status === "ok";

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4 space-y-3" data-testid="handoff-panel">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
          <Layers size={14} className="text-[#60a5fa]" />
          Garment lines + imprints
        </div>
        <span className="text-[10px] text-slate-500">
          {isNewQuote ? "Creates one new Printavo quote" : "Appends one new group; existing lines untouched"}
        </span>
      </div>

      {blockers.length > 0 && (
        <ul className="text-[11px] text-amber-400 space-y-0.5 list-disc list-inside" data-testid="handoff-blockers">
          {blockers.slice(0, 6).map((b) => <li key={b}>{b}</li>)}
          {blockers.length > 6 && <li>{blockers.length - 6} more</li>}
        </ul>
      )}

      <button
        onClick={runPreview}
        disabled={!request || previewMutation.isPending || commitMutation.isPending}
        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 text-xs font-bold transition-colors disabled:opacity-40"
        data-testid="button-preview-handoff"
      >
        {previewMutation.isPending ? <Loader2 className="animate-spin" size={14} /> : <Eye size={14} />}
        {preview && !stale ? "Refresh preview" : "Preview exact Printavo data"}
      </button>
      {previewMutation.isPending && (
        <p className="text-[10px] text-slate-500">Verifying matrices, categories and destination against live Printavo…</p>
      )}

      {previewError && (
        <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[11px] flex gap-2" data-testid="text-preview-error">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" /> {previewError}
        </div>
      )}

      {snap && (
        <div className={`space-y-3 ${stale ? "opacity-50" : ""}`} data-testid="handoff-preview">
          <p className="text-[11px] text-slate-400">
            Catalog products are verified before sending. Hub prices are preserved; Refresh Pricing in Printavo uses its current catalog costs and pricing rules, which may differ from your selected sale/regular cost.
          </p>
          {stale && (
            <p className="text-[11px] text-amber-400 font-semibold">Inputs changed since this preview. Preview again before sending.</p>
          )}
          <div className="text-[11px] text-slate-300 leading-relaxed">
            {snap.target.kind === "existing" ? (
              <>
                New group at position <span className="font-mono">{snap.target.groupPosition}</span> on{" "}
                {snap.target.orderType} <strong>#{snap.target.visualId}</strong>
              </>
            ) : (
              <>
                New quote <strong>"{snap.target.nickname}"</strong> for <strong>{snap.target.companyName}</strong>
                {snap.target.contactName ? ` (${snap.target.contactName})` : ""}, due {snap.target.dueDate}
              </>
            )}
            {" · "}
            {snap.mode === "compare"
              ? "Compare styles: price schedules in each description, no quantities ordered"
              : `Mixed order: ${snap.combinedQuantity} pcs combined set decoration at $${money(snap.decorationCostPerPiece ?? 0)}/pc`}
          </div>

          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="text-[9px] uppercase tracking-wider text-slate-500">
                  {["Category", "Item", "Color", "Description", "Sizes", "Unit price"].map((h) => (
                    <th key={h} className="text-left px-2 py-1.5 font-bold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {snap.lines.map((line, i) => (
                  <tr key={line.garmentId} className="border-t border-slate-800 align-top" data-testid={`row-preview-line-${i}`}>
                    <td className="px-2 py-1.5 text-slate-300 whitespace-nowrap">
                      {line.categoryName}
                      {line.productId && <div className="text-emerald-400 text-[10px]">{line.productCatalog} product linked</div>}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-slate-200">{line.itemNumber}</td>
                    <td className="px-2 py-1.5 text-slate-300">{line.color}</td>
                    <td className="px-2 py-1.5 text-slate-400 whitespace-pre-wrap min-w-[180px]">{line.description}</td>
                    <td className="px-2 py-1.5 font-mono text-slate-300 whitespace-nowrap">
                      {line.sizes.length === 0 ? "none" : line.sizes.map((s) => `${sizeLabel(s.size)} ${s.count}`).join(", ")}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-[#10b981] text-right whitespace-nowrap">
                      ${money(line.price)}
                      {line.quantity > 0 && <div className="text-slate-500">× {line.quantity}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="space-y-1">
            <div className={labelCls}>Imprints on the group</div>
            {snap.imprints.map((imp, i) => (
              <div key={i} className="flex flex-wrap items-baseline gap-x-2 text-[11px]" data-testid={`text-preview-imprint-${i}`}>
                <span className="text-slate-200 font-semibold">{imp.details}</span>
                <span className="text-slate-500">
                  {imp.matrixName} / {imp.columnLabel}
                </span>
                <span className="font-mono text-[10px] text-slate-600">Printavo column {imp.pricingMatrixColumnId}</span>
              </div>
            ))}
            <p className="text-[10px] text-slate-500">
              Matrix columns are attribution only. Printavo totals come from the unit prices above, so nothing is charged twice.
            </p>
          </div>

          {!done && !locked && (
            <div className="space-y-2 border-t border-slate-800 pt-3">
              <label className="flex items-start gap-2 text-[11px] text-slate-300">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={stale}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="accent-[#3b82f6] mt-0.5"
                  data-testid="checkbox-confirm-handoff"
                />
                I reviewed this data. Send it to {destinationLabel ?? "Printavo"} once. This cannot be undone from Hub.
              </label>
              <button
                onClick={runCommit}
                disabled={!confirmed || stale || commitMutation.isPending}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] text-white text-xs font-bold transition-colors disabled:opacity-40"
                data-testid="button-commit-handoff"
              >
                {commitMutation.isPending ? <Loader2 className="animate-spin" size={14} /> : <Send size={14} />}
                {isNewQuote ? "Create Printavo quote" : "Add group to Printavo"}
              </button>
            </div>
          )}
        </div>
      )}

      {commitError && (
        <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[11px] space-y-1" data-testid="text-commit-error">
          <div className="flex gap-2 font-semibold">
            {commitError.locked ? <Lock size={14} className="shrink-0" /> : <AlertTriangle size={14} className="shrink-0" />}
            {commitError.message}
          </div>
          {commitError.locked && (
            <div className="text-[10px] font-bold uppercase tracking-wider">Manual verification required. Do not retry.</div>
          )}
        </div>
      )}

      {result && !stale && (
        <div
          className={`p-3 rounded-lg flex items-start gap-2.5 ${
            done ? "bg-[#10b981]/10 border border-[#10b981]/20 text-[#10b981]" : "bg-amber-500/10 border border-amber-500/20 text-amber-400"
          }`}
          data-testid="handoff-result"
        >
          {done ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" /> : <Lock size={14} className="mt-0.5 shrink-0" />}
          <div className="text-[11px] space-y-1">
            <div className="text-xs font-bold">
              {done
                ? result.deduped
                  ? "Already sent. No duplicate was created."
                  : result.targetKind === "new_quote"
                    ? `Quote #${result.visualId} created`
                    : `Group added to #${result.visualId}`
                : "Previous attempt is locked"}
            </div>
            {result.error && <div>{result.error}</div>}
            {done && result.lineItemIds.length > 0 && <div>{result.lineItemIds.length} line items created.</div>}
            <div className="flex flex-wrap gap-3">
              {result.printavoUrl && (
                <a href={result.printavoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline" data-testid="link-printavo-result">
                  Open in Printavo <ExternalLink size={11} />
                </a>
              )}
              {result.publicUrl && (
                <a href={result.publicUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline" data-testid="link-printavo-public">
                  Customer view <ExternalLink size={11} />
                </a>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
