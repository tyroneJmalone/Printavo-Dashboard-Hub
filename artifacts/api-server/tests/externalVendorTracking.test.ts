import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchesHub, vendorComplete } from "../src/lib/purchasing/externalTrackingPolicy";
import { SSClient } from "../../../lib/ss-activewear/src/client";
import { SanMarClient } from "../../../lib/sanmar/src/client";

test("deduplicates exact customer PO or confirmed vendor order across sources, retaining punctuation", () => {
  const candidate = {vendor:"ss",poNumber:"315/315",snapshot:{orderNumbers:["order-1"]}};
  assert.ok(matchesHub(candidate,[{vendor:"ss",poNumber:" 315/315 ",vendorOrderNumbers:[]}]));
  assert.ok(matchesHub(candidate,[{vendor:"ss",poNumber:"different",vendorOrderNumbers:["ORDER-1"]}]));
  assert.equal(matchesHub(candidate,[{vendor:"sanmar",poNumber:"315/315",vendorOrderNumbers:["order-1"]}]),false);
  assert.equal(matchesHub(candidate,[{vendor:"ss",poNumber:"315315",vendorOrderNumbers:[]}]),false);
  assert.equal(vendorComplete("Complete, Open"),false);
  assert.equal(vendorComplete("Completed"),true);
  assert.equal(vendorComplete(null),false);
});

test("S&S history is read-only and filters by order date, not ship date", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(init?.method ?? "GET","GET");
      assert.match(String(url),/All=True/);
      return new Response(JSON.stringify([
        {orderNumber:"recent",poNumber:"12/34",orderDate:new Date().toISOString()},
        {orderNumber:"old",orderDate:"2020-01-01",shipDate:new Date().toISOString()},
      ]),{status:200});
    };
    const client = new SSClient({accountNumber:"test",apiKey:"test"});
    const result = await client.getRecentOrders(new Date(Date.now()-7*86400000));
    assert.deepEqual(result.orders.map(o=>o.orderNumber),["recent"]);
    assert.equal(result.orders[0].poNumber,"12/34");
    globalThis.fetch = async () => new Response(JSON.stringify([{orderNumber:"missing-date"}]),{status:200});
    await assert.rejects(client.getRecentOrders(new Date()),/missing an order date/);
  } finally { globalThis.fetch = original; }
});

test("SanMar discovers status activity, preserving sales orders for missing customer PO", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, init) => {
      const body = String(init?.body);
      assert.match(body,/<ns:queryType>3<\/ns:queryType>/);
      assert.match(body,/<ns:statusTimeStamp>/);
      assert.doesNotMatch(body,/submitPO/);
      return new Response(`<OrderStatus><purchaseOrderNumber>12/34</purchaseOrderNumber><factoryOrderNumber>1</factoryOrderNumber></OrderStatus><OrderStatus><purchaseOrderNumber>NOT AVAILABLE</purchaseOrderNumber><factoryOrderNumber>2</factoryOrderNumber></OrderStatus>`,{status:200});
    };
    const result = await new SanMarClient({customerNumber:"test",username:"test",password:"test"}).getRecentlyUpdatedOrders(new Date());
    assert.deepEqual(result,[{poNumber:"12/34",orderNumber:"1"},{poNumber:"NOT AVAILABLE",orderNumber:"2"}]);
  } finally { globalThis.fetch = original; }
});

test("SanMar warehouses come only from shipment origins, with split origins deduplicated", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(`<OrderShipmentNotification><complete>true</complete>
      <SalesOrder><salesOrderNumber>123</salesOrderNumber>
      <ShipmentLocation><ShipFromAddress><city>Robbinsville</city><region>NJ</region></ShipFromAddress>
        <ShipToAddress><city>Customer City</city><region>NH</region></ShipToAddress>
        <Package><trackingNumber>ABC</trackingNumber></Package></ShipmentLocation>
      <ShipmentLocation><ShipFromAddress><city>Robbinsville</city><region>NJ</region></ShipFromAddress></ShipmentLocation>
      <ShipmentLocation><ShipFromAddress><city>Reno</city><region>NV</region></ShipFromAddress></ShipmentLocation>
      </SalesOrder></OrderShipmentNotification>`, { status: 200 });
    const result = await new SanMarClient({customerNumber:"test",username:"test",password:"test"}).getShipmentNotification("test");
    assert.deepEqual(result.warehouses, ["Robbinsville, NJ", "Reno, NV"]);
    assert.equal(result.packages[0].trackingNumber, "ABC");
    assert.equal(result.complete, true);
  } finally { globalThis.fetch = original; }
});

test("S&S detail lookup retains vendor placement date and warehouse", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ orders: [{
      orderNumber:"123",orderDate:"2026-10-07T15:30:00.36",warehouseAbbr:"MA",orderStatus:"Complete",
    }] }), {status:200});
    const result = await new SSClient({accountNumber:"test",apiKey:"test"}).getOrders("123");
    assert.equal(result.orders[0].warehouse,"MA");
    assert.equal(result.orders[0].orderDate,"2026-10-07T15:30:00.36");
  } finally { globalThis.fetch = original; }
});
