import { useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  Copy,
  Download,
  Loader2,
  MapPin,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { toPng } from "html-to-image";
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
import { VendorCostLookup } from "./VendorCostLookup";

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
  initialGarmentCost,
  initialLabel
}: {
  onGoToMatrices: () => void;
  initialGarmentCost?: string;
  initialLabel?: string;
}) {
  const { toast } = useToast();
  const { data, isLoading } = useListDecorationMatrices({
    query: { queryKey: getListDecorationMatricesQueryKey() },
  });
  const matrices = data?.matrices ?? [];

  const [garmentCostStr, setGarmentCostStr] = useState(initialGarmentCost || "");
  const [labelHint, setLabelHint] = useState(initialLabel || "");
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
    const lines = quote
      .map((q) => `${q.qty}+\t$${money(q.unitPrice)}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(lines);
      toast({ title: "Price breaks copied to clipboard" });
    } catch {
      toast({ title: "Couldn't copy to clipboard", variant: "destructive" });
    }
  };

  const exportRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  const savePng = async () => {
    const node = exportRef.current;
    if (node === null || exporting) return;
    setExporting(true);
    try {
      // 2× resolution like the original Breezy Quote export; solid page
      // background so the transparent gaps between cards don't come out
      // checkered in the PNG.
      const dataUrl = await toPng(node, {
        pixelRatio: 2,
        backgroundColor: "#020617",
      });
      const firstValid = rowStates.find(
        (s): s is Extract<RowState, { status: "ok" }> => s.status === "ok",
      );
      const matrixSlug = (firstValid?.mx.data.name ?? "quote")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const d = new Date();
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `quote-${matrixSlug || "quote"}-${date}.png`;
      a.click();
      toast({ title: "Quote saved as PNG" });
    } catch (err) {
      console.error("PNG export failed", err);
      toast({
        title: "Couldn't save PNG",
        description: "Something went wrong rendering the image — try again.",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
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
    <div ref={exportRef} className="space-y-4">
      {/* Inputs: narrow cost column on the left, locations to its right */}
      <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 items-start">
        <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 space-y-4">
          <VendorCostLookup
            onApply={(cost) => setGarmentCostStr(cost.toFixed(2))}
          />
          <div className="border-t border-slate-800 -mx-4 px-4 pt-4">
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
                onChange={(e) => {
                  setGarmentCostStr(e.target.value);
                  if (labelHint) setLabelHint(""); // auto-dismiss hint on edit
                }}
                placeholder="0.00"
                className={`${inputCls} pl-6 font-mono`}
              />
            </div>
            {!garmentValid && (
              <p className="text-[11px] text-amber-400 mt-1">
                Enter a valid garment cost (0 or more).
              </p>
            )}
            {labelHint && garmentValid && (
              <div className="flex items-center justify-between bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] px-2 py-1.5 rounded mt-2">
                <span className="truncate mr-2">From: {labelHint}</span>
                <button onClick={() => setLabelHint("")} className="hover:text-emerald-300"><X size={12} /></button>
              </div>
            )}
          </div>

          <div>
            <span className={labelCls}>Markup multiplier</span>
            <div
              className="grid grid-cols-7 gap-1"
              role="group"
              aria-label="Markup multiplier"
            >
              {MARKUP_PRESETS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMarkupSel(String(m))}
                  data-testid={`markup-${m.toFixed(2)}`}
                  aria-pressed={markupSel === String(m)}
                  className={`text-[10px] font-mono px-0.5 py-1.5 rounded-md border transition-colors ${
                    markupSel === String(m)
                      ? "bg-[#059669]/15 border-[#059669]/50 text-[#10b981] font-bold"
                      : "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                  }`}
                >
                  {m.toFixed(2)}
                </button>
              ))}
            </div>
            <div className="flex gap-2 mt-1.5">
              <button
                type="button"
                onClick={() => setMarkupSel("custom")}
                data-testid="markup-custom"
                aria-pressed={isCustomMarkup}
                className={`text-[10px] font-semibold px-2.5 py-1.5 rounded-md border transition-colors shrink-0 ${
                  isCustomMarkup
                    ? "bg-[#059669]/15 border-[#059669]/50 text-[#10b981]"
                    : "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700 hover:text-slate-200"
                }`}
              >
                Custom
              </button>
              {isCustomMarkup && (
                <input
                  type="text"
                  inputMode="decimal"
                  value={customMarkupStr}
                  onChange={(e) => setCustomMarkupStr(e.target.value)}
                  placeholder="e.g. 2.25"
                  className={`${inputCls} font-mono`}
                  aria-label="Custom markup"
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
            <div className="flex items-center gap-2">
              <button
                onClick={copyQuote}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
              >
                <Copy size={13} /> Copy
              </button>
              <button
                onClick={savePng}
                disabled={exporting}
                data-testid="save-png"
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {exporting ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Download size={13} />
                )}
                Save PNG
              </button>
            </div>
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
          <div className="overflow-x-auto custom-scrollbar">
            <table
              className="w-full text-xs border-collapse"
              data-testid="quote-results"
            >
              <thead>
                <tr className="bg-slate-900/60">
                  {[
                    ["Qty", "left"],
                    ["Garment Cost", "right"],
                    ["Garment Markup $", "right"],
                    ["Base Cost $", "right"],
                    ["Decoration/PC", "right"],
                    ["Unit Price", "right"],
                    ["Total Cost", "right"],
                    ["Total Blank Markup", "right"],
                    ["Total Deco", "right"],
                    ["Total Order Value", "right"],
                  ].map(([label, align]) => (
                    <th
                      key={label}
                      className={`px-3 py-2.5 ${
                        align === "left" ? "text-left" : "text-right"
                      } text-[9px] font-bold uppercase tracking-wider text-slate-500 whitespace-nowrap`}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {quote.map((q) => (
                  <tr key={q.qty} className="border-t border-slate-800">
                    <td className="px-3 py-2.5 font-mono text-slate-300 whitespace-nowrap">
                      {q.qty}+
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-500 whitespace-nowrap">
                      ${money(q.garmentCost)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-500 whitespace-nowrap">
                      ${money(q.garmentMarkup)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-400 whitespace-nowrap">
                      ${money(q.baseCost)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-400 whitespace-nowrap">
                      ${money(q.decorationCost)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[#10b981] font-semibold whitespace-nowrap">
                      ${money(q.unitPrice)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-500 whitespace-nowrap">
                      ${money(q.totalGarment)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-400 whitespace-nowrap">
                      ${money(q.totalBlankMarkup)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-400 whitespace-nowrap">
                      ${money(q.totalDecoration)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-slate-200 font-semibold whitespace-nowrap">
                      ${money(q.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
