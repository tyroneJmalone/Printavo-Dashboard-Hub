import test from "node:test";
import assert from "node:assert/strict";
import type { VendorLookupResult } from "@workspace/api-client-react";
import { usePoCart, warehouseOptionsFor, type CartItem } from "../../stores/poCart.ts";
import {
  applyLookupColor, beginCartLookup, cartItemsNeedingPricing,
  fetchMatchedInventory, lookupCartVendor,
  lookupCartLine, approveCartSelection, cartMappingSource,
} from "./cartVendorActions.ts";

function line(vendor: "ss" | "sanmar" = "sanmar"): CartItem {
  return {
    key: "line", printavoLineItemId: "line", printavoOrderId: "invoice",
    visualId: 1, styleNumber: "C112", brand: null, description: null,
    color: "Black", vendor, vendorStyleId: null, vendorCatalogColor: null,
    resolved: false, inventory: null, warehouseCode: null, warehouseName: null,
    sizes: [{ size: "2XL", qty: 5, unitCost: null, sku: null,
      inventoryKey: null, sizeIndex: null, vendorSize: null }],
  };
}

function result(vendor: "ss" | "sanmar" = "sanmar"): VendorLookupResult {
  return {
    vendor, found: true, matchType: "exact", styleQueried: "C112",
    styleName: "C112", styleId: vendor === "ss" ? "123" : null,
    brand: null, title: null, styleImage: null, cached: false, fetchedAt: "",
    colors: [{
      colorName: "Black", swatchImage: null, productImage: null,
      sizes: [{
        size: vendor === "ss" ? "2XL" : "2/3X", sku: "sku", inventoryKey: "ik",
        sizeIndex: 2, cost: 3, salePrice: 2, saleEndsAt: null,
        msrp: null, inventoryTotal: null, warehouses: null,
      }],
    }],
  };
}

function stock(size: string) {
  return { catalogColor: "Black", sizes: [{
    size, found: true, warehouses: [
      { code: "5", name: "Robbinsville, NJ", qty: 20, capped: false },
      { code: "4", name: "Reno, NV", qty: 30, capped: false },
    ],
  }] };
}

test("single and both bulk entry paths produce identical mapped inventory/warehouse choices", async (t) => {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    requests.push(body);
    return Response.json(stock(body.sizes[0]));
  });
  for (const vendor of ["ss", "sanmar"] as const) {
    const snapshots: unknown[] = [];
    for (const mode of ["single", "getAllPrices", "applyVendorToAll"]) {
      usePoCart.setState({ items: [line(mode === "applyVendorToAll" ? (vendor === "ss" ? "sanmar" : "ss") : vendor)] });
      if (mode === "applyVendorToAll") usePoCart.getState().setVendorAll(vendor);
      const targets = mode === "single" ? usePoCart.getState().items : cartItemsNeedingPricing({});
      assert.equal(targets.length, 1);
      const res = result(vendor);
      applyLookupColor(targets[0].key, res, "Black");
      await fetchMatchedInventory("line", vendor, res, "Black");
      const item = usePoCart.getState().items[0];
      assert.equal(item.sizes[0].vendorSize, vendor === "ss" ? "2XL" : "2/3X");
      assert.equal(item.sizes[0].unitCost, 2);
      assert.equal(warehouseOptionsFor(item).length, 2);
      assert.equal(item.inventory?.[0].warehouses[0].qty, 20);
      assert.equal(cartItemsNeedingPricing({ line: res }).length, 0);
      snapshots.push(item);
    }
    assert.deepEqual(snapshots[0], snapshots[1]);
    assert.deepEqual(snapshots[1], snapshots[2]);
  }
  assert.equal(requests.length, 6);
});

test("priced lines without inventory or dropdown offers remain eligible", () => {
  usePoCart.setState({ items: [line()] });
  applyLookupColor("line", result(), "Black");
  assert.equal(cartItemsNeedingPricing({ line: result() }).length, 1);
  usePoCart.getState().applyInventory("line", stock("2/3X").sizes);
  assert.equal(cartItemsNeedingPricing({}).length, 1);
  assert.equal(cartItemsNeedingPricing({ line: result() }).length, 0);
});

