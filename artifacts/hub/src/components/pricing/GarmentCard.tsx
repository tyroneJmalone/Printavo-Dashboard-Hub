import { Trash2, X } from "lucide-react";
import { VendorCostLookup } from "./VendorCostLookup";
import { VendorPriceChoice } from "./VendorPriceChoice";
import {
  SIZE_COLUMNS,
  garmentCost,
  garmentLabel,
  sizeQty,
  sizesValid,
  type GarmentRow,
  type PricingMode,
} from "./calcMulti";

const inputCls =
  "w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669]";
const labelCls =
  "block text-[10px] font-bold uppercase tracking-wider text-slate-500 mb-1.5";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip the brand prefix and trailing style number from vendor titles. */
export function cleanProductDescription(p: { brand: string; style: string; description: string }): string {
  let description = p.description.trim();
  if (!description) return "";
  if (p.brand.trim()) {
    description = description.replace(new RegExp(`^${escapeRegExp(p.brand.trim())}\\s*[-–—.:]*\\s*`, "i"), "");
  }
  if (p.style.trim()) {
    description = description.replace(
      new RegExp(`\\s*[.·|\\-–—:]*\\s*${escapeRegExp(p.style.trim())}\\s*$`, "i"),
      "",
    );
  }
  return description.trim() || p.description.trim();
}

export function GarmentCard({
  row,
  index,
  mode,
  markup,
  markupValid,
  canRemove,
  categories,
  onChange,
  onRemove,
}: {
  row: GarmentRow;
  index: number;
  mode: PricingMode;
  markup: number;
  markupValid: boolean;
  canRemove: boolean;
  categories: Array<{ id: string; name: string }>;
  onChange: (patch: Partial<GarmentRow>) => void;
  onRemove: () => void;
}) {
  const cost = garmentCost(row);
  const costInvalid = row.costStr.trim() !== "" && cost === null;
  const qty = sizeQty(row);

  return (
    <div
      className="border border-slate-800 rounded-lg p-3 space-y-3 bg-slate-950/30"
      data-testid={`garment-card-${index}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-slate-300 truncate" data-testid={`text-garment-label-${index}`}>
          <span className="text-slate-500 font-mono mr-1.5">{String(index + 1).padStart(2, "0")}</span>
          {garmentLabel(row, index)}
        </span>
        {canRemove && (
          <button
            onClick={onRemove}
            className="text-slate-500 hover:text-red-400 transition-colors shrink-0"
            aria-label={`Remove style ${index + 1}`}
            data-testid={`button-remove-garment-${index}`}
          >
            <Trash2 size={13} />
          </button>
        )}
      </div>

      <VendorCostLookup
        onApply={(selection) =>
          onChange({
            vendorSelection: selection,
            vendorMode: selection.priceMode,
            costStr: selection.cost.toFixed(2),
            style: selection.style,
            color: selection.color,
            brand: selection.brand,
            description: cleanProductDescription(selection),
          })
        }
      />

      <div>
        <label className={labelCls} htmlFor={`garment-cost-${row.id}`}>
          Garment cost (per piece)
        </label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">$</span>
          <input
            id={`garment-cost-${row.id}`}
            type="text"
            inputMode="decimal"
            value={row.costStr}
            onChange={(e) => onChange({ costStr: e.target.value, vendorMode: null })}
            placeholder="0.00"
            className={`${inputCls} pl-6 font-mono`}
            data-testid={`input-garment-cost-${index}`}
          />
        </div>
        {row.vendorSelection && (
          <VendorPriceChoice
            selection={row.vendorSelection}
            mode={row.vendorMode}
            onChange={(m) => {
              const sel = row.vendorSelection!;
              const price = m === "sale" ? sel.salePrice : sel.regularPrice;
              if (price === null) return;
              onChange({ costStr: price.toFixed(2), vendorMode: m });
            }}
          />
        )}
        {row.vendorSelection && (
          <button
            onClick={() => onChange({ vendorSelection: null, vendorMode: null })}
            className="mt-1 inline-flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300"
            data-testid={`button-clear-vendor-${index}`}
          >
            <X size={10} /> Clear vendor pricing
          </button>
        )}
        {costInvalid && (
          <p className="text-[11px] text-amber-400 mt-1">Enter a valid garment cost (0 or more).</p>
        )}
        {cost !== null && markupValid && cost > 0 && (
          <p className="text-[11px] text-slate-500 mt-1.5">
            ${cost.toFixed(2)} × {markup} ={" "}
            <span className="text-slate-300 font-mono">${(cost * markup).toFixed(2)}</span> before decoration
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls}>Style #</label>
          <input value={row.style} onChange={(e) => onChange({ style: e.target.value.slice(0, 100) })} className={inputCls} data-testid={`input-garment-style-${index}`} />
        </div>
        <div>
          <label className={labelCls}>Color</label>
          <input value={row.color} onChange={(e) => onChange({ color: e.target.value.slice(0, 100) })} className={inputCls} data-testid={`input-garment-color-${index}`} />
        </div>
        <div>
          <label className={labelCls}>Brand</label>
          <input value={row.brand} onChange={(e) => onChange({ brand: e.target.value.slice(0, 120) })} className={inputCls} data-testid={`input-garment-brand-${index}`} />
        </div>
        <div>
          <label className={labelCls}>Printavo category</label>
          <select value={row.categoryId} onChange={(e) => onChange({ categoryId: e.target.value })} className={inputCls} data-testid={`select-garment-category-${index}`}>
            <option value="">Select…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className="col-span-2">
          <label className={labelCls}>Description</label>
          <input value={row.description} onChange={(e) => onChange({ description: e.target.value.slice(0, 500) })} className={inputCls} data-testid={`input-garment-description-${index}`} />
        </div>
      </div>

      {mode === "mixed" && (
        <div>
          <div className="flex items-baseline justify-between">
            <span className={labelCls}>Size breakdown</span>
            <span className="text-[10px] font-mono text-slate-400" data-testid={`text-garment-qty-${index}`}>
              {qty} pcs
            </span>
          </div>
          <div className="grid grid-cols-9 gap-1">
            {SIZE_COLUMNS.map((size) => (
              <label key={size} className="flex flex-col items-center gap-1">
                <span className="text-[9px] font-bold text-slate-500">{size}</span>
                <input
                  value={row.sizes[size] ?? ""}
                  onChange={(e) =>
                    onChange({ sizes: { ...row.sizes, [size]: e.target.value.replace(/[^\d]/g, "").slice(0, 5) } })
                  }
                  inputMode="numeric"
                  className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-[11px] rounded-md px-1 py-1.5 text-center font-mono focus:outline-none focus:border-[#059669]"
                  aria-label={`${garmentLabel(row, index)} ${size} quantity`}
                  data-testid={`input-size-${index}-${size}`}
                />
              </label>
            ))}
          </div>
          {!sizesValid(row) && <p className="text-[11px] text-amber-400 mt-1">Whole numbers only.</p>}
        </div>
      )}
    </div>
  );
}
