import test from "node:test";
import assert from "node:assert/strict";
import {
  autoPickWarehouses,
  clearVendorResolutionIfCurrent,
  usePoCart,
  warehouseOptionsFor,
  type CartItem,
  type SizeInventory,
} from "./poCart.ts";
import { warehouseDistanceFromShipTo } from "./warehouseProximity.ts";

test("warehouse distance uses the ship-to ZIP centroid, not the former state reference", () => {
  const miles = warehouseDistanceFromShipTo("ss", "MA");
  assert.ok(miles !== null && miles > 25 && miles < 40);
});

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

function inventory(
  warehouses: Array<{ code: string; name?: string; qty: number }>,
): SizeInventory[] {
  return [{
    size: "M",
    found: true,
    warehouses: warehouses.map((w) => ({
      code: w.code,
      name: w.name ?? w.code,
      qty: w.qty,
      capped: false,
    })),
  }];
}

function stockedItem(overrides: Partial<CartItem> = {}): CartItem {
  return item({
    sizes: [{ ...item().sizes[0], size: "M", qty: 10, vendorSize: "M" }],
    ...overrides,
  });
}

test("vendor pricing snapshots generic quantity as the exact unique one-size SKU", () => {
  usePoCart.setState({ items: [item()] });
  usePoCart.getState().applyVendorData("line-1", {
    vendorCatalogColor: "JetBlack",
    vendorStyleId: "vendor-style-1",
    vendorStyleNumber: "C112",
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
  assert.equal(
    usePoCart.getState().items[0].vendorStyleNumber,
    "C112",
    "resolved vendor style is retained separately from the Printavo snapshot",
  );
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

test("resetting the same vendor clears old resolved pricing, identity, and inventory", () => {
  usePoCart.setState({
    items: [item({
      vendor: "ss",
      resolved: true,
      vendorCatalogColor: "Black",
      vendorStyleId: "13996",
      vendorStyleNumber: "102A",
      inventory: inventory([{ code: "MA", qty: 20 }]),
      warehouseCode: "MA",
      warehouseName: "MA",
      warehouseManual: true,
      sizes: [{
        size: "M",
        qty: 4,
        unitCost: 6.25,
        sku: "THREADFAST-102A-BLACK-M",
        inventoryKey: "old-key",
        sizeIndex: 2,
        vendorSize: "M",
      }],
    })],
  });

  usePoCart.getState().setVendor("line-1", "ss");
  const reset = usePoCart.getState().items[0];
  assert.equal(reset.resolved, false);
  assert.equal(reset.vendorCatalogColor, null);
  assert.equal(reset.vendorStyleId, null);
  assert.equal(reset.vendorStyleNumber, null);
  assert.equal(reset.inventory, null);
  assert.equal(reset.warehouseCode, null);
  assert.deepEqual(reset.sizes[0], {
    size: "M",
    qty: 4,
    unitCost: null,
    sku: null,
    inventoryKey: null,
    sizeIndex: null,
    vendorSize: null,
  });
});

test("case-unioned conflicting offers cannot reuse a previously picked size or SKU", () => {
  for (const vendorCatalogColor of ["Royal", "ROYAL"]) {
    usePoCart.setState({ items: [stockedItem({
      styleNumber: "5400", vendorStyleNumber: "5400", vendorCatalogColor,
      resolved: true, brand: "Gildan", color: "Royal",
      sizes: [{ ...stockedItem().sizes[0], unitCost: 5.89, sku: "prior", inventoryKey: "prior" }],
    })] });
    usePoCart.getState().applyVendorData("line-1", {
      vendorCatalogColor, vendorStyleId: null, vendorStyleNumber: "5400",
      sizes: [
        { size: "M", unitCost: 5.89, sku: "first", inventoryKey: "first", sizeIndex: 1 },
        { size: "M", unitCost: 99, sku: "second", inventoryKey: "second", sizeIndex: 2 },
      ],
    });
    const row = usePoCart.getState().items[0].sizes[0];
    assert.equal(row.unitCost, null);
    assert.equal(row.sku, null);
    assert.equal(row.inventoryKey, null);
  }
});

test("a stale rejected lookup cannot clear newer vendor or style work", () => {
  const newer = item({
    styleNumber: "102",
    vendor: "ss",
    resolved: true,
    vendorStyleId: "11184",
    vendorStyleNumber: "102",
    vendorCatalogColor: "Black",
    sizes: [{
      size: "M",
      qty: 4,
      unitCost: 4.75,
      sku: "AA102-BLACK-M",
      inventoryKey: null,
      sizeIndex: null,
      vendorSize: "M",
    }],
  });
  usePoCart.setState({ items: [newer] });

  assert.equal(
    clearVendorResolutionIfCurrent("line-1", "ss", "102A"),
    false,
  );
  assert.deepEqual(usePoCart.getState().items[0], newer);

  assert.equal(
    clearVendorResolutionIfCurrent("line-1", "sanmar", "102"),
    false,
  );
  assert.deepEqual(usePoCart.getState().items[0], newer);
});

test("real S&S SP08 OTHER row keeps exact ONE SIZE SKU and exposes live warehouses", () => {
  usePoCart.setState({
    items: [item({
      styleNumber: "SP08",
      color: "Black",
      brand: "Sportsman",
      vendor: "ss",
      sizes: [{
        ...item().sizes[0],
        size: "OTHER",
        qty: 25,
      }],
    })],
  });
  usePoCart.getState().applyVendorData("line-1", {
    vendorCatalogColor: "Black",
    vendorStyleId: "1415",
    vendorStyleNumber: "SP08",
    sizes: [{
      size: "ONE SIZE",
      unitCost: 2.6,
      sku: "B84095500",
      inventoryKey: null,
      sizeIndex: null,
    }],
  });

  const priced = usePoCart.getState().items[0];
  assert.equal(priced.sizes[0].vendorSize, "ONE SIZE");
  assert.equal(priced.sizes[0].sku, "B84095500");
  assert.equal(priced.sizes[0].unitCost, 2.6);

  usePoCart.getState().applyInventory("line-1", [{
    size: "ONE SIZE",
    found: true,
    warehouses: [
      { code: "MA", name: "MA", qty: 500, capped: false },
      { code: "PA", name: "PA", qty: 500, capped: false },
    ],
  }]);
  const stocked = usePoCart.getState().items[0];
  assert.deepEqual(warehouseOptionsFor(stocked).map((option) => option.code), ["MA", "PA"]);
  assert.equal(stocked.warehouseCode, "MA");
});

test("ambiguous one-size offers remain unresolved", () => {
  usePoCart.setState({ items: [item()] });
  usePoCart.getState().applyVendorData("line-1", {
    vendorCatalogColor: "JetBlack",
    vendorStyleId: "vendor-style-1",
    vendorStyleNumber: "C112",
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

test("nearer SanMar full coverage beats deeper far stock", () => {
  const [picked] = autoPickWarehouses([stockedItem({
    inventory: inventory([
      { code: "5", name: "Robbinsville, NJ", qty: 12 },
      { code: "4", name: "Reno, NV", qty: 900 },
    ]),
  })]);
  assert.equal(picked.warehouseCode, "5");
});

test("nearer S&S full coverage beats deeper far stock", () => {
  const [picked] = autoPickWarehouses([stockedItem({
    vendor: "ss",
    inventory: inventory([
      { code: "NJ", name: "Robbinsville, NJ", qty: 11 },
      { code: "NV", name: "Reno, NV", qty: 800 },
    ]),
  })]);
  assert.equal(picked.warehouseCode, "NJ");
  assert.equal(picked.warehouseName, "Robbinsville, NJ");
});

test("S&S NJ beats full-coverage IL and TX regional warehouses", () => {
  const [picked] = autoPickWarehouses([stockedItem({
    vendor: "ss",
    inventory: inventory([
      { code: "NJ", qty: 11 },
      { code: "IL", qty: 700 },
      { code: "TX", qty: 900 },
    ]),
  })]);
  assert.equal(picked.warehouseCode, "NJ");
});

test("S&S Massachusetts region beats NJ when both fully cover the line", () => {
  const [picked] = autoPickWarehouses([stockedItem({
    vendor: "ss",
    inventory: inventory([
      { code: "MA", qty: 11 },
      { code: "NJ", qty: 900 },
    ]),
  })]);
  assert.equal(picked.warehouseCode, "MA");
  assert.equal(picked.warehouseName, "Massachusetts / Boston region");
});

test("nearer insufficient stock does not beat full coverage farther away", () => {
  const [picked] = autoPickWarehouses([stockedItem({
    inventory: inventory([
      { code: "5", name: "Robbinsville, NJ", qty: 9 },
      { code: "2", name: "Cincinnati, OH", qty: 10 },
    ]),
  })]);
  assert.equal(picked.warehouseCode, "2");
});

test("style-color grouping keeps lines together at the nearer common warehouse", () => {
  const lines = [
    stockedItem({
      key: "a",
      printavoLineItemId: "a",
      inventory: inventory([
        { code: "5", qty: 20 },
        { code: "4", qty: 500 },
      ]),
    }),
    stockedItem({
      key: "b",
      printavoLineItemId: "b",
      styleNumber: "C112",
      inventory: inventory([
        { code: "5", qty: 15 },
        { code: "4", qty: 600 },
      ]),
    }),
    stockedItem({
      key: "c",
      printavoLineItemId: "c",
      styleNumber: "PC54",
      inventory: inventory([{ code: "2", qty: 30 }]),
    }),
  ];
  assert.deepEqual(autoPickWarehouses(lines).map((line) => line.warehouseCode), ["5", "5", "2"]);
});

test("manual warehouse override remains untouched", () => {
  const manual = stockedItem({
    warehouseCode: "4",
    warehouseName: "Reno, NV",
    warehouseManual: true,
    inventory: inventory([
      { code: "5", qty: 20 },
      { code: "4", qty: 20 },
    ]),
  });
  assert.strictEqual(autoPickWarehouses([manual])[0], manual);
});

test("unmapped warehouse codes fall back to deepest stock", () => {
  const [picked] = autoPickWarehouses([stockedItem({
    vendor: "ss",
    inventory: inventory([
      { code: "UNKNOWN-A", qty: 15 },
      { code: "UNKNOWN-B", qty: 40 },
    ]),
  })]);
  assert.equal(picked.warehouseCode, "UNKNOWN-B");
});

test("a mixed mapped and unmapped set also falls back to deepest stock", () => {
  const [picked] = autoPickWarehouses([stockedItem({
    vendor: "ss",
    inventory: inventory([
      { code: "NJ", qty: 15 },
      { code: "OPAQUE", qty: 40 },
    ]),
  })]);
  assert.equal(picked.warehouseCode, "OPAQUE");
});