test("refresh preserves compatible manual size and warehouse, color change clears them", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(stock("2/3X")));
  usePoCart.setState({ items: [line()] });
  const res = result();
  applyLookupColor("line", res, "Black");
  usePoCart.getState().setWarehouse("line", "4", "Reno, NV");
  applyLookupColor("line", res, "Black");
  await fetchMatchedInventory("line", "sanmar", res, "Black");
  assert.equal(usePoCart.getState().items[0].warehouseCode, "4");
  assert.equal(usePoCart.getState().items[0].warehouseManual, true);
  const blue = { ...res, colors: [{ ...res.colors[0], colorName: "Blue" }] };
  applyLookupColor("line", blue, "Blue");
  const changed = usePoCart.getState().items[0];
  assert.equal(changed.inventory, null);
  assert.equal(changed.warehouseCode, null);
  assert.equal(changed.warehouseManual, false);
});

test("partial inventory failure is explicit, keeps prices, and remains retryable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("stock offline"); });
  usePoCart.setState({ items: [line()] });
  applyLookupColor("line", result(), "Black");
  await assert.rejects(fetchMatchedInventory("line", "sanmar", result(), "Black"), /stock offline/);
  assert.equal(usePoCart.getState().items[0].resolved, true);
  assert.equal(usePoCart.getState().items[0].inventory, null);
  assert.equal(cartItemsNeedingPricing({ line: result() }).length, 1);
});

test("lookup guards reject edits and newer lookup completions", () => {
  usePoCart.setState({ items: [line()] });
  const old = beginCartLookup("line");
  const latest = beginCartLookup("line");
  assert.equal(old(), false);
  assert.equal(latest(), true);
  usePoCart.getState().setStyleNumber("line", "PC54");
  assert.equal(latest(), false);
});

test("a compatible manual size remap survives a fresh catalog response", () => {
  const res = result();
  res.colors[0].sizes.push({ ...res.colors[0].sizes[0], size: "4/5X", sku: "manual-sku" });
  usePoCart.setState({ items: [line()] });
  applyLookupColor("line", res, "Black");
  usePoCart.getState().matchSizeToVendor("line", "2XL", {
    vendorSize: "4/5X", unitCost: 2, sku: "manual-sku",
    inventoryKey: "ik", sizeIndex: 2,
  });
  applyLookupColor("line", res, "Black");
  assert.equal(usePoCart.getState().items[0].sizes[0].vendorSize, "4/5X");
  assert.equal(usePoCart.getState().items[0].sizes[0].sku, "manual-sku");
});

test("one failed bulk stock read does not prevent another line's warehouse choices", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    if (body.vendor === "sanmar") throw new Error("SanMar unavailable");
    return Response.json(stock("2XL"));
  });
  usePoCart.setState({ items: [line(), { ...line("ss"), key: "other" }] });
  const outcomes = await Promise.allSettled(cartItemsNeedingPricing({}).map(async (item) => {
    const vendor = item.vendor as "ss" | "sanmar";
    const res = result(vendor);
    applyLookupColor(item.key, res, "Black");
    await fetchMatchedInventory(item.key, vendor, res, "Black");
  }));
  assert.deepEqual(outcomes.map((o) => o.status), ["rejected", "fulfilled"]);
  assert.equal(warehouseOptionsFor(usePoCart.getState().items[1]).length, 2);
  assert.equal(usePoCart.getState().items[0].inventory, null);
});

test("overlapping identical lookups share one read, not a persistent cache", async (t) => {
  let count = 0;
  t.mock.method(globalThis, "fetch", async () => {
    count++;
    return Response.json(result());
  });
  const request = { vendor: "sanmar" as const, style: "C112" };
  await Promise.all([lookupCartVendor(request), lookupCartVendor(request)]);
  assert.equal(count, 1);
  await lookupCartVendor(request);
  assert.equal(count, 2);
});

test("old inventory cannot survive vendor reset back to the same product", async (t) => {
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  t.mock.method(globalThis, "fetch", async () => {
    await waiting;
    return Response.json(stock("2/3X"));
  });
  usePoCart.setState({ items: [line()] });
  applyLookupColor("line", result(), "Black");
  const request = fetchMatchedInventory("line", "sanmar", result(), "Black");
  usePoCart.getState().setVendor("line", "sanmar");
  applyLookupColor("line", result(), "Black");
  finish();
  await request;
  assert.equal(usePoCart.getState().items[0].inventory, null);
});

