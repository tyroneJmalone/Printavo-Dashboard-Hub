import { useMemo, useState } from "react";
import {
  ArrowRight,
  Copy,
  Loader2,
  MapPin,
  Plus,
  Trash2,
} from "lucide-react";
import {
  useListDecorationMatrices,
  getListDecorationMatricesQueryKey,
  type DecorationMatrix,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  computeQuote,
  DEFAULT_MARKUP,
  MARKUP_PRESETS,
  MAX_LOCATIONS,
  type QuoteLocation,
} from "./calcEngine";

const money = (n: number) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

interface LocationRow {
  matrixId: string;
  columnIndex: number;
}

const inputCls =
  "w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669]";
const labelCls =
  "block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5";

export function QuoteCalculator({
  onGoToMatrices,
}: {
  onGoToMatrices: () => void;
}) {
  const { toast } = useToast();
  const { data, isLoading } = useListDecorationMatrices({
    query: { queryKey: getListDecorationMatricesQueryKey() },
  });
  const matrices = data?.matrices ?? [];

  const [garmentCostStr, setGarmentCostStr] = useState("");
  const [markupSel, setMarkupSel] = useState(String(DEFAULT_MARKUP));
  const [customMarkupStr, setCustomMarkupStr] = useState("");
  const [rows, setRows] = useState<LocationRow[]>([
    { matrixId: "", columnIndex: 0 },
  ]);

  const garmentCost = garmentCostStr.trim() === "" ? 0 : Number(garmentCostStr);
  const garmentValid = Number.isFinite(garmentCost) && garmentCost >= 0;

  const isCustomMarkup = markupSel === "custom";
  const markup = isCustomMarkup ? Number(customMarkupStr) : Number(markupSel);
  const markupValid = Number.isFinite(markup) && markup > 0;

  const byId = useMemo(() => {
    const m = new Map<string, DecorationMatrix>();
    for (const mx of matrices) m.set(mx.id, mx);
    return m;
  }, [matrices]);

  type RowState =
    | { status: "empty" }
    | { status: "missing" }
    | { status: "column-gone"; mx: DecorationMatrix }
    | { status: "ok"; mx: DecorationMatrix };

  const rowStates: RowState[] = useMemo(
    () =>
      rows.map((r) => {
        if (!r.matrixId) return { status: "empty" as const };
        const mx = byId.get(r.matrixId);
        if (!mx) return { status: "missing" as const };
        if (mx.data.xValues[r.columnIndex] === undefined)
          return { status: "column-gone" as const, mx };
        return { status: "ok" as const, mx };
      }),
    [rows, byId],
  );

  const validEntries = useMemo(
    () =>
      rowStates.flatMap((s, i) =>
        s.status === "ok"
          ? [
              {
                loc: { data: s.mx.data, columnIndex: rows[i].columnIndex },
                rowIndex: i,
              },
            ]
          : [],
      ),
    [rowStates, rows],
  );

  const locations: QuoteLocation[] = useMemo(
    () => validEntries.map((e) => e.loc),
    [validEntries],
  );
  /** Row whose column supplies the canonical qty tiers (first valid location). */
  const tierRowIndex = validEntries.length > 0 ? validEntries[0].rowIndex : -1;

  const quote = useMemo(
    () =>
      garmentValid && markupValid
        ? computeQuote(garmentCost, markup, locations)
        : [],
    [garmentValid, markupValid, garmentCost, markup, locations],
  );

  const setRow = (i: number, patch: Partial<LocationRow>) =>
    setRows((prev) =>
      prev.map((r, ri) => (ri === i ? { ...r, ...patch } : r)),
    );

  const copyQuote = async () => {
    const locLines = rows
      .map((r, i) => {
        const mx = byId.get(r.matrixId);
        const col = mx?.data.xValues[r.columnIndex];
        return mx && col
          ? `Location ${i + 1}: ${mx.data.name} — ${col.label}`
          : null;
      })
      .filter(Boolean)
      .join("\n");
    const header = `Garment $${money(garmentCost)} × ${markup} markup`;
    const table = [
      "Qty\tDecoration / pc\tUnit Price\tTotal",
      ...quote.map(
        (q) =>
          `${q.qty}\t$${money(q.decorationCost)}\t$${money(q.unitPrice)}\t$${money(q.total)}`,
      ),
    ].join("\n");
    try {
      await navigator.clipboard.writeText(`${header}\n${locLines}\n\n${table}`);
      toast({ title: "Quote copied to clipboard" });
    } catch {
      toast({ title: "Couldn't copy to clipboard", variant: "destructive" });
    }
  };

  if (isLoading) {
    return (
      <div className="py-12 flex justify-center">
        <Loader2 className="animate-spin text-[#10b981]" size={24} />
      </div>
    );
  }

  if (matrices.length === 0) {
    return (
      <div className="bg-slate-900/40 border border-slate-800 rounded-xl px-6 py-12 text-center max-w-2xl mx-auto">
        <MapPin className="mx-auto text-slate-600 mb-3" size={36} />
        <p className="text-sm text-slate-300 font-medium">
          No pricing matrices yet
        </p>
        <p className="text-xs text-slate-500 mt-1.5">
          The calculator needs at least one decoration pricing matrix.
        </p>
        <button
          onClick={onGoToMatrices}
          className="inline-flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors mt-4"
        >
          Set up pricing matrices <ArrowRight size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[400px,1fr] gap-6 items-start">
      {/* Inputs */}
      <div className="space-y-4">
        <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 space-y-4">
          <div>
            <label className={labelCls} htmlFor="garment-cost">
              Garment cost (per piece)
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">
                $
              </span>
              <input
                id="garment-cost"
                type="text"
                inputMode="decimal"
                value={garmentCostStr}
                onChange={(e) => setGarmentCostStr(e.target.value)}
                placeholder="0.00"
                className={`${inputCls} pl-6 font-mono`}
              />
            </div>
            {!garmentValid && (
              <p className="text-[11px] text-amber-400 mt-1">
                Enter a valid garment cost (0 or more).
              </p>
            )}
          </div>

          <div>
            <label className={labelCls} htmlFor="markup">
              Markup multiplier
            </label>
            <div className="flex gap-2">
              <select
                id="markup"
                value={markupSel}
                onChange={(e) => setMarkupSel(e.target.value)}
                className={inputCls}
              >
                {MARKUP_PRESETS.map((m) => (
                  <option key={m} value={String(m)}>
                    {m.toFixed(2)}×
                  </option>
                ))}
                <option value="custom">Custom…</option>
              </select>
              {isCustomMarkup && (
                <input
                  type="text"
                  inputMode="decimal"
                  value={customMarkupStr}
                  onChange={(e) => setCustomMarkupStr(e.target.value)}
                  placeholder="e.g. 2.25"
                  className={`${inputCls} font-mono`}
                  aria-label="Custom markup"
                />
              )}
            </div>
            {isCustomMarkup && !markupValid && (
              <p className="text-[11px] text-amber-400 mt-1">
                Enter a markup greater than 0.
              </p>
            )}
            {garmentValid && markupValid && garmentCost > 0 && (
              <p className="text-[11px] text-slate-500 mt-1.5">
                ${money(garmentCost)} × {markup} ={" "}
                <span className="text-slate-300 font-mono">
                  ${money(garmentCost * markup)}
                </span>{" "}
                per piece before decoration
              </p>
            )}
          </div>
        </div>

        <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className={`${labelCls} mb-0`}>Decoration locations</span>
            <button
              onClick={() =>
                setRows((prev) => [...prev, { matrixId: "", columnIndex: 0 }])
              }
              disabled={rows.length >= MAX_LOCATIONS}
              className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-40"
            >
              <Plus size={12} /> Add location
            </button>
          </div>

          {rows.map((r, i) => {
            const state = rowStates[i];
            const mx =
              state.status === "ok" || state.status === "column-gone"
                ? state.mx
                : undefined;
            return (
              <div
                key={i}
                className="border border-slate-800 rounded-lg p-3 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-slate-400">
                    Location {i + 1}
                    {i === tierRowIndex && quote.length > 0 && (
                      <span className="text-slate-600">
                        {" "}
                        · sets the qty tiers
                      </span>
                    )}
                  </span>
                  {rows.length > 1 && (
                    <button
                      onClick={() =>
                        setRows((prev) => prev.filter((_, ri) => ri !== i))
                      }
                      className="text-slate-500 hover:text-red-400 transition-colors"
                      aria-label={`Remove location ${i + 1}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
                <select
                  value={r.matrixId}
                  onChange={(e) =>
                    setRow(i, { matrixId: e.target.value, columnIndex: 0 })
                  }
                  className={inputCls}
                  aria-label={`Location ${i + 1} matrix`}
                >
                  <option value="">Select a matrix…</option>
                  {matrices.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.data.name}
                    </option>
                  ))}
                </select>
                {mx && (
                  <select
                    value={String(r.columnIndex)}
                    onChange={(e) =>
                      setRow(i, { columnIndex: Number(e.target.value) })
                    }
                    className={inputCls}
                    aria-label={`Location ${i + 1} ${mx.data.xAxisLabel}`}
                  >
                    {state.status === "column-gone" && (
                      <option value={String(r.columnIndex)} disabled>
                        Select {mx.data.xAxisLabel}…
                      </option>
                    )}
                    {mx.data.xValues.map((x, xi) => (
                      <option key={xi} value={String(xi)}>
                        {mx.data.xAxisLabel}: {x.label}
                      </option>
                    ))}
                  </select>
                )}
                {state.status === "missing" && (
                  <p className="text-[11px] text-amber-400">
                    This matrix was deleted — select another. This location is
                    not included in the price until you do.
                  </p>
                )}
                {state.status === "column-gone" && mx && (
                  <p className="text-[11px] text-amber-400">
                    This matrix changed — pick a {mx.data.xAxisLabel} again.
                    This location is not included in the price until you do.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Results */}
      <div className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-white">Price breaks</div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Unit price = (garment × markup) + decoration per piece
            </div>
          </div>
          {quote.length > 0 && (
            <button
              onClick={copyQuote}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
            >
              <Copy size={13} /> Copy
            </button>
          )}
        </div>

        {quote.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm text-slate-300 font-medium">
              No price breaks yet
            </p>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
              {garmentValid && markupValid
                ? "Pick a matrix and column for a location — the first filled location's quantity tiers become the rows of the quote."
                : "Fix the highlighted inputs to see price breaks."}
            </p>
          </div>
        ) : (
          <table className="w-full text-xs border-collapse" data-testid="quote-results">
            <thead>
              <tr className="bg-slate-900/60">
                <th className="px-4 py-2.5 text-left text-[9px] font-bold uppercase tracking-wider text-slate-500">
                  Quantity
                </th>
                <th className="px-4 py-2.5 text-right text-[9px] font-bold uppercase tracking-wider text-slate-500">
                  Decoration / pc
                </th>
                <th className="px-4 py-2.5 text-right text-[9px] font-bold uppercase tracking-wider text-slate-500">
                  Unit price
                </th>
                <th className="px-4 py-2.5 text-right text-[9px] font-bold uppercase tracking-wider text-slate-500">
                  Total order value
                </th>
              </tr>
            </thead>
            <tbody>
              {quote.map((q) => (
                <tr key={q.qty} className="border-t border-slate-800">
                  <td className="px-4 py-2.5 font-mono text-slate-300">
                    {q.qty}+
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-400">
                    ${money(q.decorationCost)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-[#10b981] font-semibold">
                    ${money(q.unitPrice)}
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-slate-200">
                    ${money(q.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
