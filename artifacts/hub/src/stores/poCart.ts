import { create } from "zustand";

/**
 * Client-only PO cart (never persisted server-side — a PO row is only
 * written when the user saves). Keyed by Printavo line-item id.
 * Select individual fields from this store — never destructure the whole
 * store object (causes re-renders on every change).
 */

export type CartVendor = "sanmar" | "ss" | "manual";

/** Printavo and vendors label extended/one-size sizes differently. */
const SIZE_ALIASES: Record<string, string> = {
  XXL: "2XL",
  "2X": "2XL",
  XXXL: "3XL",
  "3X": "3XL",
  XXXXL: "4XL",
  "4X": "4XL",
  XXXXXL: "5XL",
  "5X": "5XL",
  XXXXXXL: "6XL",
  "6X": "6XL",
  OS: "OSFA",
  "ONE SIZE": "OSFA",
  "ONE SIZE FITS ALL": "OSFA",
  "O/S": "OSFA",
  ADJ: "OSFA",
  ADJUSTABLE: "OSFA",
};

export function canonSize(size: string): string {
  const u = size.trim().toUpperCase();
  return SIZE_ALIASES[u] ?? u;
}

export interface CartSizeRow {
  size: string;
  qty: number;
  unitCost: number | null;
  sku: string | null;
  inventoryKey: string | null;
  sizeIndex: number | null;
}

export interface WarehouseStock {
  code: string;
  name: string;
  qty: number;
  /** Vendor caps the reported number (SanMar reports at most 3000). */
  capped: boolean;
}

export interface SizeInventory {
  size: string;
  found: boolean;
  warehouses: WarehouseStock[];
}

export interface CartItem {
  key: string;
  printavoLineItemId: string;
  printavoOrderId: string;
  visualId: number;
  styleNumber: string;
  color: string | null;
  description: string | null;
  brand: string | null;
  vendor: CartVendor | null;
  vendorCatalogColor: string | null;
  /** Vendor-internal id of the matched product (S&S styleID) — keeps the
   *  inventory check on the SAME product the lookup priced. */
  vendorStyleId: string | null;
  resolved: boolean;
  sizes: CartSizeRow[];
  /** Per-size warehouse availability for the resolved color (null until fetched). */
  inventory: SizeInventory[] | null;
  warehouseCode: string | null;
  warehouseName: string | null;
  /** True once the user hand-picks a warehouse — auto-pick then leaves it alone. */
  warehouseManual: boolean;
}

/** One selectable warehouse for a cart line, scored against its needed sizes. */
export interface WarehouseOption {
  code: string;
  name: string;
  /** Total available across this line's needed sizes (capped sizes count as 3000). */
  totalQty: number;
  capped: boolean;
  /** Needed sizes this warehouse can NOT fully cover (empty = covers everything). */
  short: string[];
}

function neededSizes(item: CartItem): { size: string; qty: number }[] {
  return item.sizes
    .filter((s) => s.qty > 0)
    .map((s) => ({ size: canonSize(s.size), qty: s.qty }));
}

function invForSize(item: CartItem, canon: string): SizeInventory | undefined {
  return item.inventory?.find((si) => canonSize(si.size) === canon);
}

/** Sorted best-first: full coverage before partial, then deepest stock. */
export function warehouseOptionsFor(item: CartItem): WarehouseOption[] {
  if (!item.inventory) return [];
  const needed = neededSizes(item);
  const byCode = new Map<string, WarehouseOption>();
  for (const si of item.inventory) {
    for (const wh of si.warehouses) {
      if (!byCode.has(wh.code)) {
        byCode.set(wh.code, { code: wh.code, name: wh.name, totalQty: 0, capped: false, short: [] });
      }
    }
  }
  for (const opt of byCode.values()) {
    for (const n of needed) {
      const si = invForSize(item, n.size);
      const wh = si?.found ? si.warehouses.find((w) => w.code === opt.code) : undefined;
      opt.totalQty += wh?.qty ?? 0;
      if (wh?.capped) opt.capped = true;
      if (!wh || (wh.qty < n.qty && !wh.capped)) opt.short.push(n.size);
    }
  }
  return [...byCode.values()].sort(
    (a, b) =>
      (a.short.length === 0 ? 0 : 1) - (b.short.length === 0 ? 0 : 1) ||
      b.totalQty - a.totalQty,
  );
}

function fullCoverageCodes(item: CartItem): Set<string> {
  return new Set(
    warehouseOptionsFor(item)
      .filter((o) => o.short.length === 0)
      .map((o) => o.code),
  );
}

/**
 * The single warehouse (if any) that fully covers EVERY line in the group,
 * preferring the one with the deepest total stock across the group.
 */
