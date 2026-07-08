import { useState } from "react";
import {
  useVendorLookup,
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
  type CartItem,
  type CartVendor,
} from "@/stores/poCart";
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

function CartItemCard({ item }: { item: CartItem }) {
  const removeItem = usePoCart((s) => s.removeItem);
  const setVendor = usePoCart((s) => s.setVendor);
  const setStyleNumber = usePoCart((s) => s.setStyleNumber);
  const setSizeQty = usePoCart((s) => s.setSizeQty);
  const setManualCost = usePoCart((s) => s.setManualCost);
  const applyVendorData = usePoCart((s) => s.applyVendorData);
  const { toast } = useToast();

  const [lookupResult, setLookupResult] = useState<VendorLookupResult | null>(null);
  const [manualCostInput, setManualCostInput] = useState("");
  // Printavo's style number sometimes differs from the vendor's (e.g. "1000C"
  // in Printavo vs "1000" at S&S) — let the user correct it before lookup.
  const [styleInput, setStyleInput] = useState(item.styleNumber);

  const lookup = useVendorLookup({
    mutation: {
      onSuccess: (res) => {
        setLookupResult(res);
        if (!res.found) {
          toast({
            title: `Style ${res.styleQueried} not found at ${VENDOR_LABELS[item.vendor as CartVendor] ?? res.vendor}`,
            description:
              "Vendors sometimes use a different style number than Printavo — edit the style and search again, or use Manual cost.",
            variant: "destructive",
          });
          return;
        }
        // Auto-pick the vendor color if it matches the Printavo color exactly.
        const printavoColor = (item.color ?? "").trim().toLowerCase();
        const exact = res.colors.find(
          (c) => c.colorName.trim().toLowerCase() === printavoColor,
        );
        if (exact) {
          applyColor(res, exact.colorName);
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

  function applyColor(res: VendorLookupResult, colorName: string) {
    const color = res.colors.find((c) => c.colorName === colorName);
    if (!color) return;
    applyVendorData(item.key, {
      vendorCatalogColor: color.colorName,
      sizes: color.sizes.map((s) => ({
        size: s.size,
        unitCost: s.salePrice ?? s.cost,
        sku: s.sku,
        inventoryKey: s.inventoryKey,
        sizeIndex: s.sizeIndex,
      })),
    });
  }

  const totals = itemTotals(item);
  const canLookup = item.vendor === "sanmar" || item.vendor === "ss";
  const unmatchedSizes =
    item.resolved && item.vendor !== "manual"
      ? item.sizes.filter((s) => s.qty > 0 && s.unitCost === null)
      : [];

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
          <div className="text-[11px] text-slate-500">
            #{item.visualId} · {item.brand ?? "—"}
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
            setLookupResult(null);
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
                setLookupResult(null);
                if (style !== item.styleNumber) setStyleNumber(item.key, style);
                lookup.mutate({
                  data: { vendor: item.vendor as "sanmar" | "ss", style },
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
          </label>
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

      {unmatchedSizes.length > 0 && (
        <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
          <AlertTriangle size={12} />
          No vendor price for: {unmatchedSizes.map((s) => s.size).join(", ")}
        </div>
      )}

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
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [poNumber, setPoNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  // Per-vendor save target: "new" (default) or an existing PO id to append to.
  const [targets, setTargets] = useState<Record<string, string>>({});

  const createPo = useCreatePoFile();
  const appendLines = useAppendPoLineItems();
  const { data: poData } = useListPoFiles();

  if (!open) return null;

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

  async function handleSave() {
    if (!allReady || (needsPoNumber && poNumber.trim().length === 0)) return;
    setSaving(true);
    const suffixes: Record<CartVendor, string> = { sanmar: "SM", ss: "SS", manual: "M" };
    const multi = newPoGroups.length > 1;
    const saved: string[] = [];
    const appended: string[] = [];
    let failed: string | null = null;
    for (const [vendor, groupItems] of vendorGroups) {
      try {
        const lineItems: PoFileLineItem[] = groupItems.map((i) => ({
          printavoLineItemId: i.printavoLineItemId,
          printavoOrderId: i.printavoOrderId,
          visualId: i.visualId,
          styleNumber: i.styleNumber,
          color: i.color,
          vendorCatalogColor: i.vendorCatalogColor,
          description: i.description,
          brand: i.brand,
          source: vendor === "manual" ? "manual" : "vendor",
          sizes: i.sizes
            .filter((s) => s.qty > 0)
            .map((s) => ({
              size: s.size,
              qty: s.qty,
              unitCost: s.unitCost ?? 0,
              sku: s.sku,
              inventoryKey: s.inventoryKey,
              sizeIndex: s.sizeIndex,
            })),
        }));
        const target = targetFor(vendor);
        if (target === "new") {
          const num = multi ? `${poNumber.trim()}-${suffixes[vendor]}` : poNumber.trim();
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
      setPoNumber("");
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

        <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
          {items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-slate-500">
              <ShoppingCart size={32} className="mb-2 opacity-50" />
              <div className="text-sm">Cart is empty</div>
              <div className="text-xs mt-1">Add line items from the list.</div>
            </div>
          ) : (
            items.map((item) => <CartItemCard key={item.key} item={item} />)
          )}
        </div>

        {items.length > 0 && (
          <div className="flex-shrink-0 border-t border-slate-800 p-4 space-y-3 bg-slate-900/60">
            {vendorGroups.size > 1 && (
              <div className="text-[11px] text-slate-400">
                {vendorGroups.size} vendors in cart — each saves to its own PO
                {newPoGroups.length > 1 ? " (suffixes added to new PO numbers)" : ""}.
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
            <div className="flex gap-2">
              {needsPoNumber ? (
                <input
                  value={poNumber}
                  onChange={(e) => setPoNumber(e.target.value)}
                  placeholder="PO number"
                  className="flex-1 bg-slate-800 border border-slate-600 rounded px-2.5 py-2 text-sm font-mono text-white"
                />
              ) : (
                <div className="flex-1 flex items-center text-xs text-slate-400">
                  All items will be added to existing POs.
                </div>
              )}
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
                disabled={!allReady || (needsPoNumber && poNumber.trim().length === 0) || saving}
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