test("approved mappings are read before lookup and validated against live style ID and color", async (t) => {
  const calls: { url: string; body: Record<string, unknown> | null }[] = [];
  const mapping = { vendorStyleId: "123", vendorStyle: "C112", vendorColor: "Black" };
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    const body = init.body ? JSON.parse(init.body as string) : null;
    calls.push({ url: String(url), body });
    return Response.json(body ? result("ss") : mapping);
  });
  const item = { ...line("ss"), styleNumber: "PrintavoAlias" };
  const res = await lookupCartLine(item, { vendor: "ss", style: item.styleNumber });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, null);
  assert.match(calls[0].url, /PrintavoAlias/);
  assert.equal(calls[1].body?.style, "C112");
  assert.equal(res.approvedColor, "Black");
  assert.equal(res.mappingRejected, false);
  // A saved approval does not write anything during ordinary hydration.
  assert.ok(calls.every((c) => !c.url.endsWith("/approve")));
});

test("approved product ID or color drift requires manual review, never automatic substitution", async (t) => {
  let mapping = { vendorStyleId: "wrong-id", vendorStyle: "C112", vendorColor: "Black" };
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) =>
    Response.json(init.body ? result("ss") : mapping));
  let res = await lookupCartLine(line("ss"), { vendor: "ss", style: "C112" });
  assert.equal(res.approvedColor, undefined);
  assert.equal(res.mappingRejected, true);
  mapping = { ...mapping, vendorStyleId: "123", vendorColor: "Navy" };
  res = await lookupCartLine(line("ss"), { vendor: "ss", style: "C112" });
  assert.equal(res.approvedColor, undefined);
  assert.match(res.mappingWarning!, /review manually/);
});

test("original source survives repeated style edits and explicit approval saves SanMar null ID", async (t) => {
  const payloads: Record<string, unknown>[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    payloads.push(body);
    return Response.json(body);
  });
  usePoCart.setState({ items: [{ ...line(), styleNumber: "OriginalAlias" }] });
  usePoCart.getState().setStyleNumber("line", "WrongCorrection");
  usePoCart.getState().setStyleNumber("line", "C112");
  const res = result();
  applyLookupColor("line", res, "Black");
  const selected = usePoCart.getState().items[0];
  assert.equal(cartMappingSource(selected, "sanmar").sourceStyle, "OriginalAlias");
  assert.equal(payloads.length, 0);
  await approveCartSelection(selected, res);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].sourceStyle, "OriginalAlias");
  assert.equal(payloads[0].sourceBrand, "");
  assert.equal(payloads[0].vendorStyleId, null);
  assert.equal(payloads[0].vendorColor, "Black");
});

test("approval save failure propagates without losing the selected color/pricing", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("approval unavailable"); });
  usePoCart.setState({ items: [line()] });
  applyLookupColor("line", result(), "Black");
  const selected = usePoCart.getState().items[0];
  await assert.rejects(approveCartSelection(selected, result()), /approval unavailable/);
  assert.strictEqual(usePoCart.getState().items[0], selected);
});

test("mapping read errors are surfaced and manual style corrections override stored styles", async (t) => {
  let failRead = true;
  const requestedStyles: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    if (!init.body) {
      if (failRead) throw new Error("mapping unavailable");
      return Response.json({ vendorStyleId: null, vendorStyle: "OtherStyle", vendorColor: "Black" });
    }
    requestedStyles.push(JSON.parse(init.body as string).style);
    return Response.json(result());
  });
  const item = { ...line(), sourceStyleNumber: "OriginalAlias" };
  let res = await lookupCartLine(item, { vendor: "sanmar", style: "C112" });
  assert.match(res.mappingWarning!, /mapping unavailable/);
  failRead = false;
  res = await lookupCartLine(item, { vendor: "sanmar", style: "C112" });
  assert.equal(res.approvedColor, undefined);
  assert.deepEqual(requestedStyles, ["C112", "C112"]);
});