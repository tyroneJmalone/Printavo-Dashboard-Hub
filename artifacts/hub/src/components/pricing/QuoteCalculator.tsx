import { useMemo, useRef, useState, useEffect } from "react";
import {
  ArrowRight,
  Copy,
  Download,
  Loader2,
  MapPin,
  Plus,
  Trash2,
  X,
  Sparkles,
  CloudUpload,
  Search,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
} from "lucide-react";
import { toPng } from "html-to-image";
import {
  useListDecorationMatrices,
  getListDecorationMatricesQueryKey,
  useInterpretHubPricingPrompt,
  useSearchHubInvoices,
  getSearchHubInvoicesQueryKey,
  useRequestHubPngUploadUrl,
  usePushHubCalculator,
  type DecorationMatrix,
  type HubPricingGarmentMatch,
  type HubInvoiceSearchItem,
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type RangeKey =
  | "all"
  | "12-48"
  | "36-72"
  | "60-96"
  | "84-120"
  | "108-144"
  | "144-288";

const RANGES: { label: string; key: RangeKey; filter: (q: number) => boolean }[] = [
  { label: "All", key: "all", filter: () => true },
  { label: "12–48", key: "12-48", filter: (q) => q >= 12 && q <= 48 },
  { label: "36–72", key: "36-72", filter: (q) => q >= 36 && q <= 72 },
  { label: "60–96", key: "60-96", filter: (q) => q >= 60 && q <= 96 },
  { label: "84–120", key: "84-120", filter: (q) => q >= 84 && q <= 120 },
  { label: "108–144", key: "108-144", filter: (q) => q >= 108 && q <= 144 },
  { label: "144–288", key: "144-288", filter: (q) => q >= 144 && q <= 288 },
];

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
  initialLabel,
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

  const [garmentCostStr, setGarmentCostStr] = useState(
    initialGarmentCost || ""
  );
  const garmentCostSourceRef = useRef<"empty" | "initial" | "manual" | "vendor" | "ai">(
    initialGarmentCost ? "initial" : "empty",
  );
  const [labelHint, setLabelHint] = useState(initialLabel || "");
  const [markupSel, setMarkupSel] = useState(String(DEFAULT_MARKUP));
  const [customMarkupStr, setCustomMarkupStr] = useState("");
  const [quoteNumber, setQuoteNumber] = useState("");
  const [rows, setRows] = useState<LocationRow[]>([
    { matrixId: "", columnIndex: 0 },
  ]);

  const garmentCost = garmentCostStr.trim() === "" ? 0 : Number(garmentCostStr);
  const garmentValid = Number.isFinite(garmentCost) && garmentCost >= 0;

  const isCustomMarkup = markupSel === "custom";
  const markup = isCustomMarkup ? Number(customMarkupStr) : Number(markupSel);
  const markupValid = Number.isFinite(markup) && markup > 0;

  const [rangeKey, setRangeKey] = useState<RangeKey>("all");

  const [aiPrompt, setAiPrompt] = useState("");
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [aiGarmentMatch, setAiGarmentMatch] =
    useState<HubPricingGarmentMatch | null>(null);
  const interpretMutation = useInterpretHubPricingPrompt();

  const [searchQ, setSearchQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [selectedInvoice, setSelectedInvoice] =
    useState<HubInvoiceSearchItem | null>(null);

  const [isPushing, setIsPushing] = useState(false);
  const [pushOutcome, setPushOutcome] = useState<{
    noteOutcome: { ok: boolean; error?: string | null; locked?: boolean };
    fileOutcome: { ok: boolean; error?: string | null; locked?: boolean };
  } | null>(null);

  const requestUrlMutation = useRequestHubPngUploadUrl();
  const pushMutation = usePushHubCalculator();

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchQ), 300);
    return () => clearTimeout(t);
  }, [searchQ]);

  const { data: searchData, isLoading: searchLoading } = useSearchHubInvoices(
    { q: debouncedQ, limit: 20 },
    {
      query: {
        enabled: debouncedQ.trim().length >= 2,
        queryKey: getSearchHubInvoicesQueryKey({ q: debouncedQ, limit: 20 }),
      },
    }
  );

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
    [rows, byId]
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
          : []
      ),
    [rowStates, rows]
  );

  const locations: QuoteLocation[] = useMemo(
    () => validEntries.map((e) => e.loc),
    [validEntries]
  );
  /** Row whose column supplies the canonical qty tiers (first valid location). */
  const tierRowIndex = validEntries.length > 0 ? validEntries[0].rowIndex : -1;

  const quote = useMemo(
    () =>
      garmentValid && markupValid
        ? computeQuote(garmentCost, markup, locations)
        : [],
    [garmentValid, markupValid, garmentCost, markup, locations]
  );

  const activeRange = RANGES.find((r) => r.key === rangeKey) || RANGES[0];

  const setRow = (i: number, patch: Partial<LocationRow>) =>
    setRows((prev) =>
      prev.map((r, ri) => (ri === i ? { ...r, ...patch } : r))
    );

  const handleInterpret = () => {
    if (!aiPrompt.trim()) return;
    setAiWarnings([]);
    interpretMutation.mutate(
      { data: { prompt: aiPrompt } },
      {
        onSuccess: (res) => {
          setAiGarmentMatch(res.garmentMatch);
          if (res.garmentCost !== null) {
            setGarmentCostStr(res.garmentCost.toFixed(2));
            garmentCostSourceRef.current = "ai";
            setLabelHint(
              res.garmentMatch
                ? [
                    res.garmentMatch.brand,
                    res.garmentMatch.styleName,
                    res.garmentMatch.colorName,
                    res.garmentMatch.vendor === "sanmar"
                      ? "SanMar"
                      : "S&S Activewear",
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "AI prompt",
            );
          } else if (garmentCostSourceRef.current === "ai") {
            setGarmentCostStr("");
            setLabelHint("");
            garmentCostSourceRef.current = "empty";
          }
          if (res.markup !== null) {
            if (MARKUP_PRESETS.includes(res.markup)) {
              setMarkupSel(String(res.markup));
            } else {
              setMarkupSel("custom");
              setCustomMarkupStr(String(res.markup));
            }
          }
          if (res.quoteNumber !== null) {
            setQuoteNumber(res.quoteNumber);
          }
          if (res.decorations && res.decorations.length > 0) {
            const newRows = res.decorations.slice(0, MAX_LOCATIONS).map((d) => ({
              matrixId: d.matrixId,
              columnIndex: d.columnIndex,
            }));
            setRows(newRows);
          }
          if (res.warnings && res.warnings.length > 0) {
            setAiWarnings(res.warnings);
          }
        },
        onError: () => {
          toast({
            title: "Failed to interpret prompt",
            description: "Please check your input and try again.",
            variant: "destructive",
          });
        },
      }
    );
  };

  const copyQuote = async (selectedRange: RangeKey) => {
    const range = RANGES.find((candidate) => candidate.key === selectedRange) ?? RANGES[0];
    const filtered = quote.filter((q) => range.filter(q.qty));
    if (filtered.length === 0) {
      toast({ title: "No tiers in selected range", variant: "destructive" });
      return;
    }
    const lines = filtered
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

  const generateExportImage = async () => {
    const node = exportRef.current;
    if (!node) return null;

    const sourceScroller = node.querySelector<HTMLElement>(
      "[data-export-table-scroll]",
    );
    const sourceTable = sourceScroller?.querySelector<HTMLTableElement>("table");
    const fullTableWidth = Math.ceil(
      Math.max(
        sourceScroller?.scrollWidth ?? 0,
        sourceTable?.scrollWidth ?? 0,
        sourceTable?.getBoundingClientRect().width ?? 0,
      ),
    );
    const sourceWidth = Math.ceil(node.getBoundingClientRect().width);
    const captureWidth = Math.max(sourceWidth, fullTableWidth + 32);

    const captureNode = node.cloneNode(true) as HTMLDivElement;
    captureNode.setAttribute("aria-hidden", "true");
    Object.assign(captureNode.style, {
      position: "absolute",
      left: `-${captureWidth + 100}px`,
      top: "0",
      width: `${captureWidth}px`,
      maxWidth: "none",
      margin: "0",
      backgroundColor: "#020617",
      pointerEvents: "none",
    });

    const captureScroller = captureNode.querySelector<HTMLElement>(
      "[data-export-table-scroll]",
    );
    if (captureScroller) {
      captureScroller.style.overflow = "visible";
      captureScroller.style.width = "100%";
      captureScroller.style.maxWidth = "none";
    }
    const captureTable =
      captureScroller?.querySelector<HTMLTableElement>("table");
    if (captureTable && fullTableWidth > 0) {
      captureTable.style.width = `${fullTableWidth}px`;
      captureTable.style.minWidth = `${fullTableWidth}px`;
      captureTable.style.maxWidth = "none";
    }

    document.body.appendChild(captureNode);

    let dataUrl: string;
    try {
      await document.fonts?.ready;
      const captureHeight = Math.ceil(captureNode.scrollHeight);
      dataUrl = await toPng(captureNode, {
        pixelRatio: 2,
        width: captureWidth,
        height: captureHeight,
        backgroundColor: "#020617",
        skipFonts: true,
      });
    } finally {
      captureNode.remove();
    }

    const blobRes = await fetch(dataUrl);
    const blob = await blobRes.blob();

    const firstValid = rowStates.find(
      (s): s is Extract<RowState, { status: "ok" }> => s.status === "ok"
    );
    const matrixSlug = (firstValid?.mx.data.name ?? "quote")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

    const quotePart = quoteNumber.trim()
      ? `-${quoteNumber.trim().replace(/[^0-9]+/g, "-")}`
      : "";
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(d.getDate()).padStart(2, "0")}`;
    const filename = `quote-${matrixSlug || "quote"}${quotePart}-${date}.png`;

    return { dataUrl, blob, filename };
  };

  const savePng = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await generateExportImage();
      if (!res) return;
      const a = document.createElement("a");
      a.href = res.dataUrl;
      a.download = res.filename;
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

  const handlePush = async () => {
    const normalizedQuoteNumber = quoteNumber.trim();
    if (
      !selectedInvoice ||
      isPushing ||
      !/^\d{1,20}$/.test(normalizedQuoteNumber)
    ) {
      return;
    }
    setIsPushing(true);
    setPushOutcome(null);

    try {
      const imgRes = await generateExportImage();
      if (!imgRes) throw new Error("Could not generate image");
      const { blob } = imgRes;

      const filtered = quote.filter((q) => activeRange.filter(q.qty));
      const priceRows = filtered.map((q) => ({
        qty: q.qty,
        unitPrice: q.unitPrice,
      }));

      if (priceRows.length === 0) {
        toast({
          title: "No pricing rows",
          description: "Selected range has no pricing rows.",
          variant: "destructive",
        });
        setIsPushing(false);
        return;
      }

      const reqRes = await requestUrlMutation.mutateAsync({
        data: {
          invoiceId: selectedInvoice.id,
          visualId: selectedInvoice.visualId,
          rangeKey,
          priceRows,
          quoteNumber: normalizedQuoteNumber,
          fileSizeBytes: blob.size,
        },
      });

      if (reqRes.uploadUrl) {
        const putRes = await fetch(reqRes.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "image/png" },
          body: blob,
        });
        if (!putRes.ok) throw new Error("Failed to upload PNG to storage");
      }

      const pushRes = await pushMutation.mutateAsync({
        data: {
          uploadId: reqRes.uploadId,
          invoiceId: selectedInvoice.id,
          visualId: selectedInvoice.visualId,
          rangeKey,
          priceRows,
          quoteNumber: normalizedQuoteNumber,
        },
      });

      setPushOutcome({
        noteOutcome: pushRes.noteOutcome,
        fileOutcome: pushRes.fileOutcome,
      });

      const fullyComplete =
        pushRes.noteOutcome.ok && pushRes.fileOutcome.ok;
      toast({
        title: fullyComplete ? "Push completed" : "Push partially completed",
        description: fullyComplete
          ? "Production Notes and the PNG were added to Printavo."
          : "Review the separate Production Notes and Production File results below.",
        variant: fullyComplete ? "default" : "destructive",
      });
    } catch (error: unknown) {
      console.error(error);
      const status =
        typeof error === "object" && error !== null && "status" in error
          ? Number(error.status)
          : undefined;
      const msg =
        status === 409
          ? "Another push is already running, or a previous Printavo write is locked. Refresh before taking any further action."
          : status === 422
            ? "The PNG upload may not have completed. No Printavo write was started."
            : error instanceof Error
              ? error.message
              : "An unexpected error occurred during push.";
      toast({ title: "Push failed", description: msg, variant: "destructive" });
    } finally {
      setIsPushing(false);
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
    <div className="space-y-6">
      {/* AI Calculator Assistant */}
      <div className="bg-[#059669]/5 border border-[#059669]/20 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-bold uppercase tracking-wider text-[#10b981]">
            AI Calculator Assistant
          </label>
        </div>
        <div className="flex gap-2">
          <textarea
            className={`${inputCls} resize-none h-[42px]`}
            placeholder="Paste order details or conversation here..."
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            data-testid="input-ai-prompt"
          />
          <button
            onClick={handleInterpret}
            disabled={
              interpretMutation.isPending || aiPrompt.trim().length < 8
            }
            className="flex items-center justify-center gap-1.5 px-4 rounded-lg bg-[#059669]/10 text-[#10b981] border border-[#059669]/30 hover:bg-[#059669]/20 font-semibold text-xs transition-colors whitespace-nowrap disabled:opacity-50"
            data-testid="button-ai-submit"
          >
            {interpretMutation.isPending ? (
              <Loader2 className="animate-spin" size={14} />
            ) : (
              <Sparkles size={14} />
            )}
            Interpret
          </button>
        </div>
        {aiWarnings.length > 0 && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded p-3 mt-3">
            <ul className="list-disc list-inside text-amber-400 text-[11px] space-y-1">
              {aiWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        {aiGarmentMatch && (
          <div
            className="bg-emerald-500/10 border border-emerald-500/20 rounded p-3 text-[11px] text-emerald-300"
            data-testid="ai-garment-match"
          >
            <div className="font-semibold">
              Matched{" "}
              {[aiGarmentMatch.brand, aiGarmentMatch.styleName]
                .filter(Boolean)
                .join(" ")}{" "}
              · {aiGarmentMatch.colorName} ·{" "}
              {aiGarmentMatch.vendor === "sanmar"
                ? "SanMar"
                : "S&S Activewear"}
            </div>
            <div className="mt-1 text-emerald-400/80">
              Regular XS–XL: ${money(aiGarmentMatch.regularCost)}
              {aiGarmentMatch.saleCost !== null && (
                <>
                  {" "}
                  · Sale: ${money(aiGarmentMatch.saleCost)} · using sale price
                </>
              )}
              {aiGarmentMatch.saleCost === null && " · using regular price"}
            </div>
          </div>
        )}
      </div>

      <div ref={exportRef} className="space-y-4 bg-[#020617] p-4 -m-4">
        {/* Inputs: narrow cost column on the left, locations to its right */}
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 items-start">
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 space-y-4">
            <div>
              <label className={labelCls} htmlFor="quote-number">
                Printavo Quote #
              </label>
              <input
                id="quote-number"
                type="text"
                value={quoteNumber}
                onChange={(e) =>
                  setQuoteNumber(e.target.value.replace(/\D/g, "").slice(0, 20))
                }
                inputMode="numeric"
                placeholder="e.g. 12345"
                className={inputCls}
                data-testid="input-quote-number"
              />
              {!quoteNumber && (
                <p className="text-[10px] text-slate-500 mt-1">
                  Required before pushing so Hub can safely refresh only this
                  quote's Production Notes block.
                </p>
              )}
            </div>
            <div className="border-t border-slate-800 -mx-4 px-4 pt-4">
              <VendorCostLookup
                onApply={(cost) => {
                  setGarmentCostStr(cost.toFixed(2));
                  garmentCostSourceRef.current = "vendor";
                  setAiGarmentMatch(null);
                }}
              />
            </div>
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
                    garmentCostSourceRef.current =
                      e.target.value.trim() === "" ? "empty" : "manual";
                    setAiGarmentMatch(null);
                    if (labelHint) setLabelHint("");
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
                  <button
                    onClick={() => setLabelHint("")}
                    className="hover:text-emerald-300"
                  >
                    <X size={12} />
                  </button>
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
                        This matrix was deleted — select another. This location
                        is not included in the price until you do.
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
          <div className="px-4 py-3 border-b border-slate-800 flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold text-white">
                Price breaks
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                Unit price = (garment × markup) + decoration per piece
              </div>
            </div>
            {quote.length > 0 && (
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
                      data-testid="button-copy-menu"
                      aria-label={`Copy ${activeRange.label} price breaks`}
                    >
                      <Copy size={13} /> Copy
                      <span className="text-slate-500">{activeRange.label}</span>
                      <ChevronDown size={12} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="min-w-40 bg-slate-900 border-slate-700"
                    data-testid="copy-range-menu"
                  >
                    {RANGES.map((range) => (
                      <DropdownMenuCheckboxItem
                        key={range.key}
                        checked={range.key === rangeKey}
                        onSelect={() => {
                          setRangeKey(range.key);
                          void copyQuote(range.key);
                        }}
                        className="text-xs text-slate-300 focus:bg-slate-800 focus:text-white"
                        data-testid={`copy-range-${range.key}`}
                      >
                        {range.label}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
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
            <div
              className="overflow-x-auto custom-scrollbar"
              data-export-table-scroll
            >
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
                  {quote.map((q) => {
                    return (
                      <tr
                        key={q.qty}
                        className="border-t border-slate-800"
                      >
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
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Push to Printavo (invoice or quote) */}
      {quote.length > 0 && (
        <div className="bg-[#1e293b]/30 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            <CloudUpload className="text-[#3b82f6]" size={16} />
            Push to Printavo
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <label className={labelCls}>Search Invoice / Quote</label>
              <div className="relative">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                  size={14}
                />
                <input
                  type="text"
                  value={searchQ}
                  onChange={(e) => {
                    setSearchQ(e.target.value);
                    setSelectedInvoice(null);
                  }}
                  placeholder="Type invoice or quote number..."
                  className={`${inputCls} pl-9`}
                  data-testid="input-invoice-search"
                />
              </div>

              {searchLoading && (
                <p className="text-[11px] text-slate-500 animate-pulse">
                  Searching...
                </p>
              )}

              {searchData &&
                searchData.invoices.length > 0 &&
                !selectedInvoice && (
                  <div
                    className="bg-slate-900 border border-slate-700 rounded-lg max-h-48 overflow-y-auto mt-2"
                    data-testid="invoice-search-results"
                  >
                    {searchData.invoices.map((inv) => (
                      <button
                        key={inv.id}
                        onClick={() => {
                          setSelectedInvoice(inv);
                          setSearchQ(String(inv.visualId));
                        }}
                        className="w-full text-left px-3 py-2 hover:bg-slate-800 border-b border-slate-800 last:border-0 transition-colors"
                        data-testid={`invoice-result-${inv.visualId}`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="flex items-center gap-1.5">
                            <span className="text-xs font-bold text-slate-200">
                              #{inv.visualId}
                            </span>
                            <span
                              className={`text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                                inv.orderType === "quote"
                                  ? "bg-amber-500/15 text-amber-400"
                                  : "bg-emerald-500/15 text-emerald-400"
                              }`}
                            >
                              {inv.orderType === "quote" ? "Quote" : "Invoice"}
                            </span>
                          </span>
                          <span className="text-[10px] text-slate-400 px-1.5 py-0.5 bg-slate-950 rounded">
                            {inv.statusName || "No status"}
                          </span>
                        </div>
                        <div className="text-[11px] text-slate-300 truncate mt-0.5">
                          {inv.nickname || "Untitled"}
                        </div>
                        <div className="text-[10px] text-slate-500 truncate mt-0.5">
                          {inv.customerCompany || "No customer company"}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              {searchData &&
                searchData.invoices.length === 0 &&
                debouncedQ.length >= 2 &&
                !selectedInvoice &&
                !searchLoading && (
                  <p className="text-[11px] text-slate-500 mt-2">
                    No invoices or quotes found for "{debouncedQ}".
                  </p>
                )}
            </div>

            <div className="flex flex-col justify-end">
              {selectedInvoice ? (
                <div className="bg-[#3b82f6]/10 border border-[#3b82f6]/20 rounded-lg p-3 space-y-3">
                  <div className="text-[11px] text-[#60a5fa] leading-relaxed">
                    Ready to push{" "}
                    <strong>
                      {quote.filter((q) => activeRange.filter(q.qty)).length}
                    </strong>{" "}
                    tiers from range <strong>{activeRange.label}</strong> to{" "}
                    {selectedInvoice.orderType === "quote" ? "quote" : "invoice"}{" "}
                    <strong>#{selectedInvoice.visualId}</strong>.
                  </div>
                   <div className="text-[10px] text-slate-400">
                     {selectedInvoice.nickname || "Untitled"}
                     {selectedInvoice.customerCompany
                       ? ` · ${selectedInvoice.customerCompany}`
                       : ""}
                     {selectedInvoice.statusName
                       ? ` · ${selectedInvoice.statusName}`
                       : ""}
                   </div>
                  <button
                    onClick={handlePush}
                     disabled={isPushing || !quoteNumber}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] text-white text-xs font-bold transition-colors disabled:opacity-50"
                    data-testid="button-push-printavo"
                  >
                    {isPushing ? (
                      <Loader2 className="animate-spin" size={14} />
                    ) : (
                      <CloudUpload size={14} />
                    )}
                    Confirm & Push
                  </button>
                   {!quoteNumber && (
                     <div className="text-[10px] text-amber-400">
                       Enter the Printavo Quote Number above before pushing.
                     </div>
                   )}
                </div>
              ) : (
                <div className="bg-slate-900/50 border border-slate-800 border-dashed rounded-lg h-[92px] flex items-center justify-center">
                  <span className="text-[11px] text-slate-500 font-medium">
                    Select an invoice or quote to push
                  </span>
                </div>
              )}
            </div>
          </div>

          {pushOutcome && (
            <div
              className="border-t border-slate-800/50 pt-4 space-y-2 mt-4"
              data-testid="push-outcomes"
            >
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-3">
                Push Results
              </div>

              <div
                className={`p-2.5 rounded-lg flex items-start gap-2.5 ${
                  pushOutcome.noteOutcome.ok
                    ? "bg-[#10b981]/10 border border-[#10b981]/20 text-[#10b981]"
                    : "bg-amber-500/10 border border-amber-500/20 text-amber-500"
                }`}
              >
                <div className="mt-0.5">
                  {pushOutcome.noteOutcome.ok ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <AlertTriangle size={14} />
                  )}
                </div>
                <div>
                  <div className="text-xs font-bold">
                    {pushOutcome.noteOutcome.ok
                      ? "Note Updated"
                      : "Note Update Failed"}
                  </div>
                  {pushOutcome.noteOutcome.error && (
                    <div className="text-[11px] mt-0.5 opacity-80">
                      {pushOutcome.noteOutcome.error}
                    </div>
                  )}
                  {pushOutcome.noteOutcome.locked && (
                    <div className="text-[10px] mt-1 font-bold uppercase tracking-wider text-amber-500">
                      Manual Verification Required - Do Not Retry
                    </div>
                  )}
                </div>
              </div>

              <div
                className={`p-2.5 rounded-lg flex items-start gap-2.5 ${
                  pushOutcome.fileOutcome.ok
                    ? "bg-[#10b981]/10 border border-[#10b981]/20 text-[#10b981]"
                    : "bg-amber-500/10 border border-amber-500/20 text-amber-500"
                }`}
              >
                <div className="mt-0.5">
                  {pushOutcome.fileOutcome.ok ? (
                    <CheckCircle2 size={14} />
                  ) : (
                    <AlertTriangle size={14} />
                  )}
                </div>
                <div>
                  <div className="text-xs font-bold">
                    {pushOutcome.fileOutcome.ok
                      ? "File Attached"
                      : "File Attachment Failed"}
                  </div>
                  {pushOutcome.fileOutcome.error && (
                    <div className="text-[11px] mt-0.5 opacity-80">
                      {pushOutcome.fileOutcome.error}
                    </div>
                  )}
                  {pushOutcome.fileOutcome.locked && (
                    <div className="text-[10px] mt-1 font-bold uppercase tracking-wider text-amber-500">
                      Manual Verification Required - Do Not Retry
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
