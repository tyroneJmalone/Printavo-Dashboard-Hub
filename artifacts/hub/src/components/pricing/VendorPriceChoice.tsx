export type VendorPriceMode = "regular" | "sale";

export interface VendorPriceSelection {
  cost: number;
  style: string;
  color: string;
  brand: string;
  description: string;
  vendor: "sanmar" | "ss";
  baseSize: string;
  regularPrice: number;
  salePrice: number | null;
  saleEndsAt: string | null;
  priceMode: VendorPriceMode;
}

export function VendorPriceChoice({
  selection,
  mode,
  onChange,
}: {
  selection: VendorPriceSelection;
  mode: VendorPriceMode | null;
  onChange: (mode: VendorPriceMode) => void;
}) {
  return (
    <div className="mt-3 space-y-2" data-testid="calculator-vendor-pricing">
      <p className="text-[10px] text-slate-400">
        {selection.vendor === "sanmar" ? "SanMar" : "S&S Activewear"}
        {" · "}{selection.style}{" · "}{selection.color}
        {" · base size "}{selection.baseSize}
      </p>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Calculator garment price">
        {(["regular", "sale"] as const).map((choice) => {
          const price = choice === "regular" ? selection.regularPrice : selection.salePrice;
          return (
            <button
              key={choice}
              type="button"
              aria-pressed={mode === choice}
              disabled={price === null}
              onClick={() => onChange(choice)}
              data-testid={`calculator-price-${choice}`}
              className={`text-xs font-semibold px-2 py-2 rounded-lg border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                mode === choice
                  ? "bg-[#059669]/10 border-[#059669]/40 text-[#10b981]"
                  : "bg-slate-800 border-slate-700 text-slate-400 hover:bg-slate-700"
              }`}
            >
              {choice === "regular" ? "Regular" : "Sale"}
              {price === null ? " unavailable" : ` $${price.toFixed(2)}`}
            </button>
          );
        })}
      </div>
      <p className="text-[10px] text-slate-500">
        {mode === null ? "Manual cost — choose a vendor price to restore it. " : ""}
        Prices from your lookup.
        {selection.salePrice !== null && selection.saleEndsAt
          ? ` Sale ends ${selection.saleEndsAt.split("T")[0]}.`
          : ""}
      </p>
    </div>
  );
}
