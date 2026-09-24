import test from "node:test";
import assert from "node:assert/strict";
import { usePoCart, type CartItem } from "./poCart.ts";

function item(overrides: Partial<CartItem> = {}): CartItem {
  return {
    key: "line-1",
    printavoLineItemId: "line-1",
    printavoOrderId: "invoice-1",
    visualId: 1007,
    styleNumber: "C112",
    color: "Jet Black",
    description: null,
    brand: "Port Authority",
    vendor: "sanmar",
    vendorCatalogColor: null,
    vendorStyleId: null,
    resolved: false,
    sizes: [{
      size: "Quantitiy",
      qty: 17,
      unitCost: null,
      sku: null,
      inventoryKey: null,
      sizeIndex: null,
      vendorSize: null,
    }],
    inventory: null,
    warehouseCode: null,
    warehouseName: null,
    warehouseManual: false,
    ...overrides,
  };
}

test("vendor pricing snapshots generic quantity as the exact unique one-size SKU", () => {
  usePoCart.setState({ items: [item()] });
  usePoCart.getState().applyVendorData("line-1", {
    vendorCatalogColor: "JetBlack",
    vendorStyleId: "vendor-style-1",
    sizes: [
      {
        size: "ONE SIZE FITS MOST",
        unitCost: 4.25,
        sku: "C112-JB-OSFM",
        inventoryKey: "inventory-osfm",
        sizeIndex: 8,
      },
      {
        size: "S",
        unitCost: 4,
        sku: "C112-JB-S",
        inventoryKey: "inventory-s",
        sizeIndex: 1,
      },
    ],
  });
  const row = usePoCart.getState().items[0].sizes[0];
  assert.deepEqual(row, {
    size: "Quantitiy",
    qty: 17,
    unitCost: 4.25,
    sku: "C112-JB-OSFM",
    inventoryKey: "inventory-osfm",
    sizeIndex: 8,
    vendorSize: "ONE SIZE FITS MOST",
  });
});

test("ambiguous one-size offers remain unresolved", () => {
  usePoCart.setState({ items: [item()] });
  usePoCart.getState().applyVendorData("line-1", {
    vendorCatalogColor: "JetBlack",
    vendorStyleId: "vendor-style-1",
    sizes: [
      { size: "OS", unitCost: 4, sku: "OS", inventoryKey: null, sizeIndex: 1 },
      { size: "OSFM", unitCost: 4, sku: "OSFM", inventoryKey: null, sizeIndex: 2 },
    ],
  });
  assert.equal(usePoCart.getState().items[0].sizes[0].vendorSize, null);
});

test("fresh inventory preserves a valid manual warehouse and drops a vanished one", () => {
  const manuallyPicked = item({
    warehouseCode: "WH1",
    warehouseName: "Reno",
    warehouseManual: true,
    sizes: [{ ...item().sizes[0], size: "OS", vendorSize: "OS" }],
  });
  usePoCart.setState({ items: [manuallyPicked] });
  usePoCart.getState().applyInventory("line-1", [{
    size: "OS",
    found: true,
    warehouses: [{ code: "WH1", name: "Reno", qty: 20, capped: false }],
  }]);
  assert.equal(usePoCart.getState().items[0].warehouseCode, "WH1");
  assert.equal(usePoCart.getState().items[0].warehouseManual, true);

  usePoCart.getState().applyInventory("line-1", [{
    size: "OS",
    found: true,
    warehouses: [{ code: "WH2", name: "Dallas", qty: 20, capped: false }],
  }]);
  assert.equal(usePoCart.getState().items[0].warehouseCode, "WH2");
  assert.equal(usePoCart.getState().items[0].warehouseManual, false);
});