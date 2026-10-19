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
  FileText,
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
  useListHubCalculatorCategories,
  type DecorationMatrix,
  type HubPricingGarmentMatch,
  type HubInvoiceSearchItem,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { DEFAULT_MARKUP, MARKUP_PRESETS, MAX_LOCATIONS } from "./calcEngine";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GarmentCard, cleanProductDescription } from "./GarmentCard";
import { HandoffPanel, NewQuoteFields, type NewQuoteTarget } from "./HandoffPanel";
import {
  PLACEMENT_PRESETS,
  buildHandoffRequest,
  compareSchedule,
  emptyDecoration,
  emptyGarment,
  garmentLabel,
  handoffBlockers,
  mixedSummary,
  validDecorations,
  type DecorationRow,
  type GarmentRow,
  type PricingMode,
} from "./calcMulti";

type RangeKey = "all" | "12-48" | "36-72" | "60-96" | "84-120" | "108-144" | "144-288";

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
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const inputCls =
  "w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669]";
const labelCls = "block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5";

const segBtn = (active: boolean) =>
  `text-xs font-semibold px-3 py-2 rounded-lg border transition-colors ${
    active
      ? "bg-[#059669]/10 border-[#059669]/40 text-[#10b981]"
      : "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700"
  }`;

type Destination = "existing" | "new_quote";

