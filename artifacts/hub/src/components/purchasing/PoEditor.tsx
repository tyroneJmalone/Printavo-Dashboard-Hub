import { useState } from "react";
import {
  useUpdatePoFile,
  useDeletePoFile,
  useVendorLookup,
  getListPoFilesQueryKey,
  type PoFile,
  type PoFileLineItem,
  type VendorLookupResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Search,
  Trash2,
  Plus,
  Check,
  X,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";

const VENDOR_LABELS: Record<string, string> = {
  sanmar: "SanMar",
  ss: "S&S Activewear",
  manual: "Manual",
};

function money(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function lineQty(li: PoFileLineItem): number {
  return li.sizes.reduce((a, s) => a + s.qty, 0);
}

interface DraftSize {
  size: string;
  qty: number;
  unitCost: number | null;
  sku: string | null;
  inventoryKey: string | null;
  sizeIndex: number | null;
}

/** Vendor-search add-item form (for sanmar / ss POs). */
function VendorAddForm({
  vendor,
  onAdd,
}: {
  vendor: "sanmar" | "ss";
  onAdd: (line: PoFileLineItem) => void;
}) {
  const { toast } = useToast();
  const [style, setStyle] = useState("");
  const [result, setResult] = useState<VendorLookupResult | null>(null);
  const [colorName, setColorName] = useState("");
  const [draftSizes, setDraftSizes] = useState<DraftSize[]>([]);

  const lookup = useVendorLookup({
    mutation: {
      onSuccess: (res) => {
        setResult(res);
        setColorName("");
        setDraftSizes([]);
        if (!res.found) {
          toast({
            title: `Style ${res.styleQueried} not found at ${VENDOR_LABELS[vendor]}`,
            description:
              "Vendors sometimes use a different style number than Printavo — try a variation (e.g. 1000 instead of 1000C).",
            variant: "destructive",
          });
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

  function pickColor(name: string) {
    if (!result) return;
    const color = result.colors.find((c) => c.colorName === name);
    if (!color) return;
    setColorName(name);
    setDraftSizes(
      color.sizes.map((s) => ({
        size: s.size,
        qty: 0,
        unitCost: s.salePrice ?? s.cost,
        sku: s.sku,
        inventoryKey: s.inventoryKey,
        sizeIndex: s.sizeIndex,
      })),
    );
  }

  const totalQty = draftSizes.reduce((a, s) => a + s.qty, 0);
  const uncosted = draftSizes.filter((s) => s.qty > 0 && s.unitCost === null);
  const canAdd = totalQty > 0 && uncosted.length === 0;

  function handleAdd() {
    if (!canAdd || !result) return;
    onAdd({
      printavoLineItemId: null,
      printavoOrderId: null,
      visualId: null,
      styleNumber: result.styleQueried,
      color: null,
      vendorCatalogColor: colorName,
      description: result.title ?? result.styleName,
      brand: result.brand,
      source: "vendor",
      sizes: draftSizes
        .filter((s) => s.qty > 0)
        .map((s) => ({
          size: s.size,
          qty: s.qty,
          unitCost: s.unitCost ?? 0,
          sku: s.sku,
          inventoryKey: s.inventoryKey,
          sizeIndex: s.sizeIndex,
        })),
    });
    setStyle("");
    setResult(null);
    setColorName("");
    setDraftSizes([]);
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <input
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && style.trim())
              lookup.mutate({ data: { vendor, style: style.trim() } });
          }}
          placeholder={`Style # at ${VENDOR_LABELS[vendor]}`}
          className="w-44 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs font-mono text-slate-200"
        />
        <button
          onClick={() => lookup.mutate({ data: { vendor, style: style.trim() } })}
          disabled={lookup.isPending || style.trim().length === 0}
          className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded bg-slate-800 border border-slate-600 text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          {lookup.isPending ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Search size={12} />
          )}
          Search
        </button>
      </div>

      {result && result.found && (
        <div className="space-y-2">
          <div className="text-[11px] text-slate-400">
            {result.brand ? `${result.brand} — ` : ""}
            {result.styleName ?? result.styleQueried}
            {result.matchType === "closest" && (
              <span className="text-amber-400 ml-1">(closest match)</span>
            )}
          </div>
          <select
            value={colorName}
            onChange={(e) => pickColor(e.target.value)}
            className="w-full max-w-xs bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200"
          >
            <option value="" disabled>
              Pick the vendor color…
            </option>
            {result.colors.map((c) => (
              <option key={c.colorName} value={c.colorName}>
                {c.colorName}
              </option>
            ))}
          </select>

          {draftSizes.length > 0 && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {draftSizes.map((s, i) => (
                  <div
                    key={s.size}
                    className="flex items-center gap-1 bg-slate-800/70 border border-slate-700 rounded px-1.5 py-1"
                  >
                    <span className="text-[10px] font-mono text-slate-400">{s.size}</span>
                    <input
                      type="number"
                      min="0"
                      value={s.qty}
                      onChange={(e) =>
                        setDraftSizes((prev) =>
                          prev.map((p, pi) =>
                            pi === i ? { ...p, qty: Math.max(0, Number(e.target.value)) } : p,
                          ),
                        )
                      }
                      className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] font-mono text-slate-200 text-right"
                    />
                    <span className="text-[10px] font-mono text-slate-500 min-w-[42px] text-right">
                      {s.unitCost !== null ? money(s.unitCost) : "—"}
                    </span>
                  </div>
                ))}
              </div>
              {uncosted.length > 0 && (
                <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
                  <AlertTriangle size={12} />
                  No vendor price for: {uncosted.map((s) => s.size).join(", ")}
                </div>
              )}
              <button
                onClick={handleAdd}
                disabled={!canAdd}
                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded bg-[#059669] text-white hover:bg-[#047857] transition-colors disabled:opacity-40"
              >
                <Plus size={13} /> Add line ({totalQty} pcs)
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Manual add-item form (any PO; the only option on manual POs). */
function ManualAddForm({ onAdd }: { onAdd: (line: PoFileLineItem) => void }) {
  const [style, setStyle] = useState("");
  const [color, setColor] = useState("");
  const [description, setDescription] = useState("");
  const [cost, setCost] = useState("");
  const [sizeRows, setSizeRows] = useState<{ size: string; qty: number }[]>([
    { size: "", qty: 0 },
  ]);

  const costNum = Number(cost);
  const validRows = sizeRows.filter((r) => r.size.trim().length > 0 && r.qty > 0);
  const canAdd =
    style.trim().length > 0 && cost.trim().length > 0 && Number.isFinite(costNum) && costNum >= 0 && validRows.length > 0;

  function handleAdd() {
    if (!canAdd) return;
    onAdd({
      printavoLineItemId: null,
      printavoOrderId: null,
      visualId: null,
      styleNumber: style.trim(),
      color: color.trim() || null,
      vendorCatalogColor: null,
      description: description.trim() || null,
      brand: null,
      source: "manual",
      sizes: validRows.map((r) => ({
        size: r.size.trim().toUpperCase(),
        qty: r.qty,
        unitCost: costNum,
        sku: null,
        inventoryKey: null,
        sizeIndex: null,
      })),
    });
    setStyle("");
    setColor("");
    setDescription("");
    setCost("");
    setSizeRows([{ size: "", qty: 0 }]);
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={style}
          onChange={(e) => setStyle(e.target.value)}
          placeholder="Style #"
          className="w-28 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs font-mono text-slate-200"
        />
        <input
          value={color}
          onChange={(e) => setColor(e.target.value)}
          placeholder="Color"
          className="w-28 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description (optional)"
          className="flex-1 min-w-[140px] bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-200"
        />
        <input
          type="number"
          min="0"
          step="0.01"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          placeholder="Cost/pc"
          className="w-20 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs font-mono text-slate-200"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {sizeRows.map((r, i) => (
          <div
            key={i}
            className="flex items-center gap-1 bg-slate-800/70 border border-slate-700 rounded px-1.5 py-1"
          >
            <input
              value={r.size}
              onChange={(e) =>
                setSizeRows((prev) =>
                  prev.map((p, pi) => (pi === i ? { ...p, size: e.target.value } : p)),
                )
              }
              placeholder="Size"
              className="w-14 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] font-mono text-slate-200"
            />
            <input
              type="number"
              min="0"
              value={r.qty}
              onChange={(e) =>
                setSizeRows((prev) =>
                  prev.map((p, pi) =>
                    pi === i ? { ...p, qty: Math.max(0, Number(e.target.value)) } : p,
                  ),
                )
              }
              className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] font-mono text-slate-200 text-right"
            />
            {sizeRows.length > 1 && (
              <button
                onClick={() => setSizeRows((prev) => prev.filter((_, pi) => pi !== i))}
                className="text-slate-500 hover:text-red-400"
                aria-label="Remove size"
              >
                <X size={11} />
              </button>
            )}
          </div>
        ))}
        <button
          onClick={() => setSizeRows((prev) => [...prev, { size: "", qty: 0 }])}
          className="text-[11px] font-semibold px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
        >
          + size
        </button>
      </div>
      <button
        onClick={handleAdd}
        disabled={!canAdd}
        className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded bg-[#059669] text-white hover:bg-[#047857] transition-colors disabled:opacity-40"
      >
        <Plus size={13} /> Add line
      </button>
    </div>
  );
}

/**
 * Full PO edit panel: metadata, per-line size quantities, line removal,
 * add-replacement (vendor search or manual), and PO deletion.
 * Line items are replaced wholesale on save; totals recompute server-side.
 */
export function PoEditor({ po, onClose }: { po: PoFile; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [poNumber, setPoNumber] = useState(po.poNumber);
  const [notes, setNotes] = useState(po.notes ?? "");
  const [lines, setLines] = useState<PoFileLineItem[]>(
    // deep-enough copy so size qty edits never mutate the cached PO
    po.lineItems.map((li) => ({ ...li, sizes: li.sizes.map((s) => ({ ...s })) })),
  );
  const [addMode, setAddMode] = useState<"vendor" | "manual" | null>(null);
  /** Index of the line being replaced — the added line inherits its Printavo link. */
  const [replaceIdx, setReplaceIdx] = useState<number | null>(null);

  const canVendorSearch = po.vendorName === "sanmar" || po.vendorName === "ss";

  const update = useUpdatePoFile({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPoFilesQueryKey() });
        toast({ title: "PO updated" });
        onClose();
      },
      onError: (err) => {
        const apiMsg =
          err && typeof err === "object" && "data" in err
            ? (err as { data?: { error?: string } }).data?.error
            : undefined;
        toast({
          title: "Update failed",
          description: apiMsg,
          variant: "destructive",
        });
      },
    },
  });

  const deletePo = useDeletePoFile({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPoFilesQueryKey() });
        toast({ title: `PO ${po.poNumber} deleted` });
        onClose();
      },
      onError: () => toast({ title: "Delete failed", variant: "destructive" }),
    },
  });

  function setSizeQty(lineIdx: number, sizeIdx: number, qty: number) {
    setLines((prev) =>
      prev.map((li, i) =>
        i === lineIdx
          ? {
              ...li,
              sizes: li.sizes.map((s, si) =>
                si === sizeIdx ? { ...s, qty: Math.max(0, qty) } : s,
              ),
            }
          : li,
      ),
    );
  }

  function removeLine(idx: number) {
    setLines((prev) => prev.filter((_, i) => i !== idx));
    // Indexes shift after a removal — drop any pending replace to stay safe.
    setReplaceIdx(null);
  }

  /**
   * Append or, in replace mode, swap in for the replaced line. A replacement
   * inherits the old line's Printavo linkage (line item id / order id /
   * visual id) so P3 write-backs still know which invoice line it fulfills.
   */
  function handleAddLine(line: PoFileLineItem) {
    if (replaceIdx !== null && lines[replaceIdx]) {
      const old = lines[replaceIdx];
      const merged: PoFileLineItem = {
        ...line,
        printavoLineItemId: old.printavoLineItemId,
        printavoOrderId: old.printavoOrderId,
        visualId: old.visualId,
        color: line.color ?? old.color,
      };
      setLines((prev) => prev.map((li, i) => (i === replaceIdx ? merged : li)));
      setReplaceIdx(null);
    } else {
      setLines((prev) => [...prev, line]);
    }
    setAddMode(null);
  }

  function toggleAddMode(mode: "vendor" | "manual") {
    const next = addMode === mode ? null : mode;
    setAddMode(next);
    if (next === null) setReplaceIdx(null);
  }

  const emptyLines = lines.filter((li) => lineQty(li) === 0);
  const canSave =
    poNumber.trim().length > 0 &&
    lines.length > 0 &&
    emptyLines.length === 0 &&
    !update.isPending;

  const totals = lines.reduce(
    (acc, li) => {
      for (const s of li.sizes) {
        acc.qty += s.qty;
        acc.cost += s.qty * s.unitCost;
      }
      return acc;
    },
    { qty: 0, cost: 0 },
  );

  function handleSave() {
    if (!canSave) return;
    update.mutate({
      id: po.id,
      data: {
        poNumber: poNumber.trim(),
        notes: notes.trim() ? notes.trim() : null,
        lineItems: lines.map((li) => ({
          ...li,
          sizes: li.sizes.filter((s) => s.qty > 0),
        })),
      },
    });
  }

  function handleDelete() {
    if (
      window.confirm(
        `Delete PO ${po.poNumber}? This permanently removes it from the PO Log.`,
      )
    ) {
      deletePo.mutate({ id: po.id });
    }
  }

  return (
    <div className="border-t border-slate-800 bg-slate-900/40 px-5 py-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <label className="text-[11px] text-slate-500 font-semibold uppercase tracking-wider">
            PO number
          </label>
          <input
            value={poNumber}
            onChange={(e) => setPoNumber(e.target.value)}
            className="mt-1 block bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm font-mono text-white w-40"
          />
        </div>
        <div className="flex-1 min-w-[220px]">
          <label className="text-[11px] text-slate-500 font-semibold uppercase tracking-wider">
            Notes
          </label>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Notes (optional)"
            className="mt-1 block w-full bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-200"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-[11px] text-slate-500 font-semibold uppercase tracking-wider">
          Line items
        </div>
        {lines.map((li, idx) => {
          const qty = lineQty(li);
          const cost = li.sizes.reduce((a, s) => a + s.qty * s.unitCost, 0);
          return (
            <div
              key={`${li.styleNumber}-${idx}`}
              className="bg-slate-900/60 border border-slate-800 rounded-lg p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="font-mono font-bold text-sm text-white">
                    {li.styleNumber}
                  </span>
                  <span className="ml-2 text-xs text-slate-400">
                    {li.vendorCatalogColor ?? li.color ?? "—"}
                  </span>
                  {li.visualId && (
                    <span className="ml-2 text-[11px] font-mono text-slate-500">
                      #{li.visualId}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-slate-400">
                    {qty} pcs · <span className="text-[#10b981]">{money(cost)}</span>
                  </span>
                  <button
                    onClick={() => {
                      setReplaceIdx(idx);
                      setAddMode(canVendorSearch ? "vendor" : "manual");
                    }}
                    className={`transition-colors ${
                      replaceIdx === idx
                        ? "text-amber-400"
                        : "text-slate-500 hover:text-amber-400"
                    }`}
                    aria-label={`Replace line ${li.styleNumber}`}
                    title="Replace with a different item (keeps the Printavo link)"
                  >
                    <RefreshCw size={14} />
                  </button>
                  <button
                    onClick={() => removeLine(idx)}
                    className="text-slate-500 hover:text-red-400 transition-colors"
                    aria-label={`Remove line ${li.styleNumber}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {li.sizes.map((s, si) => (
                  <div
                    key={`${s.size}-${si}`}
                    className="flex items-center gap-1 bg-slate-800/70 border border-slate-700 rounded px-1.5 py-1"
                  >
                    <span className="text-[10px] font-mono text-slate-400">{s.size}</span>
                    <input
                      type="number"
                      min="0"
                      value={s.qty}
                      onChange={(e) => setSizeQty(idx, si, Number(e.target.value))}
                      className="w-12 bg-slate-900 border border-slate-700 rounded px-1 py-0.5 text-[11px] font-mono text-slate-200 text-right"
                    />
                    <span className="text-[10px] font-mono text-slate-500 min-w-[42px] text-right">
                      {money(s.unitCost)}
                    </span>
                  </div>
                ))}
              </div>
              {qty === 0 && (
                <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
                  <AlertTriangle size={12} />
                  This line has 0 pieces — set a quantity or remove it.
                </div>
              )}
            </div>
          );
        })}
        {lines.length === 0 && (
          <div className="flex items-center gap-1.5 text-[11px] text-amber-400">
            <AlertTriangle size={12} />
            A PO needs at least one line — add an item below, or delete the PO.
          </div>
        )}
      </div>

      <div className="space-y-2.5">
        {replaceIdx !== null && lines[replaceIdx] && (
          <div className="flex items-center gap-2 text-[11px] text-amber-300 bg-amber-950/40 border border-amber-900/50 rounded px-2.5 py-1.5">
            <RefreshCw size={12} className="shrink-0" />
            <span>
              Replacing{" "}
              <span className="font-mono font-bold">
                {lines[replaceIdx].styleNumber}
              </span>
              {lines[replaceIdx].visualId ? ` (order #${lines[replaceIdx].visualId})` : ""}{" "}
              — the item you add will take over this line and keep its Printavo
              link.
            </span>
            <button
              onClick={() => setReplaceIdx(null)}
              className="ml-auto text-slate-400 hover:text-white transition-colors"
              aria-label="Cancel replace"
            >
              <X size={12} />
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          {canVendorSearch && (
            <button
              onClick={() => toggleAddMode("vendor")}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded transition-colors border ${
                addMode === "vendor"
                  ? "bg-slate-700 border-slate-500 text-white"
                  : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
              }`}
            >
              <Search size={13} /> Add from {VENDOR_LABELS[po.vendorName]}
            </button>
          )}
          <button
            onClick={() => toggleAddMode("manual")}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded transition-colors border ${
              addMode === "manual"
                ? "bg-slate-700 border-slate-500 text-white"
                : "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
            }`}
          >
            <Plus size={13} /> Add manual item
          </button>
        </div>
        {addMode === "vendor" && canVendorSearch && (
          <VendorAddForm
            vendor={po.vendorName as "sanmar" | "ss"}
            onAdd={handleAddLine}
          />
        )}
        {addMode === "manual" && <ManualAddForm onAdd={handleAddLine} />}
      </div>

      <div className="flex items-center gap-2 pt-1 border-t border-slate-800/60">
        <button
          onClick={handleSave}
          disabled={!canSave}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-[#059669] text-white hover:bg-[#047857] transition-colors disabled:opacity-40"
        >
          {update.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Check size={13} />
          )}
          Save changes
        </button>
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
        >
          <X size={13} /> Cancel
        </button>
        <div className="flex-1 text-right text-xs font-mono text-slate-400">
          {totals.qty} pcs ·{" "}
          <span className="text-[#10b981] font-bold">{money(totals.cost)}</span>
        </div>
        <button
          onClick={handleDelete}
          disabled={deletePo.isPending}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-red-950/60 border border-red-900/60 text-red-400 hover:bg-red-900/40 transition-colors disabled:opacity-50"
        >
          {deletePo.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Trash2 size={13} />
          )}
          Delete PO
        </button>
      </div>
    </div>
  );
}
