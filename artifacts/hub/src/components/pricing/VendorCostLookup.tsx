import { useRef, useState } from "react";
import { Loader2, Search, Tag } from "lucide-react";
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
const labelCls =
  "block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5";

/**
 * Breezy base-size rule: per color, the size entry with the LOWEST regular
 * cost is the base size (S–XL) — using it avoids 2XL+ upcharges.
 */
function baseSizeEntry(color: VendorColorOffer): VendorSizeOffer | null {
  let best: VendorSizeOffer | null = null;
  for (const s of color.sizes) {
    if (s.cost === null) continue;
    if (best === null || s.cost < (best.cost as number)) best = s;
  }
  return best;
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

export function VendorCostLookup({
  onApply,
}: {
  /** Called with the chosen per-piece garment cost whenever a price is picked. */
  onApply: (cost: number) => void;
}) {
  const { toast } = useToast();
  const [vendor, setVendor] = useState<"sanmar" | "ss">("sanmar");
  const [style, setStyle] = useState("");
  const [result, setResult] = useState<VendorLookupResult | null>(null);
  const [colorName, setColorName] = useState("");
  const [priceMode, setPriceMode] = useState<"regular" | "sale">("regular");
  // Guards against a slow in-flight lookup landing after the user switched
  // vendors (SanMar SOAP can take 15s+) — a stale result would show the old
  // vendor's prices under the new vendor's label.
  const vendorRef = useRef(vendor);

  const lookup = useVendorLookup({
    mutation: {
      onSuccess: (res) => {
        if (res.vendor !== vendorRef.current) return;
        setResult(res);
        setColorName("");
        setPriceMode("regular");
        if (!res.found || res.colors.length === 0) {
          toast({
            title: `Style ${res.styleQueried} not found at ${VENDOR_LABELS[res.vendor]}`,
            description:
              "Vendors sometimes use a different style number — adjust it and search again, or type the cost manually.",
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

  const found = result !== null && result.found && result.colors.length > 0;
  const selectedColor = found
    ? result.colors.find((c) => c.colorName === colorName)
    : undefined;
  const base = selectedColor ? baseSizeEntry(selectedColor) : null;
  const hasSale = base !== null && base.salePrice !== null;

  const priceFor = (mode: "regular" | "sale"): number | null => {
    if (!base) return null;
    if (mode === "sale" && base.salePrice !== null) return base.salePrice;
    return base.cost;
  };

  const pickColor = (name: string) => {
    setColorName(name);
    setPriceMode("regular");
    if (!found) return;
    const color = result.colors.find((c) => c.colorName === name);
    const entry = color ? baseSizeEntry(color) : null;
    if (name && entry === null) {
      toast({
        title: "No vendor price for this color",
        description: "Type the garment cost manually.",
        variant: "destructive",
      });
      return;
    }
    if (entry?.cost !== null && entry !== null) onApply(entry.cost as number);
  };

  const pickMode = (mode: "regular" | "sale") => {
    setPriceMode(mode);
    const p = priceFor(mode);
    if (p !== null) onApply(p);
  };

  return (
    <div className="space-y-2.5" data-testid="vendor-cost-lookup">
      <span className={`${labelCls} mb-0`}>Vendor price lookup</span>
      <div className="flex gap-2">
        <select
          value={vendor}
          onChange={(e) => {
            const next = e.target.value as "sanmar" | "ss";
            vendorRef.current = next;
            setVendor(next);
            setResult(null);
            setColorName("");
          }}
          className={`${inputCls} w-32 shrink-0`}
          aria-label="Vendor"
        >
          <option value="sanmar">SanMar</option>
          <option value="ss">S&amp;S</option>
        </select>
        <input
          type="text"
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") search();
          }}
          placeholder={`Style # at ${VENDOR_LABELS[vendor]} — e.g. PC54`}
          className={`${inputCls} font-mono`}
          aria-label="Vendor style number"
        />
        <button
          onClick={search}
          disabled={lookup.isPending || style.trim().length === 0}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-40 shrink-0"
          aria-label="Look up style"
        >
          {lookup.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Search size={13} />
          )}
        </button>
      </div>

      {result !== null && !found && (
        <p className="text-[11px] text-amber-400">
          Style {result.styleQueried} not found at{" "}
          {VENDOR_LABELS[result.vendor]} — check the style number or enter the
          cost manually.
        </p>
      )}

      {found && (
        <>
          <p className="text-[11px] text-slate-400">
            Matched:{" "}
            <span className="text-slate-200 font-medium">
              {[result.brand, result.styleName].filter(Boolean).join(" ")}
            </span>
            {result.title ? (
              <span className="text-slate-500"> — {result.title}</span>
            ) : null}
          </p>
          {result.matchType === "closest" && (
            <p className="text-[11px] text-amber-400">
              Closest match — the vendor didn't have an exact style-number
              match. Double-check this is the right product.
            </p>
          )}
          <select
            value={colorName}
            onChange={(e) => pickColor(e.target.value)}
            className={inputCls}
            aria-label="Vendor color"
          >
            <option value="">Select a color…</option>
            {result.colors.map((c) => (
              <option key={c.colorName} value={c.colorName}>
                {c.colorName}
              </option>
            ))}
          </select>

          {selectedColor && base !== null && (
            <div className="space-y-1.5">
              {hasSale ? (
                <div className="flex gap-2" role="group" aria-label="Price to use">
                  <button
                    onClick={() => pickMode("regular")}
                    className={`flex-1 text-xs font-semibold px-3 py-2 rounded-lg border transition-colors ${
                      priceMode === "regular"
                        ? "bg-[#059669]/10 border-[#059669]/40 text-[#10b981]"
                        : "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700"
                    }`}
                  >
                    Regular ${money(base.cost as number)}
                  </button>
                  <button
                    onClick={() => pickMode("sale")}
                    className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border transition-colors ${
                      priceMode === "sale"
                        ? "bg-[#059669]/10 border-[#059669]/40 text-[#10b981]"
                        : "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700"
                    }`}
                  >
                    <Tag size={12} /> Sale ${money(base.salePrice as number)}
                  </button>
                </div>
              ) : (
                <p className="text-[11px] text-slate-400">
                  Applied{" "}
                  <span className="text-slate-200 font-mono">
                    ${money(base.cost as number)}
                  </span>{" "}
                  <span className="text-slate-500">
                    (base size {base.size})
                  </span>
                </p>
              )}
              {hasSale && (
                <p className="text-[11px] text-slate-500">
                  Applied{" "}
                  <span className="text-slate-300 font-mono">
                    ${money(priceFor(priceMode) as number)}
                  </span>{" "}
                  (base size {base.size})
                  {base.saleEndsAt
                    ? ` · sale ends ${formatSaleEnd(base.saleEndsAt)}`
                    : ""}{" "}
                  — you decide whether the client gets the sale price or the
                  shop keeps the margin.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
