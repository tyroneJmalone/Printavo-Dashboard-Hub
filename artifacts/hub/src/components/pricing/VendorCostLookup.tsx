import { useEffect, useRef, useState } from "react";
import { Loader2, Search, Tag, X } from "lucide-react";
import {
  useVendorLookup,
  type VendorLookupResult,
  type VendorColorOffer,
  type VendorSizeOffer,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

const VENDOR_LABELS: Record<"sanmar" | "ss", string> = {
  sanmar: "SanMar",
  ss: "S&S Activewear",
};

const money = (n: number) =>
  n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const inputCls =
  "w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669]";

/**
 * Breezy base-size rule: the base price ALWAYS comes from the standard
 * XS–XL range — never a plus size, even if the vendor happens to price one
 * lower (plus sizes normally cost more and Tyler adjusts for them by hand).
 * Among XS–XL take the cheapest priced size; only when NO standard size has
 * a price fall back to the cheapest size overall.
 */
const STANDARD_SIZES = new Set(["XS", "S", "M", "L", "XL"]);
function baseSizeEntry(color: VendorColorOffer): VendorSizeOffer | null {
  let bestStandard: VendorSizeOffer | null = null;
  let bestAny: VendorSizeOffer | null = null;
  for (const s of color.sizes) {
    if (s.cost === null) continue;
    if (bestAny === null || s.cost < (bestAny.cost as number)) bestAny = s;
    if (
      STANDARD_SIZES.has(s.size) &&
      (bestStandard === null || s.cost < (bestStandard.cost as number))
    ) {
      bestStandard = s;
    }
  }
  return bestStandard ?? bestAny;
}

function formatSaleEnd(raw: string): string {
  const d = new Date(raw);
  return Number.isNaN(d.getTime())
    ? raw
    : d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
}

/** Color swatch — vendor image when available, else initials tile. */
function Swatch({
  color,
  selected,
  onPick,
}: {
  color: VendorColorOffer;
  selected: boolean;
  onPick: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const initials = color.colorName
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase();
  return (
    <button
      onClick={onPick}
      title={color.colorName}
      aria-label={`Color ${color.colorName}`}
      aria-pressed={selected}
      data-testid={`swatch-${color.colorName}`}
      className={`w-8 h-8 rounded-md overflow-hidden border transition-all flex items-center justify-center shrink-0 ${
        selected
          ? "border-[#10b981] ring-2 ring-[#059669]/60"
          : "border-slate-700 hover:border-slate-500"
      }`}
    >
      {color.swatchImage && !broken ? (
        <img
          src={color.swatchImage}
          alt={color.colorName}
          className="w-full h-full object-cover"
          loading="lazy"
          onError={() => setBroken(true)}
        />
      ) : (
        <span className="text-[9px] font-bold text-slate-400 bg-slate-800 w-full h-full flex items-center justify-center">
          {initials}
        </span>
      )}
    </button>
  );
}

/** Remounted via key={src} by the caller, so `broken` resets per image. */
function ProductThumb({ src, alt }: { src: string | null; alt: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return (
      <div className="w-24 h-28 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center shrink-0">
        <span className="text-[10px] text-slate-500">No image</span>
      </div>
    );
  }
  return (
    <div className="w-24 h-28 rounded-lg bg-white border border-slate-700 overflow-hidden shrink-0">
      <img
        src={src}
        alt={alt}
        className="w-full h-full object-contain"
        onError={() => setBroken(true)}
        data-testid="vendor-product-thumb"
      />
    </div>
  );
}

export function VendorCostLookup({
  onApply,
}: {
  /** Called with the chosen per-piece garment cost when the user applies a price. */
  onApply: (cost: number) => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [vendor, setVendor] = useState<"sanmar" | "ss">("sanmar");
  const [style, setStyle] = useState("");
  const [result, setResult] = useState<VendorLookupResult | null>(null);
  const [colorName, setColorName] = useState("");
  const [priceMode, setPriceMode] = useState<"regular" | "sale">("regular");
  // Guards against a slow in-flight lookup landing after the user switched
  // vendors (SanMar SOAP can take 15s+) — a stale result would show the old
  // vendor's prices under the new vendor's label.
  const vendorRef = useRef(vendor);
  const styleInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    styleInputRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const lookup = useVendorLookup({
    mutation: {
      onSuccess: (res) => {
        if (res.vendor !== vendorRef.current) return;
        setResult(res);
        setPriceMode("regular");
        // Pre-select the first color so the thumbnail + price show right away
        // (the user can still pick any swatch). Prefer a color priced in the
        // standard XS–XL range: SanMar sometimes splits 4XL/5XL into a
        // separate color bucket ("AntqChryRd" vs "Antqu Chry Red"), and a
        // plus-size-only bucket must never seed the base price.
        const firstStandard = res.colors.find((c) => {
          const b = baseSizeEntry(c);
          return b !== null && STANDARD_SIZES.has(b.size);
        });
        const firstPriced =
          firstStandard ?? res.colors.find((c) => baseSizeEntry(c) !== null);
        setColorName(firstPriced?.colorName ?? "");
        if (!res.found || res.colors.length === 0) {
          toast({
            title: `Style ${res.styleQueried} not found at ${VENDOR_LABELS[res.vendor]}`,
            description:
              res.vendor === "sanmar" && !/\d/.test(res.styleQueried)
                ? 'SanMar can only search by style number — include the number (e.g. "bella 3001").'
                : 'Try a brand + style number combo (e.g. "bella 3001"), adjust the style number, or type the cost manually.',
            variant: "destructive",
          });
        }
      },
      onError: (err) => {
        toast({
          title: "Vendor lookup failed",
          description:
            err instanceof Error ? err.message : "Vendor API unavailable",
          variant: "destructive",
        });
      },
    },
  });

  const search = () => {
    if (style.trim().length === 0 || lookup.isPending) return;
    lookup.mutate({ data: { vendor, style: style.trim() } });
  };

  const switchVendor = (next: "sanmar" | "ss") => {
    if (next === vendor) return;
    vendorRef.current = next;
    setVendor(next);
    setResult(null);
    setColorName("");
    setPriceMode("regular");
  };

  const found = result !== null && result.found && result.colors.length > 0;
  const selectedColor = found
    ? result.colors.find((c) => c.colorName === colorName)
    : undefined;
  const base = selectedColor ? baseSizeEntry(selectedColor) : null;
  const hasSale = base !== null && base.salePrice !== null;

  const chosenPrice: number | null =
    base === null
      ? null
      : priceMode === "sale" && base.salePrice !== null
        ? base.salePrice
        : base.cost;

  const pickColor = (name: string) => {
    setColorName(name);
    setPriceMode("regular");
  };

  const apply = () => {
    if (chosenPrice === null) return;
    onApply(chosenPrice);
    setOpen(false);
    toast({
      title: `Garment cost set to $${money(chosenPrice)}`,
      description: selectedColor
        ? `${[result?.brand, result?.styleName].filter(Boolean).join(" ")} · ${selectedColor.colorName}${base ? ` · base size ${base.size}` : ""}${priceMode === "sale" ? " · sale price" : ""}`
        : undefined,
    });
  };

  const thumbSrc = selectedColor?.productImage ?? result?.styleImage ?? null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center justify-center gap-2 text-xs font-semibold px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
        data-testid="vendor-cost-lookup"
      >
        <Search size={13} />
        Look up vendor pricing
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div
            className="bg-[#0f172a] border border-slate-800 rounded-xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl"
            data-testid="vendor-lookup-dialog"
          >
            <header className="flex items-center justify-between px-5 py-4 border-b border-slate-800 flex-shrink-0">
              <h2 className="text-base font-bold text-white">
                Vendor price lookup
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="text-slate-400 hover:text-white transition-colors"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar">
              {/* Vendor toggle */}
              <div
                className="grid grid-cols-2 gap-2"
                role="group"
                aria-label="Vendor"
              >
                {(["sanmar", "ss"] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => switchVendor(v)}
                    data-testid={`vendor-toggle-${v}`}
                    className={`text-xs font-semibold px-3 py-2 rounded-lg border transition-colors ${
                      vendor === v
                        ? "bg-[#059669]/10 border-[#059669]/40 text-[#10b981]"
                        : "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700"
                    }`}
                  >
                    {VENDOR_LABELS[v]}
                  </button>
                ))}
              </div>

              {/* Style search */}
              <div className="flex gap-2">
                <input
                  ref={styleInputRef}
                  type="text"
                  value={style}
                  onChange={(e) => setStyle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") search();
                  }}
                  placeholder="Style # or brand + style — e.g. PC54, bella 3001"
                  className={`${inputCls} font-mono`}
                  aria-label="Vendor style number"
                  data-testid="vendor-style-input"
                />
                <button
                  onClick={search}
                  disabled={lookup.isPending || style.trim().length === 0}
                  className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-40 shrink-0"
                  data-testid="vendor-search-button"
                >
                  {lookup.isPending ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Search size={13} />
                  )}
                  Search
                </button>
              </div>

              {lookup.isPending && (
                <p className="text-[11px] text-slate-500">
                  Checking {VENDOR_LABELS[vendor]}… this can take a few seconds.
                </p>
              )}

              {result !== null && !found && !lookup.isPending && (
                <p className="text-[11px] text-amber-400">
                  {result.vendor === "sanmar" &&
                  !/\d/.test(result.styleQueried) ? (
                    <>
                      SanMar can only search by style number — add the number
                      to your search (e.g. "bella 3001"), or enter the cost
                      manually.
                    </>
                  ) : (
                    <>
                      "{result.styleQueried}" not found at{" "}
                      {VENDOR_LABELS[result.vendor]} — try a brand + style
                      combo (e.g. "bella 3001"), or enter the cost manually.
                    </>
                  )}
                </p>
              )}

              {found && (
                <>
                  {result.matchType === "closest" && (
                    <p className="text-[11px] text-amber-400">
                      Closest match — the vendor didn't have an exact
                      style-number match. Double-check this is the right
                      product.
                    </p>
                  )}

                  {/* Product summary: thumbnail + info + price */}
                  <div className="flex gap-4">
                    <ProductThumb
                      key={thumbSrc ?? "none"}
                      src={thumbSrc}
                      alt={
                        [result.brand, result.styleName]
                          .filter(Boolean)
                          .join(" ") || "Product"
                      }
                    />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-sm font-semibold text-white truncate">
                        {[result.brand, result.styleName]
                          .filter(Boolean)
                          .join(" ")}
                      </p>
                      {result.title && (
                        <p className="text-[11px] text-slate-400 leading-snug">
                          {result.title}
                        </p>
                      )}
                      {selectedColor && (
                        <p className="text-[11px] text-slate-500">
                          {selectedColor.colorName}
                          {base ? ` · base size ${base.size}` : ""}
                        </p>
                      )}
                      {base !== null && (
                        <div className="pt-1">
                          {hasSale ? (
                            <p className="text-sm font-mono">
                              <span className="text-slate-500 line-through">
                                ${money(base.cost as number)}
                              </span>{" "}
                              <span className="text-[#10b981] font-bold">
                                ${money(base.salePrice as number)}
                              </span>
                            </p>
                          ) : (
                            <p className="text-sm font-mono text-white font-bold">
                              ${money(base.cost as number)}
                            </p>
                          )}
                        </div>
                      )}
                      {selectedColor && base === null && (
                        <p className="text-[11px] text-amber-400">
                          No vendor price for this color.
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Color swatches */}
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                      Color — {result.colors.length}
                    </p>
                    <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto custom-scrollbar pr-1">
                      {/* Keyed by style+color: colors like "Black" recur across
                          styles, and a stale broken-image flag from the previous
                          search must not hide a valid swatch. */}
                      {result.colors.map((c) => (
                        <Swatch
                          key={`${result.styleId ?? result.styleName ?? ""}:${c.colorName}`}
                          color={c}
                          selected={c.colorName === colorName}
                          onPick={() => pickColor(c.colorName)}
                        />
                      ))}
                    </div>
                  </div>

                  {/* Sale banner + Regular/Sale choice */}
                  {hasSale && (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 space-y-2">
                      <p className="text-[11px] text-amber-300">
                        <Tag size={11} className="inline mr-1 -mt-0.5" />
                        This color is on sale
                        {base?.saleEndsAt
                          ? ` through ${formatSaleEnd(base.saleEndsAt)}`
                          : ""}{" "}
                        — choose which price feeds the calculator.
                      </p>
                      <div
                        className="grid grid-cols-2 gap-2"
                        role="group"
                        aria-label="Price to use"
                      >
                        <button
                          onClick={() => setPriceMode("regular")}
                          data-testid="price-mode-regular"
                          className={`text-xs font-semibold px-3 py-2 rounded-lg border transition-colors ${
                            priceMode === "regular"
                              ? "bg-[#059669]/10 border-[#059669]/40 text-[#10b981]"
                              : "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700"
                          }`}
                        >
                          Regular ${money(base?.cost as number)}
                        </button>
                        <button
                          onClick={() => setPriceMode("sale")}
                          data-testid="price-mode-sale"
                          className={`flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border transition-colors ${
                            priceMode === "sale"
                              ? "bg-[#059669]/10 border-[#059669]/40 text-[#10b981]"
                              : "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700"
                          }`}
                        >
                          <Tag size={12} /> Sale ${money(
                            base?.salePrice as number,
                          )}
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>

            <footer className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800 flex-shrink-0">
              <button
                onClick={() => setOpen(false)}
                className="text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={apply}
                disabled={chosenPrice === null}
                data-testid="vendor-lookup-apply"
                className="text-xs font-semibold px-4 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-40"
              >
                {chosenPrice !== null
                  ? `Use $${money(chosenPrice)} in calculator`
                  : "Use in calculator"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}
