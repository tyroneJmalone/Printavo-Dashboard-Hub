import { useState } from "react";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import {
  useVendorLookup,
  vendorLookup,
  useCreatePoFile,
  useAppendPoLineItems,
  useListPoFiles,
  getListPoFilesQueryKey,
  type VendorLookupResult,
  type PoFileLineItem,
  type PoFile,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  usePoCart,
  clearVendorResolutionIfCurrent,
  warehouseOptionsFor,
  type CartItem,
  type CartVendor,
} from "@/stores/poCart";
import { formatPrintavoCalendarDate } from "@/pages/vendorOrdersHelpers";
import {
  applyLookupColor,
  fetchMatchedInventory,
} from "./cartVendorActions";
import {
  brandsConflict,
  canAutomaticallyApplyVendorMatch,
  findReusableColorMatch,
  sanmarPoNumberTooLong,
  suggestedPoNumber,
} from "./cartMatching";
import { Link } from "wouter";
import {
  X,
  Search,
  Loader2,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  ShoppingCart,
  Save,
} from "lucide-react";

const VENDOR_LABELS: Record<CartVendor, string> = {
  sanmar: "SanMar",
  ss: "S&S Activewear",
  manual: "Manual",
};

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function apiError(err: unknown): string | undefined {
  if (!err || typeof err !== "object" || !("data" in err)) return undefined;
  const data = (err as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const value = (data as { error?: unknown; message?: unknown }).error ??
    (data as { message?: unknown }).message;
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : undefined;
}

/** True when the vendor matched a different brand than Printavo's line item. */
function brandMismatch(printavoBrand: string | null, vendorBrand: string | null): boolean {
  return brandsConflict(printavoBrand, vendorBrand);
}

function itemTotals(item: CartItem): { qty: number; cost: number; costed: boolean } {
  let qty = 0;
  let cost = 0;
  let costed = true;
  for (const s of item.sizes) {
    qty += s.qty;
    if (s.qty > 0) {
      if (s.unitCost === null) costed = false;
      else cost += s.qty * s.unitCost;
    }
  }
  return { qty, cost, costed };
}

function CartItemCard({
  item,
  lookupResult,
  onLookupResult,
}: {
  item: CartItem;
  lookupResult: VendorLookupResult | null;
  onLookupResult: (res: VendorLookupResult | null) => void;
}) {
  const removeItem = usePoCart((s) => s.removeItem);
  const setVendor = usePoCart((s) => s.setVendor);
  const setStyleNumber = usePoCart((s) => s.setStyleNumber);
  const setSizeQty = usePoCart((s) => s.setSizeQty);
  const setManualCost = usePoCart((s) => s.setManualCost);
  const matchSizeToVendor = usePoCart((s) => s.matchSizeToVendor);
  const setWarehouse = usePoCart((s) => s.setWarehouse);
  const { toast } = useToast();

  const [invPending, setInvPending] = useState(false);
  const [manualCostInput, setManualCostInput] = useState("");
  // Printavo's style number sometimes differs from the vendor's (e.g. "1000C"
  // in Printavo vs "1000" at S&S) — let the user correct it before lookup.
  const [styleInput, setStyleInput] = useState(item.styleNumber);

  // Check warehouse stock for the sizes this line actually matched, with a
  // busy indicator. Shared helper reads live cart state so it works after
  // both the initial color match AND a manual per-size remap.
  async function refetchInventory(res: VendorLookupResult, colorName: string) {
    const vendor = item.vendor;
    if (vendor !== "sanmar" && vendor !== "ss") return;
    setInvPending(true);
    try {
      await fetchMatchedInventory(item.key, vendor, res, colorName);
    } catch {
      toast({
        title: "Warehouse stock check failed",
        description:
          "You can still save the PO without a warehouse — or re-pick the color to retry.",
        variant: "destructive",
      });
    } finally {
      setInvPending(false);
    }
  }

  function applyColor(res: VendorLookupResult, colorName: string) {
    if (!applyLookupColor(item.key, res, colorName)) return;
    void refetchInventory(res, colorName);
  }

  const lookup = useVendorLookup({
    mutation: {
      onSuccess: (res) => {
        onLookupResult(res);
        if (!res.found) {
          clearVendorResolutionIfCurrent(
            item.key,
            res.vendor,
            res.styleQueried,
          );
          toast({
            title: `Style ${res.styleQueried} not found at ${VENDOR_LABELS[item.vendor as CartVendor] ?? res.vendor}`,
            description:
              "Vendors sometimes use a different style number than Printavo — edit the style and search again, or use Manual cost.",
            variant: "destructive",
          });
          return;
        }
        const colorMatch = findReusableColorMatch(
          item.color,
          res.colors.map((c) => c.colorName),
        );
        const canApply =
          colorMatch.value &&
          canAutomaticallyApplyVendorMatch(item.brand, res.brand, res.matchType);
        if (canApply) {
          applyColor(res, colorMatch.value);
        } else {
          clearVendorResolutionIfCurrent(
            item.key,
            res.vendor,
            res.styleQueried,
          );
        }
      },
      onError: (err) => {
        toast({
          title: "Vendor lookup failed",
          description: err instanceof Error ? err.message : "Vendor API unavailable",
          variant: "destructive",
        });
      },
    },
  });

  const totals = itemTotals(item);
  const canLookup = item.vendor === "sanmar" || item.vendor === "ss";
  const unmatchedSizes =
    item.resolved && item.vendor !== "manual"
      ? item.sizes.filter((s) => s.qty > 0 && s.unitCost === null)
      : [];
  // Vendor sizes for the currently-selected color — only while a fresh lookup is
  // in hand. Powers the per-size mapping dropdown for combined-size products.
  const selectedColorSizes =
    lookupResult?.found && item.vendorCatalogColor
      ? (lookupResult.colors.find((c) => c.colorName === item.vendorCatalogColor)?.sizes ?? [])
      : [];
  const automaticColorMatch =
    lookupResult?.found
      ? findReusableColorMatch(
          item.color,
          lookupResult.colors.map((c) => c.colorName),
        )
      : null;
  // Rows needing a manual size decision: unpriced (no auto-match) OR matched to a
  // COMBINED vendor size (so Tyler can verify/correct the S→S/M guess). Plain
  // exact matches are left alone to avoid inviting accidental remaps.
  const sizesToMap =
    canLookup
      ? item.sizes.filter(
          (s) => s.qty > 0 && (s.unitCost === null || (s.vendorSize?.includes("/") ?? false)),
        )
      : [];
  // Two rows pointing at one vendor unit = a double order — surface it loudly.
  const dupVendorSizes = (() => {
    const seen = new Map<string, number>();
    for (const s of item.sizes) {
      if (s.qty > 0 && s.vendorSize) seen.set(s.vendorSize, (seen.get(s.vendorSize) ?? 0) + 1);
    }
    return [...seen.entries()].filter(([, n]) => n > 1).map(([v]) => v);
  })();

  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3.5 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-mono font-bold text-sm text-white">
            {item.styleNumber}
            <span className="ml-2 text-slate-400 font-sans font-normal">
              {item.vendorCatalogColor ?? item.color ?? "—"}
            </span>
          </div>
          <div className="text-[11px] text-slate-400">
            <PrintavoOrderLink
              orderId={item.printavoOrderId}
              visualId={item.visualId}
            />{" "}
            {item.invoiceNickname ? ` · ${item.invoiceNickname}` : ""}
          </div>
          <div className="mt-0.5 text-[11px] text-slate-500">
            Prod due {formatPrintavoCalendarDate(item.productionDueAt)}
          </div>
          <div className="mt-1 text-xs text-slate-300">
            <span className="font-medium">{item.brand ?? "—"}</span>
            <span className="text-slate-500"> · {item.description ?? "No line item description"}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {item.resolved && totals.costed && (
            <CheckCircle2 size={15} className="text-[#10b981]" />
          )}
          <button
            onClick={() => removeItem(item.key)}
            className="text-slate-500 hover:text-red-400 transition-colors"
            aria-label="Remove from cart"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <select
          value={item.vendor ?? ""}
          onChange={(e) => {
            onLookupResult(null);
            setVendor(item.key, e.target.value as CartVendor);
          }}
          className="bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 flex-shrink-0"
        >
          <option value="" disabled>
            Vendor…
          </option>
          <option value="sanmar">SanMar</option>
          <option value="ss">S&amp;S Activewear</option>
          <option value="manual">Manual cost</option>
        </select>

        {canLookup && (
          <>
            <input
              value={styleInput}
              onChange={(e) => setStyleInput(e.target.value)}
              placeholder="Style #"
              aria-label="Vendor style number"
              className="w-20 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs font-mono text-slate-200"
            />
            <button
              onClick={() => {
                const style = styleInput.trim();
                if (!style) return;
                onLookupResult(null);
                if (style !== item.styleNumber) setStyleNumber(item.key, style);
                lookup.mutate({
                  data: {
                    vendor: item.vendor as "sanmar" | "ss",
                    style,
                    // Printavo brand/description disambiguate when brands
                    // share a style number (Gildan 5000 vs Bayside 5000).
                    brandHint: item.brand,
                    descriptionHint: item.description,
                  },
                });
              }}
              disabled={lookup.isPending || styleInput.trim().length === 0}
              className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded bg-slate-800 border border-slate-600 text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-50"
            >
              {lookup.isPending ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Search size={12} />
              )}
              Get pricing
            </button>
          </>
        )}

        {item.vendor === "manual" && (
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="Cost/pc"
              value={manualCostInput}
              onChange={(e) => setManualCostInput(e.target.value)}
              className="w-20 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 font-mono"
            />
            <button
              onClick={() => {
                const c = Number(manualCostInput);
                if (Number.isFinite(c) && c >= 0) setManualCost(item.key, c);
              }}
              className="text-xs font-semibold px-2.5 py-1.5 rounded bg-slate-800 border border-slate-600 text-slate-200 hover:bg-slate-700 transition-colors"
            >
              Apply
            </button>
          </div>
        )}
      </div>

      {lookupResult && lookupResult.found && (
        <div>
          <label className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">
            Vendor color{" "}
            {lookupResult.matchType === "closest" && (
              <span className="text-amber-400 normal-case font-normal">
                (closest style match: {lookupResult.styleName})
              </span>
            )}
            {automaticColorMatch?.kind === "normalized" &&
              item.vendorCatalogColor === automaticColorMatch.value && (
                <span className="text-amber-400 normal-case font-normal">
                  {" "}(closest color: {automaticColorMatch.value})
                </span>
              )}
            {automaticColorMatch?.kind === "ambiguous" && !item.vendorCatalogColor && (
              <span className="text-amber-400 normal-case font-normal">
                {" "}(similar colors found — pick manually)
              </span>
            )}
          </label>
          <div
            className={`text-[11px] mt-0.5 ${
              brandMismatch(item.brand, lookupResult.brand)
                ? "text-amber-400"
                : "text-slate-500"
            }`}
          >
            Matched:{" "}
            <span className="font-semibold">
              {[lookupResult.brand, lookupResult.styleName].filter(Boolean).join(" ") ||
                lookupResult.styleQueried}
            </span>
            {lookupResult.title ? ` — ${lookupResult.title}` : ""}
            {brandMismatch(item.brand, lookupResult.brand)
              ? ` (Printavo says ${item.brand})`
              : ""}
          </div>
          <select
            value={item.vendorCatalogColor ?? ""}
            onChange={(e) => applyColor(lookupResult, e.target.value)}
            className="mt-1 w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200"
          >
            <option value="" disabled>
              Pick the vendor color…
            </option>
            {lookupResult.colors.map((c) => (
              <option key={c.colorName} value={c.colorName}>
                {c.colorName}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {item.sizes.map((s) => (
          <div
            key={s.size}
            className="flex items-center gap-1 bg-slate-800/70 border border-slate-700 rounded px-1.5 py-1"
          >
            <span className="text-[10px] font-mono text-slate-400">{s.size}</span>
            <input
              type="number"
              min="0"
              value={s.qty}
              onChange={(e) => setSizeQty(item.key, s.size, Number(e.target.value))}
              className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] font-mono text-slate-200 text-right"
            />
            <span className="text-[10px] font-mono text-slate-500 min-w-[42px] text-right">
              {s.unitCost !== null ? money(s.unitCost) : "—"}
            </span>
          </div>
        ))}
      </div>

      {(unmatchedSizes.length > 0 ||
        (sizesToMap.length > 0 && selectedColorSizes.length > 0) ||
        dupVendorSizes.length > 0) && (
        <div className="space-y-1.5">
          {unmatchedSizes.length > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
              <AlertTriangle size={12} />
              No vendor price for: {unmatchedSizes.map((s) => s.size).join(", ")}
            </div>
          )}
          {sizesToMap.length > 0 && selectedColorSizes.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-slate-500">
                This vendor may combine sizes — pick the vendor size for each Printavo size:
              </div>
              {sizesToMap.map((s) => (
                <div key={s.size} className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono text-slate-400 w-9 flex-shrink-0">
                    {s.size}
                  </span>
                  <span className="text-slate-600 text-[10px]">→</span>
                  <select
                    value={s.vendorSize ?? ""}
                    onChange={(e) => {
                      const vs = selectedColorSizes.find((o) => o.size === e.target.value);
                      if (!vs) return;
                      matchSizeToVendor(item.key, s.size, {
                        vendorSize: vs.size,
                        unitCost: vs.salePrice ?? vs.cost,
                        sku: vs.sku,
                        inventoryKey: vs.inventoryKey,
                        sizeIndex: vs.sizeIndex,
                      });
                      if (lookupResult && item.vendorCatalogColor)
                        void refetchInventory(lookupResult, item.vendorCatalogColor);
                    }}
                    aria-label={`Vendor size for ${s.size}`}
                    className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1 text-[11px] text-slate-200"
                  >
                    <option value="" disabled>
                      Pick vendor size…
                    </option>
                    {selectedColorSizes.map((o) => {
                      const c = o.salePrice ?? o.cost;
                      return (
                        <option key={o.size} value={o.size}>
                          {o.size}
                          {c !== null ? ` — ${money(c)}` : ""}
                        </option>
                      );
                    })}
                  </select>
                </div>
              ))}
            </div>
          )}
          {dupVendorSizes.length > 0 && (
            <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
              <AlertTriangle size={12} />
              Two sizes map to {dupVendorSizes.join(", ")} — this would double-order. Combine their
              quantities into one row and set the other to 0.
            </div>
          )}
        </div>
      )}

      {invPending && (
        <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <Loader2 size={12} className="animate-spin" />
          Checking warehouse stock…
        </div>
      )}

      {item.inventory !== null &&
        (() => {
          const options = warehouseOptionsFor(item);
          if (options.length === 0) {
            return (
              <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
                <AlertTriangle size={12} />
                No warehouse stock data for this color.
              </div>
            );
          }
          const selected = options.find((o) => o.code === item.warehouseCode);
          return (
            <div>
              <label className="text-[10px] text-slate-500 font-semibold uppercase tracking-wider">
                Ship from{" "}
                <span className="normal-case font-normal text-slate-600">
                  {item.warehouseManual ? "(manual pick)" : "(auto-picked)"}
                </span>
              </label>
              <select
                value={item.warehouseCode ?? ""}
                onChange={(e) => {
                  const code = e.target.value || null;
                  const opt = options.find((w) => w.code === code);
                  setWarehouse(item.key, code, opt?.name ?? null);
                }}
                aria-label="Ship from warehouse"
                className="mt-1 w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200"
              >
                <option value="">Auto</option>
                {options.map((w) => (
                  <option key={w.code} value={w.code}>
                    {w.name} —{" "}
                    {w.short.length === 0 ? "covers all sizes" : `short: ${w.short.join(", ")}`}{" "}
                    ({w.totalQty.toLocaleString()}{w.capped ? "+" : ""} pcs)
                  </option>
                ))}
              </select>
              {selected && selected.short.length > 0 && (
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-400">
                  <AlertTriangle size={12} />
                  {selected.name} is short on: {selected.short.join(", ")}
                </div>
              )}
              {!selected && item.warehouseCode === null && (
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-amber-400">
                  <AlertTriangle size={12} />
                  No single warehouse covers this line — pick one manually.
                </div>
              )}
            </div>
          );
        })()}

      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">{totals.qty} pcs</span>
        <span className="font-mono font-bold text-[#10b981]">
          {totals.costed && item.resolved ? money(totals.cost) : "— needs pricing"}
        </span>
      </div>
    </div>
  );
}

export function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const items = usePoCart((s) => s.items);
  const removeItem = usePoCart((s) => s.removeItem);
  const clearCart = usePoCart((s) => s.clear);
  const setVendorAll = usePoCart((s) => s.setVendorAll);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [poNumbers, setPoNumbers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  // Per-vendor save target: "new" (default) or an existing PO id to append to.
  const [targets, setTargets] = useState<Record<string, string>>({});
  // Lookup results live here (not in each card) so the cart-wide "Get pricing"
  // can populate them and the cards' color/size dropdowns still work.
  const [lookupResults, setLookupResults] = useState<Record<string, VendorLookupResult>>({});
  // Non-null while bulk pricing runs.
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);

  const createPo = useCreatePoFile();
  const appendLines = useAppendPoLineItems();
  const { data: poData } = useListPoFiles();

  if (!open) return null;

  const setItemLookup = (key: string, res: VendorLookupResult | null) =>
    setLookupResults((prev) => {
      const next = { ...prev };
      if (res) next[key] = res;
      else delete next[key];
      return next;
    });

  function handleVendorAll(vendor: CartVendor) {
    // Lookup results for items switching vendors are stale — drop them.
    // (Items already on this vendor keep their results and pricing.)
    const changed = items.filter((i) => i.vendor !== vendor).map((i) => i.key);
    setVendorAll(vendor);
    if (changed.length > 0)
      setLookupResults((prev) => {
        const next = { ...prev };
        for (const k of changed) delete next[k];
        return next;
      });
  }

  function handleEmptyCart() {
    if (items.length === 0 || bulk !== null || saving) return;
    if (
      !window.confirm(
        "Empty this unsaved cart? This only removes the current cart items and does not delete any saved POs.",
      )
    ) {
      return;
    }
    // Cart state and all drawer-only state must be cleared together. In
    // particular, stale lookup results must not be available if another line
    // with the same key is added later.
    clearCart();
    setLookupResults({});
    setPoNumbers({});
    setTargets({});
    setNotes("");
  }

  /** Price one line: lookup → auto-apply an exact or unique high-confidence
   *  color match → stock check. Moderate/ambiguous matches stay manual. */
  async function priceOneItem(i: CartItem): Promise<{ priced: boolean; note: string | null }> {
    const vendor = i.vendor as "sanmar" | "ss";
    let res: VendorLookupResult;
    try {
      res = await vendorLookup({
        vendor,
        style: i.styleNumber,
        // Printavo brand/description disambiguate when brands share a style
        // number (Gildan 5000 vs Bayside 5000).
        brandHint: i.brand,
        descriptionHint: i.description,
      });
    } catch (err) {
      const detail = apiError(err);
      return {
        priced: false,
        note: `${i.styleNumber}: lookup failed${detail ? ` — ${detail}` : ""}`,
      };
    }
    setItemLookup(i.key, res);
    // Validate response freshness before either applying it OR clearing an old
    // resolution. A late rejected response must not wipe newer user work.
    const live = usePoCart.getState().items.find((x) => x.key === i.key);
    if (!live || live.vendor !== vendor || live.styleNumber !== i.styleNumber) {
      return { priced: false, note: live ? `${i.styleNumber}: changed during pricing — re-run` : null };
    }
    if (!res.found) {
      clearVendorResolutionIfCurrent(i.key, vendor, i.styleNumber);
      return { priced: false, note: `${i.styleNumber}: not found at ${VENDOR_LABELS[vendor]}` };
    }
    if (brandsConflict(i.brand, res.brand)) {
      clearVendorResolutionIfCurrent(i.key, vendor, i.styleNumber);
      return {
        priced: false,
        note: `${i.styleNumber}: brand mismatch (${i.brand ?? "Printavo"} vs ${res.brand ?? "vendor"}) — pick manually`,
      };
    }
    if (res.matchType !== "exact") {
      clearVendorResolutionIfCurrent(i.key, vendor, i.styleNumber);
      return {
        priced: false,
        note: `${i.styleNumber}: closest match (${res.styleName ?? res.styleQueried}) — pick manually`,
      };
    }
    const colorMatch = findReusableColorMatch(
      i.color,
      res.colors.map((c) => c.colorName),
    );
    if (!colorMatch.value) {
      clearVendorResolutionIfCurrent(i.key, vendor, i.styleNumber);
      return { priced: false, note: `${i.styleNumber}: pick the vendor color` };
    }
    applyLookupColor(i.key, res, colorMatch.value);
    let stockFailed = false;
    try {
      await fetchMatchedInventory(i.key, vendor, res, colorMatch.value);
    } catch {
      // Non-fatal — the card still lets Tyler save or re-pick the color to retry.
      stockFailed = true;
    }
    const cur = usePoCart.getState().items.find((x) => x.key === i.key);
    const unpriced = cur?.sizes.filter((s) => s.qty > 0 && s.unitCost === null) ?? [];
    const flags: string[] = [];
    if (unpriced.length > 0) {
      flags.push(
        `map size${unpriced.length === 1 ? "" : "s"} ${unpriced.map((s) => s.size).join(", ")}`,
      );
    }
    if (colorMatch.kind === "normalized") {
      flags.push(`closest color (${colorMatch.value}) — double-check`);
    }
    if (stockFailed) {
      flags.push("stock check failed — no warehouse picked");
    }
    return { priced: true, note: flags.length > 0 ? `${i.styleNumber}: ${flags.join("; ")}` : null };
  }

  async function handlePriceAll() {
    // Skip lines already fully priced — re-running would clobber hand-mapped
    // sizes and hand-picked warehouses.
    const eligible = items.filter(
      (i) =>
        (i.vendor === "sanmar" || i.vendor === "ss") &&
        !(i.resolved && itemTotals(i).costed),
    );
    const noVendor = items.filter((i) => !i.vendor).length;
    if (eligible.length === 0) {
      toast({
        title: "Nothing to price",
        description:
          noVendor > 0
            ? `${noVendor} item${noVendor === 1 ? " has" : "s have"} no vendor yet — set a vendor first.`
            : "Every vendor item already has pricing.",
      });
      return;
    }
    setBulk({ done: 0, total: eligible.length });
    let priced = 0;
    const attention: string[] = [];
    // Two at a time: fast for S&S, gentle on SanMar's slow SOAP lookups.
    const queue = [...eligible];
    const worker = async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        const r = await priceOneItem(next);
        if (r.priced) priced++;
        if (r.note) attention.push(r.note);
        setBulk((b) => (b ? { ...b, done: b.done + 1 } : b));
      }
    };
    await Promise.all(Array.from({ length: Math.min(2, queue.length) }, () => worker()));
    setBulk(null);
    const skipped =
      noVendor > 0 ? ` · ${noVendor} item${noVendor === 1 ? "" : "s"} with no vendor skipped` : "";
    if (attention.length === 0) {
      toast({
        title: `Priced ${priced} item${priced === 1 ? "" : "s"}`,
        description: `All colors matched automatically.${skipped}`,
      });
    } else {
      toast({
        title: `Priced ${priced} of ${eligible.length} — review needed`,
        description: attention.join(" · ") + skipped,
        variant: priced < eligible.length ? "destructive" : undefined,
      });
    }
  }

  const openPosForVendor = (vendor: CartVendor): PoFile[] =>
    (poData?.poFiles ?? []).filter((p) => p.vendorName === vendor && !p.locked);

  const targetFor = (vendor: CartVendor): string => targets[vendor] ?? "new";

  const allReady =
    items.length > 0 &&
    items.every((i) => {
      if (!i.vendor || !i.resolved) return false;
      const t = itemTotals(i);
      return t.qty > 0 && t.costed;
    });

  const grandTotals = items.reduce(
    (acc, i) => {
      const t = itemTotals(i);
      acc.qty += t.qty;
      if (t.costed && i.resolved) acc.cost += t.cost;
      return acc;
    },
    { qty: 0, cost: 0 },
  );

  const vendorGroups = new Map<CartVendor, CartItem[]>();
  for (const i of items) {
    if (!i.vendor) continue;
    const g = vendorGroups.get(i.vendor) ?? [];
    g.push(i);
    vendorGroups.set(i.vendor, g);
  }

  const newPoGroups = [...vendorGroups.keys()].filter((v) => targetFor(v) === "new");
  const needsPoNumber = newPoGroups.length > 0;
  const poNumberFor = (vendor: CartVendor): string => poNumbers[vendor] ?? "";
  const generatedPoNumberFor = (vendor: CartVendor): string =>
    suggestedPoNumber(items.filter((item) => item.vendor === vendor));
  const allNewPoNumbersReady = newPoGroups.every(
    (vendor) => poNumberFor(vendor).trim().length > 0,
  );
  const duplicateNewPoNumbers = (() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const vendor of newPoGroups) {
      const number = poNumberFor(vendor).trim();
      if (!number) continue;
      const key = number.toLocaleLowerCase();
      if (seen.has(key)) duplicates.add(number);
      seen.add(key);
    }
    return [...duplicates];
  })();
  const sanmarPoNumberInvalid =
    newPoGroups.includes("sanmar") && sanmarPoNumberTooLong(poNumberFor("sanmar"));

  async function handleSave() {
    if (!allReady || !allNewPoNumbersReady) return;
    if (sanmarPoNumberInvalid) {
      toast({
        title: "SanMar PO number is too long",
        description: "SanMar allows 12 characters maximum. Shorten the displayed PO number before saving.",
        variant: "destructive",
      });
      return;
    }
    // Validate the whole batch before the first create request. Otherwise two
    // vendor POs for the same invoice could partially save with one PO number.
    if (duplicateNewPoNumbers.length > 0) {
      toast({
        title: "New POs need different numbers",
        description: `Edit one of the duplicate PO numbers: ${duplicateNewPoNumbers.join(", ")}.`,
        variant: "destructive",
      });
      return;
    }
    setSaving(true);
    const saved: string[] = [];
    const appended: string[] = [];
    let failed: string | null = null;
    for (const [vendor, groupItems] of vendorGroups) {
      try {
        const lineItems: PoFileLineItem[] = groupItems.map((i) => ({
          printavoLineItemId: i.printavoLineItemId,
          printavoOrderId: i.printavoOrderId,
          visualId: i.visualId,
          // Persist the actual vendor identifier used for pricing/inventory so
          // later submission cannot send Printavo's non-literal alias.
          styleNumber: i.vendorStyleNumber ?? i.styleNumber,
          color: i.color,
          vendorCatalogColor: i.vendorCatalogColor,
          description: i.description,
          brand: i.brand,
          source: vendor === "manual" ? "manual" : "vendor",
          warehouseCode: i.warehouseCode,
          warehouseName: i.warehouseName,
          sizes: i.sizes
            .filter((s) => s.qty > 0)
            .map((s) => ({
              size: s.size,
              qty: s.qty,
              unitCost: s.unitCost ?? 0,
              sku: s.sku,
              inventoryKey: s.inventoryKey,
              sizeIndex: s.sizeIndex,
              vendorSize: s.vendorSize,
            })),
        }));
        const target = targetFor(vendor);
        if (target === "new") {
          // Save exactly what is displayed for this vendor's PO. Never derive
          // a hidden suffix from another vendor's invoices.
          const num = poNumberFor(vendor).trim();
          await createPo.mutateAsync({
            data: {
              poNumber: num,
              vendorName: vendor,
              notes: notes.trim() ? notes.trim() : null,
              lineItems,
            },
          });
          saved.push(num);
        } else {
          const po = await appendLines.mutateAsync({
            id: target,
            data: { lineItems },
          });
          appended.push(po.poNumber);
        }
        // Drop saved items immediately so a retry after a later failure
        // can never create duplicate POs for this vendor group.
        for (const i of groupItems) removeItem(i.key);
      } catch (err) {
        const apiMsg =
          err && typeof err === "object" && "data" in err
            ? (err as { data?: { error?: string } }).data?.error
            : undefined;
        failed = apiMsg ?? "Vendor group failed to save";
        break;
      }
    }
    if (saved.length > 0 || appended.length > 0) {
      queryClient.invalidateQueries({ queryKey: getListPoFilesQueryKey() });
      const parts: string[] = [];
      if (saved.length > 0)
        parts.push(`Saved ${saved.length} new PO${saved.length > 1 ? "s" : ""}: ${saved.join(", ")}`);
      if (appended.length > 0)
        parts.push(`Added items to PO${appended.length > 1 ? "s" : ""} ${appended.join(", ")}`);
      toast({ title: parts.join(" · "), description: "Find them in the PO Log." });
    }
    if (failed) {
      toast({
        title: "Failed to save PO",
        description: `${failed}. Items already saved were removed from the cart — fix and save the rest.`,
        variant: "destructive",
      });
    } else {
      setPoNumbers({});
      setNotes("");
      setTargets({});
      onClose();
    }
    setSaving(false);
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-[440px] max-w-full bg-[#0f172a] border-l border-slate-800 z-50 flex flex-col shadow-2xl">
        <div className="flex-shrink-0 px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <h2 className="text-base font-bold text-white flex items-center gap-2">
            <ShoppingCart size={18} className="text-[#10b981]" />
            PO Cart
            <span className="text-xs font-mono font-normal text-slate-400">
              {items.length} item{items.length === 1 ? "" : "s"}
            </span>
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors" aria-label="Close cart">
            <X size={18} />
          </button>
        </div>

        {items.length > 0 && (
          <div className="flex-shrink-0 px-4 pt-3 flex items-center gap-2">
            <select
              value=""
              onChange={(e) => {
                const v = e.target.value as CartVendor | "";
                if (v) handleVendorAll(v);
              }}
              disabled={bulk !== null}
              aria-label="Set vendor for all items"
              className="bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200 flex-shrink-0 disabled:opacity-50"
            >
              <option value="">Vendor for all…</option>
              <option value="sanmar">SanMar</option>
              <option value="ss">S&amp;S Activewear</option>
              <option value="manual">Manual cost</option>
            </select>
            <button
              onClick={handlePriceAll}
              disabled={bulk !== null}
              className="flex-1 flex items-center justify-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded bg-slate-800 border border-slate-600 text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-50"
            >
              {bulk ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Search size={12} />
              )}
              {bulk ? `Pricing ${bulk.done}/${bulk.total}…` : "Get pricing — all items"}
            </button>
            <button
              type="button"
              onClick={handleEmptyCart}
              disabled={bulk !== null || saving}
              className="flex items-center justify-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded bg-slate-800 border border-slate-600 text-red-300 hover:bg-red-950/50 hover:border-red-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Trash2 size={12} />
              Empty Cart
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-500">
              <ShoppingCart size={32} className="mb-2 opacity-50" />
              <div className="text-sm">Cart is empty</div>
              <div className="text-xs mt-1">Add line items from the list.</div>
            </div>
          ) : (
            items.map((item) => (
              <CartItemCard
                key={item.key}
                item={item}
                lookupResult={lookupResults[item.key] ?? null}
                onLookupResult={(res) => setItemLookup(item.key, res)}
              />
            ))
          )}
        </div>

        {items.length > 0 && (
          <div className="flex-shrink-0 border-t border-slate-800 p-4 space-y-3 bg-slate-900/60">
            {vendorGroups.size > 1 && (
              <div className="text-[11px] text-slate-400">
                {vendorGroups.size} vendors in cart — each saves to its own PO.
              </div>
            )}
            {[...vendorGroups.keys()].map((vendor) => {
              const existing = openPosForVendor(vendor);
              if (existing.length === 0) return null;
              return (
                <div key={vendor} className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-slate-400 w-28 flex-shrink-0">
                    {VENDOR_LABELS[vendor]} items →
                  </span>
                  <select
                    value={targetFor(vendor)}
                    onChange={(e) =>
                      setTargets((t) => ({ ...t, [vendor]: e.target.value }))
                    }
                    aria-label={`Destination for ${VENDOR_LABELS[vendor]} items`}
                    className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200"
                  >
                    <option value="new">Create new PO</option>
                    {existing.map((p) => (
                      <option key={p.id} value={p.id}>
                        Add to PO {p.poNumber} ({p.lineItems.length} line
                        {p.lineItems.length === 1 ? "" : "s"})
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
            {newPoGroups.map((vendor) => {
              const generated = generatedPoNumberFor(vendor);
              const entered = poNumberFor(vendor);
              return (
                <div key={`number-${vendor}`} className="flex items-center gap-2">
                  <span className="w-28 flex-shrink-0 text-[11px] font-semibold text-slate-400">
                    {VENDOR_LABELS[vendor]} PO #
                  </span>
                  <input
                    value={entered}
                    onChange={(e) =>
                      setPoNumbers((current) => ({ ...current, [vendor]: e.target.value }))
                    }
                    placeholder="PO number"
                    className="min-w-0 flex-1 bg-slate-800 border border-slate-600 rounded px-2.5 py-2 text-sm font-mono text-white"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (!entered && generated) {
                        setPoNumbers((current) => ({ ...current, [vendor]: generated }));
                      }
                    }}
                    disabled={entered.length > 0 || generated.length === 0}
                    className="px-2 py-1 rounded bg-slate-800 border border-slate-600 text-[10px] font-semibold text-slate-300 hover:bg-slate-700 disabled:opacity-40"
                  >
                    Generate PO Number
                  </button>
                </div>
              );
            })}
            {duplicateNewPoNumbers.length > 0 && (
              <div className="text-[11px] text-amber-400 flex items-center gap-1.5">
                <AlertTriangle size={12} />
                New vendor POs cannot share a PO number. Edit one before saving.
              </div>
            )}
            {sanmarPoNumberInvalid && (
              <div className="text-[11px] text-amber-400 flex items-center gap-1.5">
                <AlertTriangle size={12} />
                SanMar allows 12 characters maximum. Shorten its PO number before saving.
              </div>
            )}
            {!needsPoNumber && (
              <div className="text-xs text-slate-400">
                All items will be added to existing POs.
              </div>
            )}
            <div className="flex justify-end">
              <div className="text-right">
                <div className="text-[10px] text-slate-500 uppercase font-semibold">Total</div>
                <div className="font-mono font-bold text-[#10b981]">
                  {money(grandTotals.cost)}
                </div>
              </div>
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes (optional)"
              rows={2}
              className="w-full bg-slate-800 border border-slate-600 rounded px-2.5 py-2 text-xs text-slate-200"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleSave}
                disabled={
                  !allReady ||
                  !allNewPoNumbersReady ||
                  duplicateNewPoNumbers.length > 0 ||
                  sanmarPoNumberInvalid ||
                  saving ||
                  bulk !== null
                }
                className="flex-1 flex items-center justify-center gap-2 text-sm font-bold px-4 py-2.5 rounded-lg bg-[#059669] text-white hover:bg-[#047857] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
                {needsPoNumber ? `Save PO${newPoGroups.length > 1 ? "s" : ""}` : "Add to PO"}
              </button>
              <Link
                href="/po-log"
                className="text-xs font-semibold px-3 py-2.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
              >
                PO Log
              </Link>
            </div>
            {!allReady && (
              <div className="text-[11px] text-amber-400 flex items-center gap-1.5">
                <AlertTriangle size={12} />
                Every item needs a vendor, pricing, and at least one piece before saving.
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