function bestCommonCode(group: CartItem[]): string | null {
  let common: Set<string> | null = null;
  for (const item of group) {
    const codes = fullCoverageCodes(item);
    common = common === null ? codes : new Set([...common].filter((c) => codes.has(c)));
    if (common.size === 0) return null;
  }
  if (!common || common.size === 0) return null;
  let best: string | null = null;
  let bestQty = -1;
  for (const code of common) {
    let qty = 0;
    for (const item of group) {
      qty += warehouseOptionsFor(item).find((o) => o.code === code)?.totalQty ?? 0;
    }
    if (qty > bestQty) {
      bestQty = qty;
      best = code;
    }
  }
  return best;
}

/**
 * Auto-assign warehouses to every non-manually-overridden line with inventory.
 * Hierarchy per Printavo order within a vendor:
 *   (a) one warehouse that covers ALL of the order's lines,
 *   (b) else one per style+color group,
 *   (c) else per line — best coverage, deepest stock.
 * Ties break toward the warehouse with the most total stock.
 */
export function autoPickWarehouses(items: CartItem[]): CartItem[] {
  const picks = new Map<string, { code: string; name: string } | null>();
  const eligible = items.filter(
    (i) =>
      (i.vendor === "sanmar" || i.vendor === "ss") &&
      i.inventory !== null &&
      !i.warehouseManual,
  );
  const byVendorOrder = new Map<string, CartItem[]>();
  for (const i of eligible) {
    const gk = `${i.vendor}::${i.printavoOrderId}`;
    const g = byVendorOrder.get(gk) ?? [];
    g.push(i);
    byVendorOrder.set(gk, g);
  }
  const nameFor = (item: CartItem, code: string): string =>
    warehouseOptionsFor(item).find((o) => o.code === code)?.name ?? code;

  for (const group of byVendorOrder.values()) {
    const withInv = group.filter(
      (i) => (i.inventory?.length ?? 0) > 0 && neededSizes(i).length > 0,
    );
    for (const i of group) {
      if (!withInv.includes(i)) picks.set(i.key, null);
    }
    if (withInv.length === 0) continue;

    const orderCode = bestCommonCode(withInv);
    if (orderCode) {
      for (const i of withInv) picks.set(i.key, { code: orderCode, name: nameFor(i, orderCode) });
      continue;
    }

    const byStyle = new Map<string, CartItem[]>();
    for (const i of withInv) {
      const sk = `${i.styleNumber}::${i.vendorCatalogColor ?? ""}`;
      const g = byStyle.get(sk) ?? [];
      g.push(i);
      byStyle.set(sk, g);
    }
    for (const sub of byStyle.values()) {
      const subCode = bestCommonCode(sub);
      if (subCode) {
        for (const i of sub) picks.set(i.key, { code: subCode, name: nameFor(i, subCode) });
        continue;
      }
      for (const i of sub) {
        const best = warehouseOptionsFor(i)[0];
        picks.set(i.key, best ? { code: best.code, name: best.name } : null);
      }
    }
  }

  return items.map((i) => {
    if (!picks.has(i.key)) return i;
    const p = picks.get(i.key) ?? null;
    const code = p?.code ?? null;
    const name = p?.name ?? null;
    if (i.warehouseCode === code && i.warehouseName === name) return i;
    return { ...i, warehouseCode: code, warehouseName: name };
  });
}

interface PoCartState {
  items: CartItem[];
  addItem: (item: CartItem) => void;
  removeItem: (key: string) => void;
  clear: () => void;
  setVendor: (key: string, vendor: CartVendor) => void;
  setStyleNumber: (key: string, styleNumber: string) => void;
  setSizeQty: (key: string, size: string, qty: number) => void;
  setManualCost: (key: string, cost: number) => void;
  applyVendorData: (
    key: string,
    data: {
      vendorCatalogColor: string;
      vendorStyleId: string | null;
      sizes: {
        size: string;
        unitCost: number | null;
        sku: string | null;
        inventoryKey: string | null;
        sizeIndex: number | null;
      }[];
    },
  ) => void;
  applyInventory: (key: string, inventory: SizeInventory[]) => void;
  setWarehouse: (key: string, code: string | null, name: string | null) => void;
}

