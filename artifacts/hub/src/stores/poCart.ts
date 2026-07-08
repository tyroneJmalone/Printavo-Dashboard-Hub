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
  resolved: boolean;
  sizes: CartSizeRow[];
}

interface PoCartState {
  items: CartItem[];
  addItem: (item: CartItem) => void;
  removeItem: (key: string) => void;
  clear: () => void;
  setVendor: (key: string, vendor: CartVendor) => void;
  setSizeQty: (key: string, size: string, qty: number) => void;
  setManualCost: (key: string, cost: number) => void;
  applyVendorData: (
    key: string,
    data: {
      vendorCatalogColor: string;
      sizes: {
        size: string;
        unitCost: number | null;
        sku: string | null;
        inventoryKey: string | null;
        sizeIndex: number | null;
      }[];
    },
  ) => void;
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
      items: s.items.map((i) =>
        i.key === key
          ? {
              ...i,
              sizes: i.sizes.map((sz) =>
                sz.size === size ? { ...sz, qty: Math.max(0, qty) } : sz,
              ),
            }
          : i,
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