const SCHEDULE_HEADERS: Array<[string, "left" | "right"]> = [
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
];

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
  const matrices = useMemo(() => data?.matrices ?? [], [data]);
  const { data: categoryData } = useListHubCalculatorCategories();
  const categories = useMemo(() => categoryData?.categories ?? [], [categoryData]);

  const [garments, setGarments] = useState<GarmentRow[]>(() => [emptyGarment(initialGarmentCost || "")]);
  const [labelHint, setLabelHint] = useState(initialLabel || "");
  const [mode, setMode] = useState<PricingMode>("compare");
  const [markupSel, setMarkupSel] = useState(String(DEFAULT_MARKUP));
  const [customMarkupStr, setCustomMarkupStr] = useState("");
  const [decorations, setDecorations] = useState<DecorationRow[]>(() => [emptyDecoration(0)]);
  const [rangeKey, setRangeKey] = useState<RangeKey>("all");

  const isCustomMarkup = markupSel === "custom";
  const markup = isCustomMarkup ? Number(customMarkupStr) : Number(markupSel);
  const markupValid = Number.isFinite(markup) && markup > 0;

  const [aiPrompt, setAiPrompt] = useState("");
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [aiGarmentMatch, setAiGarmentMatch] = useState<HubPricingGarmentMatch | null>(null);
  const interpretMutation = useInterpretHubPricingPrompt();

  // ── Destination (the ONLY source of the Printavo order number) ─────────
  const [destination, setDestination] = useState<Destination>("existing");
  const [searchQ, setSearchQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState<HubInvoiceSearchItem | null>(null);
  const selectedInvoiceRef = useRef<HubInvoiceSearchItem | null>(null);
  useEffect(() => {
    selectedInvoiceRef.current = selectedInvoice;
  }, [selectedInvoice]);
  const [newQuote, setNewQuote] = useState<NewQuoteTarget>({ customer: null, nickname: "", dueDate: "" });

  /** A quote created by the handoff; usable as a notes + PNG target right away. */
  const [createdQuote, setCreatedQuote] = useState<{ id: string; visualId: number } | null>(null);

  /** The order Notes + PNG goes to: the selected destination, or the new quote. */
  const notesTarget: { id: string; visualId: number; orderType: string } | null =
    destination === "existing"
      ? selectedInvoice
        ? { id: selectedInvoice.id, visualId: selectedInvoice.visualId, orderType: selectedInvoice.orderType }
        : null
      : createdQuote
        ? { ...createdQuote, orderType: "quote" }
        : null;

  /** Visible order number used for notes identity and export filenames. */
  const orderNumber = notesTarget ? String(notesTarget.visualId) : "";

  const [isPushing, setIsPushing] = useState(false);
  const [includeProductionNotes, setIncludeProductionNotes] = useState(true);
  const [pushOutcome, setPushOutcome] = useState<{
    noteOutcome: { ok: boolean; skipped?: boolean; error?: string | null; locked?: boolean };
    fileOutcome: { ok: boolean; error?: string | null; locked?: boolean };
  } | null>(null);
  const requestUrlMutation = useRequestHubPngUploadUrl({ mutation: { retry: false } });
  const pushMutation = usePushHubCalculator({ mutation: { retry: false } });

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
    },
  );

  const byId = useMemo(() => {
    const m = new Map<string, DecorationMatrix>();
    for (const mx of matrices) m.set(mx.id, mx);
    return m;
  }, [matrices]);

  const valid = useMemo(() => validDecorations(decorations, byId), [decorations, byId]);

  // Suggest a Printavo category from the first decoration matrix.
  const suggestedCategoryId = useMemo(() => {
    const matrixName = valid[0]?.matrix.name.toLowerCase() ?? "";
    if (!matrixName || categories.length === 0) return "";
    const term = matrixName.includes("embro") ? "embro" : matrixName.includes("print") ? "screen print" : "";
    const preferred = term ? categories.find((c) => c.name.toLowerCase().includes(term)) : undefined;
    if (preferred) return preferred.id;
    const words = matrixName
      .replace(/\b(1st|first|addnl|additional|location|loc)\b/g, " ")
      .split(/\W+/)
      .filter((w) => w.length >= 4);
    return categories.find((c) => words.some((w) => c.name.toLowerCase().includes(w)))?.id ?? "";
  }, [valid, categories]);

  useEffect(() => {
    if (!suggestedCategoryId) return;
    setGarments((prev) =>
      prev.some((g) => !g.categoryId)
        ? prev.map((g) => (g.categoryId ? g : { ...g, categoryId: suggestedCategoryId }))
        : prev,
    );
  }, [suggestedCategoryId, garments.length]);

  const schedules = useMemo(
    () => (markupValid ? garments.map((g) => compareSchedule(g, markup, valid)) : garments.map(() => [])),
    [garments, markup, markupValid, valid],
  );
  const mixed = useMemo(
    () => (markupValid && mode === "mixed" ? mixedSummary(garments, markup, valid) : null),
    [garments, markup, markupValid, mode, valid],
  );
  const hasResults = mode === "compare" ? schedules.some((s) => s.length > 0) : mixed !== null && mixed.lines.length > 0;
  const activeRange = RANGES.find((r) => r.key === rangeKey) || RANGES[0];

  const patchGarment = (id: string, patch: Partial<GarmentRow>) =>
    setGarments((prev) => prev.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  const patchDecoration = (id: string, patch: Partial<DecorationRow>) =>
    setDecorations((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  // ── AI prompt fill (fills the first style; other styles are kept) ──────
  const handleInterpret = () => {
    if (!aiPrompt.trim()) return;
    setAiWarnings([]);
    interpretMutation.mutate(
      { data: { prompt: aiPrompt } },
      {
        onSuccess: (res) => {
          setAiGarmentMatch(res.garmentMatch);
          setGarments((prev) => {
            const first = prev[0] ?? emptyGarment();
            const match = res.garmentMatch;
            const filled: GarmentRow = match
              ? {
                  ...first,
                  vendorSelection: null,
                  vendorMode: null,
                  style: match.styleName,
                  color: match.colorName,
                  brand: match.brand ?? "",
                  description: cleanProductDescription({
                    brand: match.brand ?? "",
                    style: match.styleName,
                    description: match.title ?? "",
                  }),
                  costStr: res.garmentCost !== null ? res.garmentCost.toFixed(2) : first.costStr,
                }
              : res.garmentCost !== null
                ? { ...first, vendorSelection: null, vendorMode: null, costStr: res.garmentCost.toFixed(2) }
                : first;
            return [filled, ...prev.slice(1)];
          });
          if (res.garmentMatch) {
            setLabelHint(
              [res.garmentMatch.brand, res.garmentMatch.styleName, res.garmentMatch.colorName,
                res.garmentMatch.vendor === "sanmar" ? "SanMar" : "S&S Activewear"]
                .filter(Boolean)
                .join(" · "),
            );
          }
          if (res.markup !== null) {
            if (MARKUP_PRESETS.includes(res.markup)) setMarkupSel(String(res.markup));
            else {
              setMarkupSel("custom");
              setCustomMarkupStr(String(res.markup));
            }
          }
          // A quote number in the prompt seeds the destination search; it never
          // overrides a destination the user already selected.
          if (res.quoteNumber !== null && !selectedInvoiceRef.current) {
            setDestination("existing");
            setSearchQ(res.quoteNumber);
          }
          if (res.decorations && res.decorations.length > 0) {
            setDecorations((prev) =>
              res.decorations.slice(0, MAX_LOCATIONS).map((d, i) => ({
                ...(prev[i] ?? emptyDecoration(i)),
                matrixId: d.matrixId,
                columnIndex: d.columnIndex,
              })),
            );
          }
          if (res.warnings && res.warnings.length > 0) setAiWarnings(res.warnings);
        },
        onError: () => {
          toast({
            title: "Failed to interpret prompt",
            description: "Please check your input and try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  // ── Copy ─────────────────────────────────────────────────────────────
  const copyQuote = async (selectedRange: RangeKey) => {
    const range = RANGES.find((c) => c.key === selectedRange) ?? RANGES[0];
    let text = "";
    if (mode === "compare") {
      const blocks = garments
        .map((g, i) => {
          const rows = schedules[i].filter((q) => range.filter(q.qty));
          if (rows.length === 0) return "";
          const lines = rows.map((q) => `${q.qty}+\t$${money(q.unitPrice)}`).join("\n");
          return garments.length > 1 ? `${garmentLabel(g, i)}\n${lines}` : lines;
        })
        .filter(Boolean);
      text = blocks.join("\n\n");
    } else if (mixed) {
      text = mixed.lines
        .map((l, i) => `${garmentLabel(l.garment, i)}\t${l.qty} pcs\t$${money(l.unitPrice)}`)
        .join("\n");
    }
    if (!text) {
      toast({ title: "No tiers in selected range", variant: "destructive" });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Price breaks copied to clipboard" });
    } catch {
      toast({ title: "Couldn't copy to clipboard", variant: "destructive" });
    }
  };

  // ── PNG export ───────────────────────────────────────────────────────
  const exportRef = useRef<HTMLDivElement>(null);
  const [exporting, setExporting] = useState(false);

  const generateExportImage = async () => {
    const node = exportRef.current;
    if (!node) return null;
    const scrollers = [...node.querySelectorAll<HTMLElement>("[data-export-table-scroll]")];
    const fullTableWidth = Math.ceil(
      Math.max(0, ...scrollers.map((s) => {
        const t = s.querySelector("table");
        return Math.max(s.scrollWidth, t?.scrollWidth ?? 0, t?.getBoundingClientRect().width ?? 0);
      })),
    );
    const sourceWidth = Math.ceil(node.getBoundingClientRect().width);
    const captureWidth = Math.max(sourceWidth, fullTableWidth + 40);

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
    captureNode.querySelectorAll<HTMLElement>("[data-export-table-scroll]").forEach((s) => {
      s.style.overflow = "visible";
      s.style.width = "100%";
      s.style.maxWidth = "none";
      const t = s.querySelector<HTMLTableElement>("table");
      if (t && fullTableWidth > 0) {
        t.style.width = `${fullTableWidth}px`;
        t.style.minWidth = `${fullTableWidth}px`;
        t.style.maxWidth = "none";
      }
    });
    (node.parentElement ?? document.body).appendChild(captureNode);

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
        // The off-screen offsets must not carry into html-to-image's render clone.
        style: { position: "static", left: "0", top: "0", margin: "0" },
      });
    } finally {
      captureNode.remove();
    }
    const blob = await (await fetch(dataUrl)).blob();
    const matrixSlug = (valid[0]?.matrix.data.name ?? "quote")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const orderPart = orderNumber ? `-${orderNumber}` : "";
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { dataUrl, blob, filename: `quote-${matrixSlug || "quote"}${orderPart}-${date}.png` };
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
      toast({ title: "Couldn't save PNG", description: "Something went wrong rendering the image. Try again.", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  // ── Production Notes + PNG (one block; single-style keeps legacy format) ─
  const notesPayload = useMemo(() => {
    if (mode === "mixed") {
      if (!mixed || mixed.lines.length !== garments.length) return null;
      return {
        rangeKey: "all" as RangeKey,
        priceRows: [] as Array<{ qty: number; unitPrice: number }>,
        noteSections: mixed.lines.map((l) => ({
          label: garmentLabel(l.garment, garments.indexOf(l.garment)),
          kind: "order" as const,
          rows: [{ qty: l.qty, unitPrice: l.unitPrice }],
        })),
        summary: `${mixed.lines.length} styles · ${mixed.combinedQty} pcs combined`,
      };
    }
    const perStyle = schedules.map((rows) =>
      rows.filter((q) => activeRange.filter(q.qty)).map((q) => ({ qty: q.qty, unitPrice: q.unitPrice })),
    );
    if (perStyle.length === 0 || perStyle.some((rows) => rows.length === 0)) return null;
    if (garments.length === 1) {
      return { rangeKey, priceRows: perStyle[0]!, noteSections: null, summary: `${perStyle[0]!.length} tiers` };
    }
    return {
      rangeKey,
      priceRows: [] as Array<{ qty: number; unitPrice: number }>,
      noteSections: garments.map((g, i) => ({ label: garmentLabel(g, i), kind: "schedule" as const, rows: perStyle[i]! })),
      summary: `${garments.length} styles · ${perStyle.reduce((n, r) => n + r.length, 0)} tiers`,
    };
  }, [mode, mixed, garments, schedules, activeRange, rangeKey]);

  const handlePush = async () => {
    const target = notesTarget;
    const payload = notesPayload;
    if (!target || isPushing) return;
    if (!payload) {
      toast({ title: "Nothing to push", description: "Every style needs prices in the selected range.", variant: "destructive" });
      return;
    }
    const { priceRows, noteSections, rangeKey: pushRange } = payload;
    const quoteNumber = String(target.visualId);
    setIsPushing(true);
    setPushOutcome(null);
    try {
      const imgRes = await generateExportImage();
      if (!imgRes) throw new Error("Could not generate image");
      const reqRes = await requestUrlMutation.mutateAsync({
        data: {
          invoiceId: target.id,
          visualId: target.visualId,
          rangeKey: pushRange,
          priceRows,
          quoteNumber,
          fileSizeBytes: imgRes.blob.size,
          lineItem: null,
          noteSections,
        },
      });
      if (reqRes.uploadUrl) {
        const putRes = await fetch(reqRes.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "image/png" },
          body: imgRes.blob,
        });
        if (!putRes.ok) throw new Error("Failed to upload PNG to storage");
      }
      const pushRes = await pushMutation.mutateAsync({
        data: {
          includeProductionNotes,
          uploadId: reqRes.uploadId,
          invoiceId: target.id,
          visualId: target.visualId,
          rangeKey: pushRange,
          priceRows,
          quoteNumber,
          lineItem: null,
          noteSections,
        },
      });
      setPushOutcome({ noteOutcome: pushRes.noteOutcome, fileOutcome: pushRes.fileOutcome });
      const ok = pushRes.noteOutcome.ok && pushRes.fileOutcome.ok;
      toast({
        title: ok ? "Push completed" : "Push partially completed",
        description: ok
          ? pushRes.noteOutcome.skipped
            ? "The PNG was attached to Printavo. Production Notes were left unchanged."
            : "Production Notes and the PNG were added to Printavo."
          : "Review the separate push results below.",
        variant: ok ? "default" : "destructive",
      });
    } catch (error: unknown) {
      console.error(error);
      const status =
        typeof error === "object" && error !== null && "status" in error ? Number(error.status) : undefined;
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

  // ── Line-item handoff request ────────────────────────────────────────
  const blockers = useMemo(() => {
    const out = handoffBlockers({ mode, garments, decorations, valid, mixed });
    if (!markupValid) out.unshift("Enter a valid markup.");
    if (destination === "existing" && !selectedInvoice) out.unshift("Select a destination invoice or quote.");
    if (destination === "new_quote") {
      if (!newQuote.customer?.contactId) out.unshift("Select a customer and contact.");
      if (!newQuote.nickname.trim()) out.push("Enter a quote nickname.");
      if (!newQuote.dueDate) out.push("Set a customer due date.");
    }
    return out;
  }, [mode, garments, decorations, valid, mixed, markupValid, destination, selectedInvoice, newQuote]);

  const handoffRequest = useMemo(() => {
    if (blockers.length > 0) return null;
    return buildHandoffRequest({
      mode,
      markup,
      rangeKey,
      garments,
      decorations: valid,
      mixed,
      target:
        destination === "existing"
          ? { kind: "existing", orderId: selectedInvoice!.id }
          : {
              kind: "new_quote",
              customerId: newQuote.customer!.customerId,
              contactId: newQuote.customer!.contactId!,
              nickname: newQuote.nickname,
              dueDate: newQuote.dueDate,
            },
    });
  }, [blockers, mode, markup, rangeKey, garments, valid, mixed, destination, selectedInvoice, newQuote]);

  // A different new-quote destination invalidates the previously created one.
  useEffect(() => {
    setCreatedQuote(null);
  }, [newQuote.customer?.customerId, newQuote.customer?.contactId, newQuote.nickname, newQuote.dueDate]);

  const selectInvoice = (inv: HubInvoiceSearchItem | null) => {
    setSelectedInvoice(inv);
    setPushOutcome(null);
  };

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="calculator-loading">
        <div className="h-16 rounded-xl bg-slate-900/60 animate-pulse" />
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-4">
          <div className="h-64 rounded-xl bg-slate-900/60 animate-pulse" />
          <div className="h-64 rounded-xl bg-slate-900/60 animate-pulse" />
        </div>
      </div>
    );
  }

  if (matrices.length === 0) {
    return (
      <div className="bg-slate-900/40 border border-slate-800 rounded-xl px-6 py-12 text-center max-w-2xl mx-auto">
        <MapPin className="mx-auto text-slate-600 mb-3" size={36} />
        <p className="text-sm text-slate-300 font-medium">No pricing matrices yet</p>
        <p className="text-xs text-slate-500 mt-1.5">The calculator needs at least one decoration pricing matrix.</p>
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
        <label className="text-[11px] font-bold uppercase tracking-wider text-[#10b981]">AI Calculator Assistant</label>
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
            disabled={interpretMutation.isPending || aiPrompt.trim().length < 8}
            className="flex items-center justify-center gap-1.5 px-4 rounded-lg bg-[#059669]/10 text-[#10b981] border border-[#059669]/30 hover:bg-[#059669]/20 font-semibold text-xs transition-colors whitespace-nowrap disabled:opacity-50"
            data-testid="button-ai-submit"
          >
            {interpretMutation.isPending ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
            Interpret
          </button>
        </div>
        <p className="text-[10px] text-slate-500">Fills style 1, markup and decorations. Other styles are kept.</p>
        {aiWarnings.length > 0 && (
          <div className="bg-amber-500/10 border border-amber-500/20 rounded p-3">
            <ul className="list-disc list-inside text-amber-400 text-[11px] space-y-1">
              {aiWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}
        {aiGarmentMatch && (
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded p-3 text-[11px] text-emerald-300" data-testid="ai-garment-match">
            <div className="font-semibold">
              Matched {[aiGarmentMatch.brand, aiGarmentMatch.styleName].filter(Boolean).join(" ")} · {aiGarmentMatch.colorName} ·{" "}
              {aiGarmentMatch.vendor === "sanmar" ? "SanMar" : "S&S Activewear"}
            </div>
            <div className="mt-1 text-emerald-400/80">
              Regular XS–XL: ${money(aiGarmentMatch.regularCost)}
              {aiGarmentMatch.saleCost !== null && <> · Sale: ${money(aiGarmentMatch.saleCost)} · using sale price</>}
              {aiGarmentMatch.saleCost === null && " · using regular price"}
            </div>
          </div>
        )}
      </div>

      <div ref={exportRef} className="space-y-4 bg-[#020617] p-4 -m-4">
        {/* Pricing mode */}
        <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row md:items-center gap-3 justify-between">
          <div>
            <div className={labelCls + " mb-1"}>Pricing mode</div>
            <p className="text-[11px] text-slate-400 max-w-xl">
              {mode === "compare"
                ? "Compare styles: each style gets its own quantity schedule. Nothing is ordered yet."
                : "Mixed order: real size breakdowns per style. The combined total sets one shared decoration tier; each style keeps its own garment cost."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 shrink-0" role="group" aria-label="Pricing mode">
            <button className={segBtn(mode === "compare")} aria-pressed={mode === "compare"} onClick={() => setMode("compare")} data-testid="mode-compare">
              Compare styles
            </button>
            <button className={segBtn(mode === "mixed")} aria-pressed={mode === "mixed"} onClick={() => setMode("mixed")} data-testid="mode-mixed">
              Mixed order
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-4 items-start">
          {/* Garments */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className={`${labelCls} mb-0`}>Garment styles · {garments.length}</span>
              <button
                onClick={() => setGarments((prev) => [...prev, { ...emptyGarment(), categoryId: suggestedCategoryId }])}
                disabled={garments.length >= 12}
                className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-40"
                data-testid="button-add-garment"
              >
                <Plus size={12} /> Add style
              </button>
            </div>
            {labelHint && (
              <div className="flex items-center justify-between bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] px-2 py-1.5 rounded">
                <span className="truncate mr-2">From: {labelHint}</span>
                <button onClick={() => setLabelHint("")} className="hover:text-emerald-300" aria-label="Dismiss source">
                  <X size={12} />
                </button>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2 gap-3">
              {garments.map((g, i) => (
                <GarmentCard
                  key={g.id}
                  row={g}
                  index={i}
                  mode={mode}
                  markup={markup}
                  markupValid={markupValid}
                  canRemove={garments.length > 1}
                  categories={categories}
                  onChange={(patch) => patchGarment(g.id, patch)}
                  onRemove={() => setGarments((prev) => prev.filter((x) => x.id !== g.id))}
                />
              ))}
            </div>
          </div>

          <div className="space-y-4">
            {/* Shared markup */}
            <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
              <span className={labelCls}>Markup multiplier (shared)</span>
              <div className="grid grid-cols-7 gap-1" role="group" aria-label="Markup multiplier">
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
                    data-testid="input-custom-markup"
                  />
                )}
              </div>
              {isCustomMarkup && !markupValid && <p className="text-[11px] text-amber-400 mt-1">Enter a markup greater than 0.</p>}
            </div>

            {/* Shared decorations */}
            <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className={`${labelCls} mb-0`}>Decoration (shared by all styles)</span>
                <button
                  onClick={() => setDecorations((prev) => [...prev, emptyDecoration(prev.length)])}
                  disabled={decorations.length >= MAX_LOCATIONS}
                  className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-40"
                  data-testid="button-add-location"
                >
                  <Plus size={12} /> Add placement
                </button>
              </div>
              <datalist id="calc-placement-presets">
                {PLACEMENT_PRESETS.map((p) => <option key={p} value={p} />)}
              </datalist>
              {decorations.map((r, i) => {
                const mx = byId.get(r.matrixId);
                const missing = r.matrixId !== "" && !mx;
                const columnGone = mx !== undefined && mx.data.xValues[r.columnIndex] === undefined;
                return (
                  <div key={r.id} className="border border-slate-800 rounded-lg p-3 space-y-2" data-testid={`decoration-row-${i}`}>
                    <div className="flex items-center gap-2">
                      <input
                        value={r.placement}
                        list="calc-placement-presets"
                        onChange={(e) => patchDecoration(r.id, { placement: e.target.value.slice(0, 80) })}
                        placeholder="Placement, e.g. Left Chest"
                        className={`${inputCls} font-semibold`}
                        aria-label={`Placement ${i + 1}`}
                        data-testid={`input-placement-${i}`}
                      />
                      {i === 0 && valid.length > 0 && mode === "compare" && (
                        <span className="text-[9px] text-slate-500 whitespace-nowrap">sets qty tiers</span>
                      )}
                      {decorations.length > 1 && (
                        <button
                          onClick={() => setDecorations((prev) => prev.filter((x) => x.id !== r.id))}
                          className="text-slate-500 hover:text-red-400 transition-colors shrink-0"
                          aria-label={`Remove placement ${i + 1}`}
                          data-testid={`button-remove-placement-${i}`}
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                    <input
                      value={r.details}
                      onChange={(e) => patchDecoration(r.id, { details: e.target.value.slice(0, 300) })}
                      placeholder="Details, e.g. 2 color logo, PMS 3285 + white"
                      className={inputCls}
                      aria-label={`Placement ${i + 1} details`}
                      data-testid={`input-placement-details-${i}`}
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={r.matrixId}
                        onChange={(e) => patchDecoration(r.id, { matrixId: e.target.value, columnIndex: 0 })}
                        className={inputCls}
                        aria-label={`Placement ${i + 1} matrix`}
                        data-testid={`select-matrix-${i}`}
                      >
                        <option value="">Select a matrix…</option>
                        {matrices.map((m) => <option key={m.id} value={m.id}>{m.data.name}</option>)}
                      </select>
                      {mx ? (
                        <select
                          value={String(r.columnIndex)}
                          onChange={(e) => patchDecoration(r.id, { columnIndex: Number(e.target.value) })}
                          className={inputCls}
                          aria-label={`Placement ${i + 1} ${mx.data.xAxisLabel}`}
                          data-testid={`select-column-${i}`}
                        >
                          {columnGone && <option value={String(r.columnIndex)} disabled>Select {mx.data.xAxisLabel}…</option>}
                          {mx.data.xValues.map((x, xi) => (
                            <option key={xi} value={String(xi)}>{mx.data.xAxisLabel}: {x.label}</option>
                          ))}
                        </select>
                      ) : (
                        <div className="text-[10px] text-slate-600 flex items-center">Pick a matrix first</div>
                      )}
                    </div>
                    {missing && <p className="text-[11px] text-amber-400">This matrix was deleted. Select another; it is not priced until you do.</p>}
                    {columnGone && mx && <p className="text-[11px] text-amber-400">This matrix changed. Pick a {mx.data.xAxisLabel} again.</p>}
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
                {mode === "compare" ? "Price breaks by style" : "Mixed order pricing"}
                {orderNumber && <span className="text-slate-500 font-normal"> · #{orderNumber}</span>}
              </div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                Unit price = (garment × markup) + decoration per piece
                {valid.length > 0 && ` · ${valid.map((d) => d.row.placement || "Placement").join(", ")}`}
              </div>
            </div>
            {hasResults && (
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
                      data-testid="button-copy-menu"
                    >
                      <Copy size={13} /> Copy
                      {mode === "compare" && <span className="text-slate-500">{activeRange.label}</span>}
                      <ChevronDown size={12} />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-40 bg-slate-900 border-slate-700" data-testid="copy-range-menu">
                    {(mode === "compare" ? RANGES : RANGES.slice(0, 1)).map((range) => (
                      <DropdownMenuCheckboxItem
                        key={range.key}
                        checked={range.key === rangeKey}
                        onSelect={() => {
                          if (mode === "compare") setRangeKey(range.key);
                          void copyQuote(range.key);
                        }}
                        className="text-xs text-slate-300 focus:bg-slate-800 focus:text-white"
                        data-testid={`copy-range-${range.key}`}
                      >
                        {mode === "compare" ? range.label : "Copy unit prices"}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
                <button
                  onClick={savePng}
                  disabled={exporting}
                  data-testid="save-png"
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-60"
                >
                  {exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  Save PNG
                </button>
              </div>
            )}
          </div>

          {!hasResults ? (
            <div className="px-6 py-12 text-center">
              <p className="text-sm text-slate-300 font-medium">No prices yet</p>
              <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                {!markupValid
                  ? "Fix the markup to see prices."
                  : mode === "compare"
                    ? "Enter a garment cost and pick a matrix column for at least one placement. The first placement's quantity tiers become the rows."
                    : "Enter garment costs, a size breakdown for each style, and a matrix column for each placement."}
              </p>
            </div>
          ) : mode === "compare" ? (
            <div className="divide-y divide-slate-800">
              {garments.map((g, gi) =>
                schedules[gi].length === 0 ? (
                  <div key={g.id} className="px-4 py-3 text-[11px] text-slate-500">
                    {garmentLabel(g, gi)}: enter a garment cost to price this style.
                  </div>
                ) : (
                  <div key={g.id}>
                    {garments.length > 1 && (
                      <div className="px-4 pt-3 text-xs font-semibold text-slate-200" data-testid={`text-schedule-title-${gi}`}>
                        {garmentLabel(g, gi)}
                      </div>
                    )}
                    <div className="overflow-x-auto custom-scrollbar" data-export-table-scroll>
                      <table className="w-full text-xs border-collapse" data-testid={gi === 0 ? "quote-results" : `quote-results-${gi}`}>
                        <thead>
                          <tr className="bg-slate-900/60">
                            {SCHEDULE_HEADERS.map(([label, align]) => (
                              <th key={label} className={`px-3 py-2.5 ${align === "left" ? "text-left" : "text-right"} text-[9px] font-bold uppercase tracking-wider text-slate-500 whitespace-nowrap`}>
                                {label}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {schedules[gi].map((q) => (
                            <tr key={q.qty} className="border-t border-slate-800">
                              <td className="px-3 py-2.5 font-mono text-slate-300 whitespace-nowrap">{q.qty}+</td>
                              <td className="px-3 py-2.5 text-right font-mono text-slate-500 whitespace-nowrap">${money(q.garmentCost)}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-slate-500 whitespace-nowrap">${money(q.garmentMarkup)}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-slate-400 whitespace-nowrap">${money(q.baseCost)}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-slate-400 whitespace-nowrap">${money(q.decorationCost)}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-[#10b981] font-semibold whitespace-nowrap">${money(q.unitPrice)}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-slate-500 whitespace-nowrap">${money(q.totalGarment)}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-slate-400 whitespace-nowrap">${money(q.totalBlankMarkup)}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-slate-400 whitespace-nowrap">${money(q.totalDecoration)}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-slate-200 font-semibold whitespace-nowrap">${money(q.total)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ),
              )}
            </div>
          ) : (
            mixed && (
              <div className="overflow-x-auto custom-scrollbar" data-export-table-scroll>
                <table className="w-full text-xs border-collapse" data-testid="mixed-results">
                  <thead>
                    <tr className="bg-slate-900/60">
                      {[["Style", "left"], ["Qty", "right"], ["Garment Cost", "right"], ["Base Cost $", "right"], ["Decoration/PC", "right"], ["Unit Price", "right"], ["Line Total", "right"]].map(([label, align]) => (
                        <th key={label} className={`px-3 py-2.5 ${align === "left" ? "text-left" : "text-right"} text-[9px] font-bold uppercase tracking-wider text-slate-500 whitespace-nowrap`}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {mixed.lines.map((l, i) => (
                      <tr key={l.garment.id} className="border-t border-slate-800" data-testid={`row-mixed-${i}`}>
                        <td className="px-3 py-2.5 text-slate-200 whitespace-nowrap">{garmentLabel(l.garment, garments.indexOf(l.garment))}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-slate-300">{l.qty}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-slate-500">${money(l.garmentCost)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-slate-400">${money(l.baseCost)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-slate-400">${money(l.decorationCost)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-[#10b981] font-semibold">${money(l.unitPrice)}</td>
                        <td className="px-3 py-2.5 text-right font-mono text-slate-200 font-semibold">${money(l.total)}</td>
                      </tr>
                    ))}
                    <tr className="border-t-2 border-slate-700 bg-slate-900/60">
                      <td className="px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Combined</td>
                      <td className="px-3 py-2.5 text-right font-mono text-white font-bold" data-testid="text-combined-qty">{mixed.combinedQty}</td>
                      <td colSpan={4} className="px-3 py-2.5 text-right text-[10px] text-slate-500">
                        Shared decoration tier at {mixed.combinedQty} pcs
                        {mixed.lines.length < garments.length && ` · ${garments.length - mixed.lines.length} style(s) missing cost or sizes`}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-white font-bold" data-testid="text-mixed-total">${money(mixed.total)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>
      </div>

      {/* Send to Printavo */}
      {hasResults && (
        <div className="bg-[#1e293b]/30 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-200 flex items-center gap-2">
              <CloudUpload className="text-[#3b82f6]" size={16} />
              Push to Printavo
            </div>
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Destination">
              <button className={segBtn(destination === "existing")} aria-pressed={destination === "existing"} onClick={() => setDestination("existing")} data-testid="destination-existing">
                Existing invoice / quote
              </button>
              <button className={segBtn(destination === "new_quote")} aria-pressed={destination === "new_quote"} onClick={() => setDestination("new_quote")} data-testid="destination-new-quote">
                New quote
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <div className="space-y-4">
              {destination === "existing" ? (
                <div className="space-y-3">
                  <label className={labelCls}>Search invoice / quote</label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={14} />
                    <input
                      type="text"
                      value={searchQ}
                      onChange={(e) => {
                        setSearchQ(e.target.value);
                        selectInvoice(null);
                      }}
                      placeholder="Type invoice or quote number..."
                      className={`${inputCls} pl-9`}
                      data-testid="input-invoice-search"
                    />
                  </div>
                  {searchLoading && debouncedQ.trim().length >= 2 && (
                    <div className="space-y-1.5">
                      {[0, 1].map((i) => <div key={i} className="h-10 rounded-md bg-slate-800/60 animate-pulse" />)}
                    </div>
                  )}
                  {searchData && searchData.invoices.length > 0 && !selectedInvoice && (
                    <div className="bg-slate-900 border border-slate-700 rounded-lg max-h-48 overflow-y-auto" data-testid="invoice-search-results">
                      {searchData.invoices.map((inv) => (
                        <button
                          key={inv.id}
                          onClick={() => {
                            selectInvoice(inv);
                            setSearchQ(String(inv.visualId));
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-slate-800 border-b border-slate-800 last:border-0 transition-colors"
                          data-testid={`invoice-result-${inv.visualId}`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="flex items-center gap-1.5">
                              <span className="text-xs font-bold text-slate-200">#{inv.visualId}</span>
                              <span className={`text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${inv.orderType === "quote" ? "bg-amber-500/15 text-amber-400" : "bg-emerald-500/15 text-emerald-400"}`}>
                                {inv.orderType === "quote" ? "Quote" : "Invoice"}
                              </span>
                            </span>
                            <span className="text-[10px] text-slate-400 px-1.5 py-0.5 bg-slate-950 rounded">{inv.statusName || "No status"}</span>
                          </div>
                          <div className="text-[11px] text-slate-300 truncate mt-0.5">{inv.nickname || "Untitled"}</div>
                          <div className="text-[10px] text-slate-500 truncate mt-0.5">{inv.customerCompany || "No customer company"}</div>
                        </button>
                      ))}
                    </div>
                  )}
                  {searchData && searchData.invoices.length === 0 && debouncedQ.length >= 2 && !selectedInvoice && !searchLoading && (
                    <p className="text-[11px] text-slate-500">No invoices or quotes found for "{debouncedQ}".</p>
                  )}
                  {selectedInvoice ? (
                    <div className="bg-[#3b82f6]/10 border border-[#3b82f6]/20 rounded-lg p-3" data-testid="selected-destination">
                      <div className="text-[11px] text-[#60a5fa]">
                        Destination {selectedInvoice.orderType} <strong>#{selectedInvoice.visualId}</strong>. This number labels the notes block and exports.
                      </div>
                      <div className="text-[10px] text-slate-400 mt-1">
                        {selectedInvoice.nickname || "Untitled"}
                        {selectedInvoice.customerCompany ? ` · ${selectedInvoice.customerCompany}` : ""}
                        {selectedInvoice.statusName ? ` · ${selectedInvoice.statusName}` : ""}
                      </div>
                    </div>
                  ) : (
                    <div className="bg-slate-900/50 border border-slate-800 border-dashed rounded-lg py-6 text-center text-[11px] text-slate-500">
                      Select an invoice or quote
                    </div>
                  )}
                </div>
              ) : (
                <NewQuoteFields value={newQuote} onChange={setNewQuote} />
              )}

              {/* Production Notes + PNG: one block for every style, any mode/destination */}
              {notesTarget ? (
                <div className="rounded-lg border border-slate-700 bg-slate-900/40 p-4 space-y-3" data-testid="notes-push-panel">
                  <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                    <FileText size={14} className="text-[#60a5fa]" />
                    Attach pricing PNG
                  </div>
                  {mode === "compare" && (
                    <div>
                      <label className={labelCls}>Range</label>
                      <select value={rangeKey} onChange={(e) => setRangeKey(e.target.value as RangeKey)} className={inputCls} data-testid="select-notes-range">
                        {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
                      </select>
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      checked={includeProductionNotes}
                      disabled={isPushing}
                      onChange={(event) => {
                        setIncludeProductionNotes(event.target.checked);
                        setPushOutcome(null);
                      }}
                      data-testid="checkbox-include-production-notes"
                    />
                    Include Production Notes
                  </label>
                  <p className="text-[11px] text-slate-400" data-testid="text-notes-summary">
                    {notesPayload
                      ? includeProductionNotes
                        ? `${notesPayload.summary} in one Production Notes block on ${notesTarget.orderType} #${notesTarget.visualId}. It replaces any earlier calculator block there. The PNG shows every style above.`
                        : `Attach the pricing PNG to ${notesTarget.orderType} #${notesTarget.visualId} only. Existing Production Notes will not be changed or removed.`
                      : mode === "mixed"
                        ? "Every style needs a cost and a size breakdown first."
                        : "Every style needs prices in the selected range."}
                  </p>
                  <button
                    onClick={handlePush}
                    disabled={isPushing || !notesPayload}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#3b82f6] hover:bg-[#2563eb] text-white text-xs font-bold transition-colors disabled:opacity-50"
                    data-testid="button-push-printavo"
                  >
                    {isPushing ? <Loader2 className="animate-spin" size={14} /> : <CloudUpload size={14} />}
                    {includeProductionNotes ? "Confirm & push notes + PNG" : "Confirm & push PNG only"}
                  </button>
                  {pushOutcome && (
                    <div className="space-y-2" data-testid="push-outcomes">
                      {([
                        [pushOutcome.noteOutcome.skipped ? "Production Notes skipped — unchanged" : "Note Updated", "Note Update Failed", pushOutcome.noteOutcome],
                        ["File Attached", "File Attachment Failed", pushOutcome.fileOutcome],
                      ] as const).map(([okLabel, failLabel, outcome]) => (
                        <div key={okLabel} className={`p-2.5 rounded-lg flex items-start gap-2.5 ${outcome.ok ? "bg-[#10b981]/10 border border-[#10b981]/20 text-[#10b981]" : "bg-amber-500/10 border border-amber-500/20 text-amber-500"}`}>
                          {outcome.ok ? <CheckCircle2 size={14} className="mt-0.5" /> : <AlertTriangle size={14} className="mt-0.5" />}
                          <div>
                            <div className="text-xs font-bold">{outcome.ok ? okLabel : failLabel}</div>
                            {outcome.error && <div className="text-[11px] mt-0.5 opacity-80">{outcome.error}</div>}
                            {outcome.locked && <div className="text-[10px] mt-1 font-bold uppercase tracking-wider">Manual Verification Required - Do Not Retry</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : destination === "new_quote" ? (
                <div className="rounded-lg border border-dashed border-slate-800 p-4 text-[11px] text-slate-500" data-testid="notes-push-pending">
                  Pricing notes + PNG can be attached once the new quote is created.
                </div>
              ) : null}
            </div>

            <HandoffPanel
              onResult={(r) => {
                if (r.status === "ok" && r.targetKind === "new_quote" && r.orderId && r.visualId) {
                  setCreatedQuote({ id: r.orderId, visualId: r.visualId });
                  setPushOutcome(null);
                }
              }}
              request={handoffRequest}
              blockers={blockers}
              isNewQuote={destination === "new_quote"}
              destinationLabel={
                destination === "existing"
                  ? selectedInvoice
                    ? `${selectedInvoice.orderType} #${selectedInvoice.visualId}`
                    : null
                  : newQuote.customer
                    ? `a new quote for ${newQuote.customer.companyName}`
                    : null
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}