export const usePoCart = create<PoCartState>((set) => ({
  items: [],

  addItem: (item) =>
    set((s) =>
      s.items.some((i) => i.key === item.key)
        ? s
        : { items: [...s.items, item] },
    ),

  removeItem: (key) =>
    set((s) => ({ items: s.items.filter((i) => i.key !== key) })),

  clear: () => set({ items: [] }),

  setVendor: (key, vendor) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.key === key
          ? {
              ...i,
              vendor,
              // switching vendor invalidates any prior resolution
              resolved: false,
              vendorCatalogColor: null,
              vendorStyleId: null,
              inventory: null,
              warehouseCode: null,
              warehouseName: null,
              warehouseManual: false,
              sizes: i.sizes.map((sz) => ({
                ...sz,
                unitCost: null,
                sku: null,
                inventoryKey: null,
                sizeIndex: null,
              })),
            }
          : i,
      ),
    })),

  setStyleNumber: (key, styleNumber) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.key === key
          ? {
              ...i,
              styleNumber,
              // a different style invalidates any prior vendor resolution
              resolved: false,
              vendorCatalogColor: null,
              vendorStyleId: null,
              inventory: null,
              warehouseCode: null,
              warehouseName: null,
              warehouseManual: false,
              sizes: i.sizes.map((sz) => ({
                ...sz,
                unitCost: null,
                sku: null,
                inventoryKey: null,
                sizeIndex: null,
              })),
            }
          : i,
      ),
    })),

  setSizeQty: (key, size, qty) =>
    set((s) => ({
      // Quantities change what a warehouse must cover — re-run auto-pick.
      items: autoPickWarehouses(
        s.items.map((i) =>
          i.key === key
            ? {
                ...i,
                sizes: i.sizes.map((sz) =>
                  sz.size === size ? { ...sz, qty: Math.max(0, qty) } : sz,
                ),
              }
            : i,
        ),
      ),
    })),

  setManualCost: (key, cost) =>
    set((s) => ({
      items: s.items.map((i) =>
        i.key === key
          ? {
              ...i,
              resolved: true,
              sizes: i.sizes.map((sz) => ({ ...sz, unitCost: cost })),
            }
          : i,
      ),
    })),

  applyVendorData: (key, data) =>
    set((s) => ({
      items: s.items.map((i) => {
        if (i.key !== key) return i;
        return {
          ...i,
          resolved: true,
          vendorCatalogColor: data.vendorCatalogColor,
          vendorStyleId: data.vendorStyleId,
          // a (possibly different) color means the old availability is stale
          inventory: null,
          warehouseCode: null,
          warehouseName: null,
          warehouseManual: false,
          sizes: i.sizes.map((sz) => {
            const match = data.sizes.find(
              (v) => canonSize(v.size) === canonSize(sz.size),
            );
            return match
              ? {
                  ...sz,
                  unitCost: match.unitCost,
                  sku: match.sku,
                  inventoryKey: match.inventoryKey,
                  sizeIndex: match.sizeIndex,
                }
              : { ...sz, unitCost: null, sku: null, inventoryKey: null, sizeIndex: null };
          }),
        };
      }),
    })),

  applyInventory: (key, inventory) =>
    set((s) => ({
      items: autoPickWarehouses(
        s.items.map((i) => {
          if (i.key !== key) return i;
          const next = { ...i, inventory };
          // A hand-picked warehouse that vanished from fresh data resets to auto.
          if (next.warehouseManual) {
            const codes = new Set(
              inventory.flatMap((si) => si.warehouses.map((w) => w.code)),
            );
            if (!next.warehouseCode || !codes.has(next.warehouseCode)) {
              next.warehouseManual = false;
              next.warehouseCode = null;
              next.warehouseName = null;
            }
          }
          return next;
        }),
      ),
    })),

  setWarehouse: (key, code, name) =>
    set((s) => {
      const items = s.items.map((i) =>
        i.key === key
          ? { ...i, warehouseCode: code, warehouseName: name, warehouseManual: code !== null }
          : i,
      );
      // Clearing an override hands the line back to auto-pick.
      return { items: code === null ? autoPickWarehouses(items) : items };
    }),
}));

const SANMAR_BRANDS = [
  "port & co",
  "port authority",
  "sport-tek",
  "district",
  "nike",
  "ogio",
  "new era",
  "carhartt",
  "eddie bauer",
  "red house",
  "allmade",
  "cornerstone",
  "volunteer knitwear",
];
const SS_BRANDS = [
  "bella",
  "canvas",
  "gildan",
  "next level",
  "comfort colors",
  "champion",
  "jerzees",
  "hanes",
  "fruit of the loom",
  "independent trading",
  "american apparel",
  "tultex",
  "los angeles apparel",
  "adidas",
  "richardson",
  "valucap",
  "flexfit",
  "yupoong",
];

/** Best-guess default vendor from the Printavo brand string. */
export function guessVendor(brand: string | null): CartVendor | null {
  if (!brand) return null;
  const b = brand.toLowerCase();
  if (SANMAR_BRANDS.some((x) => b.includes(x))) return "sanmar";
  if (SS_BRANDS.some((x) => b.includes(x))) return "ss";
  return null;
}
