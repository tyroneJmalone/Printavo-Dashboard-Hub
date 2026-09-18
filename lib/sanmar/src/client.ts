import type {
  SanMarCredentials,
  SanMarProductEntry,
  SanMarInventoryResult,
  SanMarPoInput,
  SanMarPoResult,
  SanMarOrderStatusResult,
  SanMarShipmentResult,
} from "./types";

const PRODUCT_INFO_ENDPOINT =
  "https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort";
const INVENTORY_ENDPOINT =
  "https://ws.sanmar.com:8080/SanMarWebService/SanMarWebServicePort";
const PRODUCT_INFO_NS = "http://impl.webservice.integration.sanmar.com/";
const INVENTORY_NS = "http://webservice.integration.sanmar.com/";
const PO_PROD_ENDPOINT =
  "https://ws.sanmar.com:8080/SanMarWebService/SanMarPOServicePort";
/** SanMar's UAT/test environment — submitPO here places NO real order. */
const PO_TEST_ENDPOINT =
  "https://test-ws.sanmar.com:8080/SanMarWebService/SanMarPOServicePort";
/** submitPO shares the integration namespace with the inventory service. */
const PO_NS = INVENTORY_NS;
/** One shot only — a submit is never retried (see submitPO). */
const SUBMIT_TIMEOUT_MS = 30_000;

/**
 * PromoStandards read-only services (order status + shipment/tracking).
 * Verified live 2026-07-13 against a real order: id = SanMar USERNAME (not
 * account number), queryType 1 = lookup by PO number.
 */
const PS_ORDER_STATUS_ENDPOINT =
  "https://ws.sanmar.com:8080/promostandards/OrderStatusServiceBinding";
const PS_OSN_ENDPOINT =
  "https://ws.sanmar.com:8080/promostandards/OrderShipmentNotificationServiceBinding";
const PS_ORDER_STATUS_NS =
  "http://www.promostandards.org/WSDL/OrderStatusService/1.0.0/";
const PS_OSN_NS =
  "http://www.promostandards.org/WSDL/OrderShipmentNotificationService/1.0.0/";
/** OSN declares wsVersion/id/password in a SharedObjects schema — required. */
const PS_OSN_SHARED_NS = `${PS_OSN_NS}SharedObjects/`;

export class SanMarApiError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth" | "fault" | "http" | "network" = "http",
    /** HTTP status when kind === "http" — lets callers treat 5xx as ambiguous. */
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "SanMarApiError";
  }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlDecode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}

function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  const v = m?.[1]?.trim();
  return v ? xmlDecode(v) : null;
}

function num(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * SanMar's SOAP services intermittently hang: the same request that fails
 * after 30s succeeds in ~300ms moments later. Fail fast and retry once
 * instead of waiting — total worst case must stay under ~45s because the
 * Replit edge proxy kills held-open responses around 48s.
 */
const ATTEMPT_TIMEOUTS_MS = [15_000, 25_000];

/**
 * Build a PO SOAP envelope for submitPO or getPreSubmitInfo (same arg
 * structure per the live WSDL). Kept as a standalone pure function so the
 * dry-run path can render a preview without a client/network. Credentials are
 * injected here and only here — they are NEVER part of the persisted payload.
 *
 * CRITICAL — element order: SanMar's JAX-WS parser unmarshals xs:sequence
 * types positionally. Out-of-order (or misplaced) elements silently parse as
 * null and the service throws "SOAP fault: java.lang.NullPointerException"
 * (this exact failure happened on the first live submit, 2026-07-13). The
 * orders below are copied verbatim from the live WSDL
 * (SanMarPOServicePort?wsdl):
 *   webServicePO (arg0): attention, internalMessage, notes, poNum,
 *     poSenderId, residence, department, shipAddress1, shipAddress2,
 *     shipCity, shipEmail, shipMethod, shipState, shipTo, shipZip,
 *     webServicePoDetailList*
 *   webServicePODetail: color, errorOccured, inventoryKey, message, poId,
 *     quantity, size, sizeIndex, style, whseNo
 *   webServiceUser (arg1): sanMarCustomerNumber, sanMarUserName,
 *     sanMarUserPassword, senderId, senderPassword
 * Credentials go in arg1 (webServiceUser), NOT inside arg0.
 *
 * Field limits per the SanMar PO Integration Guide v24.3 (poNum ≤ 12 chars,
 * shipTo ≤ 28, shipAddress1/attention ≤ 35, shipCity ≤ 28, shipState
 * 2-letter).
 */
export function buildSanMarPoEnvelope(
  creds: SanMarCredentials,
  input: SanMarPoInput,
  operation: "submitPO" | "getPreSubmitInfo" = "submitPO",
): string {
  const details = input.lines
    .map(
      (l) => `
        <webServicePoDetailList>
          <color>${xmlEscape(l.color)}</color>${
            l.inventoryKey
              ? `\n          <inventoryKey>${xmlEscape(l.inventoryKey)}</inventoryKey>`
              : ""
          }
          <quantity>${l.quantity}</quantity>
          <size>${xmlEscape(l.size)}</size>${
            l.sizeIndex != null
              ? `\n          <sizeIndex>${l.sizeIndex}</sizeIndex>`
              : ""
          }
          <style>${xmlEscape(l.style)}</style>
          <whseNo>${l.whseNo}</whseNo>
        </webServicePoDetailList>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="${PO_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <web:${operation}>
      <arg0>${
        input.attention
          ? `\n        <attention>${xmlEscape(input.attention)}</attention>`
          : ""
      }${input.notes ? `\n        <notes>${xmlEscape(input.notes)}</notes>` : ""}
        <poNum>${xmlEscape(input.poNumber)}</poNum>
        <residence>${input.residential ? "Y" : "N"}</residence>
        <shipAddress1>${xmlEscape(input.shipAddress1)}</shipAddress1>${
          input.shipAddress2
            ? `\n        <shipAddress2>${xmlEscape(input.shipAddress2)}</shipAddress2>`
            : ""
        }
        <shipCity>${xmlEscape(input.shipCity)}</shipCity>${
          input.shipEmail
            ? `\n        <shipEmail>${xmlEscape(input.shipEmail)}</shipEmail>`
            : ""
        }
        <shipMethod>${xmlEscape(input.shipMethod)}</shipMethod>
        <shipState>${xmlEscape(input.shipState)}</shipState>
        <shipTo>${xmlEscape(input.shipTo)}</shipTo>
        <shipZip>${xmlEscape(input.shipZip)}</shipZip>${details}
      </arg0>
      <arg1>
        <sanMarCustomerNumber>${xmlEscape(creds.customerNumber)}</sanMarCustomerNumber>
        <sanMarUserName>${xmlEscape(creds.username)}</sanMarUserName>
        <sanMarUserPassword>${xmlEscape(creds.password)}</sanMarUserPassword>
      </arg1>
    </web:${operation}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

export class SanMarClient {
  constructor(private readonly creds: SanMarCredentials) {}

  private async soapCall(
    endpoint: string,
    body: string,
    /** SanMar's own services accept '""'; PromoStandards requires the real action. */
    soapAction = '""',
  ): Promise<string> {
    let text: string | null = null;
    let status = 0;
    let ok = false;
    let lastErr: unknown = null;
    for (const timeoutMs of ATTEMPT_TIMEOUTS_MS) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: soapAction },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        // The body read MUST stay inside the retry: SanMar's hangs often
        // happen mid-stream (headers arrive fast, then the body stalls),
        // and AbortSignal.timeout aborts res.text() too.
        status = res.status;
        ok = res.ok;
        text = await res.text();
        break;
      } catch (err) {
        // Hangs/network drops are worth one more try; SOAP faults and
        // API errors below are not.
        lastErr = err;
        text = null;
      }
    }
    if (text === null) {
      throw new SanMarApiError(
        `SanMar request failed: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
        "network",
      );
    }
    const fault = text.match(/<faultstring>([^<]*)<\/faultstring>/);
    if (fault) throw new SanMarApiError(`SanMar SOAP fault: ${fault[1]}`, "fault");
    if (!ok) {
      throw new SanMarApiError(`SanMar HTTP ${status}`, "http", status);
    }
    // Both misspelled and correct forms appear across SanMar services.
    const errOccurred = text.match(/<errorOccur?red>([^<]*)<\/errorOccur?red>/i);
    if (errOccurred && errOccurred[1] === "true") {
      const msg = text.match(/<message>([^<]*)<\/message>/)?.[1] ?? "unknown error";
      if (/authenticat/i.test(msg)) {
        throw new SanMarApiError(`SanMar authentication failed`, "auth");
      }
      // "Invalid style ..." → treated as not-found by callers via empty entries.
      if (/invalid style/i.test(msg)) return text;
      throw new SanMarApiError(`SanMar error: ${msg}`, "http");
    }
    return text;
  }

  /**
   * Fetch catalog entries for a style (all colors/sizes when color omitted).
   * Returns [] when SanMar does not carry the style/color.
   */
  async getProductInfo(style: string, color?: string): Promise<SanMarProductEntry[]> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:impl="${PRODUCT_INFO_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <impl:getProductInfoByStyleColorSize>
      <arg0><style>${xmlEscape(style)}</style><color>${xmlEscape(color ?? "")}</color><size></size></arg0>
      <arg1>
        <sanMarCustomerNumber>${xmlEscape(this.creds.customerNumber)}</sanMarCustomerNumber>
        <sanMarUserName>${xmlEscape(this.creds.username)}</sanMarUserName>
        <sanMarUserPassword>${xmlEscape(this.creds.password)}</sanMarUserPassword>
      </arg1>
    </impl:getProductInfoByStyleColorSize>
  </soapenv:Body>
</soapenv:Envelope>`;

    return parseSanMarProductInfoResponse(await this.soapCall(PRODUCT_INFO_ENDPOINT, body));
  }

  /**
   * Per-warehouse inventory for an exact style+color+size.
   * Quantities align with SANMAR_WAREHOUSES order.
   */
  async getInventory(style: string, catalogColor: string, size: string): Promise<SanMarInventoryResult> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="${INVENTORY_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <web:getInventoryQtyForStyleColorSize>
      <arg0>${xmlEscape(this.creds.customerNumber)}</arg0>
      <arg1>${xmlEscape(this.creds.username)}</arg1>
      <arg2>${xmlEscape(this.creds.password)}</arg2>
      <arg3>${xmlEscape(style)}</arg3>
      <arg4>${xmlEscape(catalogColor)}</arg4>
      <arg5>${xmlEscape(size)}</arg5>
    </web:getInventoryQtyForStyleColorSize>
  </soapenv:Body>
</soapenv:Envelope>`;

    const text = await this.soapCall(INVENTORY_ENDPOINT, body);
    const quantities = (text.match(/<listResponse[^>]*>([^<]*)<\/listResponse>/g) ?? [])
      .map((m) => Number(m.replace(/<[^>]+>/g, "").trim()))
      .map((n) => (Number.isFinite(n) ? n : 0));
    return { quantities, total: quantities.reduce((a, b) => a + b, 0) };
  }

  /**
   * All sellable SanMar style numbers (PromoStandards ProductData
   * getProductSellable — SanMar serves wsVersion 1.0.0; verified live
   * 2026-08-09: ~3,100 unique styles, 13MB response). READ-ONLY. Credentials
   * ride in the SharedObjects namespace like the other PromoStandards calls.
   */
  async getSellableStyles(): Promise<string[]> {
    const ns = "http://www.promostandards.org/WSDL/ProductDataService/1.0.0/";
    const sh = `${ns}SharedObjects/`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Header/><soapenv:Body>
<ns:GetProductSellableRequest xmlns:ns="${ns}" xmlns:sh="${sh}">
<sh:wsVersion>1.0.0</sh:wsVersion><sh:id>${xmlEscape(this.creds.username)}</sh:id><sh:password>${xmlEscape(this.creds.password)}</sh:password>
<sh:isSellable>true</sh:isSellable></ns:GetProductSellableRequest>
</soapenv:Body></soapenv:Envelope>`;
    // The 13MB response takes well past the normal attempt timeouts — one
    // attempt with a generous cap instead of soapCall's fast-fail ladder.
    let text: string;
    try {
      const res = await fetch(
        "https://ws.sanmar.com:8080/promostandards/ProductDataServiceBinding",
        {
          method: "POST",
          headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "getProductSellable" },
          body,
          signal: AbortSignal.timeout(180_000),
        },
      );
      text = await res.text();
      if (!res.ok) {
        const fault = text.match(/<faultstring>([^<]*)<\/faultstring>/)?.[1];
        throw new SanMarApiError(
          fault ? `SanMar SOAP fault: ${xmlDecode(fault)}` : `SanMar HTTP ${res.status}`,
          fault ? "fault" : "http",
          res.status,
        );
      }
    } catch (err) {
      if (err instanceof SanMarApiError) throw err;
      throw new SanMarApiError(
        `SanMar getProductSellable failed: ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    }
    const ids = text.match(/<(?:\w+:)?productId>([^<]*)<\/(?:\w+:)?productId>/g) ?? [];
    return Array.from(new Set(ids.map((x) => xmlDecode(x.replace(/<[^>]+>/g, "").trim())))).filter(
      (s) => s.length > 0,
    );
  }

  /**
   * Submit a purchase order to SanMar (SOAP submitPO).
   *
   * SINGLE ATTEMPT — deliberately NOT retried: a submit that reaches SanMar
   * but whose response is lost would create a duplicate order on retry. A
   * network/read failure is thrown as kind "network" so the caller marks the
   * order "unknown" and reconciles via a status lookup rather than resending.
   *
   * @param opts.test route to the UAT/test environment (places no real order).
   */
  async submitPO(
    input: SanMarPoInput,
    opts: { test?: boolean } = {},
  ): Promise<SanMarPoResult> {
    const endpoint = opts.test ? PO_TEST_ENDPOINT : PO_PROD_ENDPOINT;
    const body = buildSanMarPoEnvelope(this.creds, input);
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' },
        body,
        signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new SanMarApiError(
        `SanMar submitPO network error (ambiguous — order may or may not exist, do NOT retry): ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw new SanMarApiError(
        `SanMar submitPO response read error (ambiguous — do NOT retry): ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    }
    const fault = text.match(/<faultstring>([^<]*)<\/faultstring>/);
    if (fault) throw new SanMarApiError(`SanMar SOAP fault: ${xmlDecode(fault[1])}`, "fault");
    if (!res.ok) throw new SanMarApiError(`SanMar HTTP ${res.status}`, "http", res.status);
    const rawMessage =
      text.match(/<message>([\s\S]*?)<\/message>/)?.[1] ??
      text.match(/<return>([\s\S]*?)<\/return>/)?.[1] ??
      "";
    const message = xmlDecode(rawMessage.trim());
    const errOccurred = text
      .match(/<errorOccur?red>([^<]*)<\/errorOccur?red>/i)?.[1]
      ?.toLowerCase();
    const success =
      errOccurred != null
        ? errOccurred !== "true"
        : /success/i.test(message) && !/error/i.test(message);
    return { success, message: message || "(no message returned)", raw: text };
  }

  /**
   * Validate a PO against SanMar WITHOUT placing an order (SOAP
   * getPreSubmitInfo — same arg0/arg1 shape as submitPO per the WSDL).
   * Read-only, so unlike submitPO it is safe to call repeatedly. Use it to
   * verify envelope structure/eligibility before a live submit.
   */
  async getPreSubmitInfo(input: SanMarPoInput): Promise<SanMarPoResult> {
    const body = buildSanMarPoEnvelope(this.creds, input, "getPreSubmitInfo");
    const text = await this.soapCall(PO_PROD_ENDPOINT, body);
    const rawMessage =
      text.match(/<message>([\s\S]*?)<\/message>/)?.[1] ??
      text.match(/<return>([\s\S]*?)<\/return>/)?.[1] ??
      "";
    const message = xmlDecode(rawMessage.trim());
    const errOccurred = text
      .match(/<errorOccur?red>([^<]*)<\/errorOccur?red>/i)?.[1]
      ?.toLowerCase();
    const success =
      errOccurred != null
        ? errOccurred !== "true"
        : /success/i.test(message) && !/error/i.test(message);
    return { success, message: message || "(no message returned)", raw: text };
  }

  /**
   * Order status by PO number (PromoStandards getOrderStatusDetails, 1.0.0).
   * READ-ONLY and safe to retry. found=false when SanMar has no record of the
   * PO (which can be lag right after submission — never treat it as proof the
   * order doesn't exist).
   */
  async getOrderStatus(poNumber: string): Promise<SanMarOrderStatusResult> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${PS_ORDER_STATUS_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <ns:GetOrderStatusDetailsRequest>
      <ns:wsVersion>1.0.0</ns:wsVersion>
      <ns:id>${xmlEscape(this.creds.username)}</ns:id>
      <ns:password>${xmlEscape(this.creds.password)}</ns:password>
      <ns:queryType>1</ns:queryType>
      <ns:referenceNumber>${xmlEscape(poNumber)}</ns:referenceNumber>
    </ns:GetOrderStatusDetailsRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
    const text = await this.soapCall(
      PS_ORDER_STATUS_ENDPOINT,
      body,
      "getOrderStatusDetails",
    );
    throwOnPromoStandardsError(text, "order status");
    const pick = (block: string, tag: string): string | null => {
      const m = block.match(
        new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`),
      );
      return m ? xmlDecode(m[1].trim()) || null : null;
    };
    const detailBlocks =
      text.match(
        /<(?:\w+:)?OrderStatusDetail>[\s\S]*?<\/(?:\w+:)?OrderStatusDetail>/g,
      ) ?? [];
    const details = detailBlocks.map((b) => ({
      factoryOrderNumber: pick(b, "factoryOrderNumber"),
      statusName: pick(b, "statusName"),
      expectedShipDate: pick(b, "expectedShipDate"),
    }));
    return { found: details.length > 0, details };
  }

  /**
   * Shipment notification / tracking by PO number (PromoStandards
   * getOrderShipmentNotification, 1.0.0). READ-ONLY and safe to retry.
   * found=false until SanMar generates a shipment (typically at ship time).
   */
  async getShipmentNotification(poNumber: string): Promise<SanMarShipmentResult> {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${PS_OSN_NS}" xmlns:sh="${PS_OSN_SHARED_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <ns:GetOrderShipmentNotificationRequest>
      <sh:wsVersion>1.0.0</sh:wsVersion>
      <sh:id>${xmlEscape(this.creds.username)}</sh:id>
      <sh:password>${xmlEscape(this.creds.password)}</sh:password>
      <ns:queryType>1</ns:queryType>
      <ns:referenceNumber>${xmlEscape(poNumber)}</ns:referenceNumber>
    </ns:GetOrderShipmentNotificationRequest>
  </soapenv:Body>
</soapenv:Envelope>`;
    const text = await this.soapCall(
      PS_OSN_ENDPOINT,
      body,
      "getOrderShipmentNotification",
    );
    throwOnPromoStandardsError(text, "shipment notification");
    const pick = (block: string, tag: string): string | null => {
      const m = block.match(
        new RegExp(`<(?:\\w+:)?${tag}>([\\s\\S]*?)</(?:\\w+:)?${tag}>`),
      );
      return m ? xmlDecode(m[1].trim()) || null : null;
    };
    const notif = text.match(
      /<(?:\w+:)?OrderShipmentNotification>[\s\S]*?<\/(?:\w+:)?OrderShipmentNotification>/,
    )?.[0];
    if (!notif) return { found: false, complete: null, packages: [] };
    const completeRaw = pick(notif, "complete");
    const packages: SanMarShipmentResult["packages"] = [];
    const salesOrders =
      notif.match(/<(?:\w+:)?SalesOrder>[\s\S]*?<\/(?:\w+:)?SalesOrder>/g) ?? [];
    for (const so of salesOrders) {
      const orderNumber = pick(so, "salesOrderNumber");
      const pkgBlocks =
        so.match(/<(?:\w+:)?Package>[\s\S]*?<\/(?:\w+:)?Package>/g) ?? [];
      for (const pkg of pkgBlocks) {
        packages.push({
          orderNumber,
          carrier: pick(pkg, "carrier"),
          trackingNumber: pick(pkg, "trackingNumber"),
          shipMethod: pick(pkg, "shipmentMethod"),
          shipmentDate: pick(pkg, "shipmentDate"),
        });
      }
    }
    return {
      found: true,
      complete: completeRaw == null ? null : completeRaw === "true",
      packages,
    };
  }
}

/** Parse the Product Info SOAP payload into the catalog-facing read model. */
export function parseSanMarProductInfoResponse(text: string): SanMarProductEntry[] {
  const blocks = text.match(/<listResponse>[\s\S]*?<\/listResponse>/g) ?? [];
  const entries: SanMarProductEntry[] = [];
  for (const block of blocks) {
    const basic = block.match(/<productBasicInfo>([\s\S]*?)<\/productBasicInfo>/)?.[1];
    const price = block.match(/<productPriceInfo>([\s\S]*?)<\/productPriceInfo>/)?.[1];
    const image = block.match(/<productImageInfo>([\s\S]*?)<\/productImageInfo>/)?.[1];
    if (!basic) continue;
    const entryStyle = tag(basic, "style");
    const catalogColor = tag(basic, "catalogColor") ?? tag(basic, "color");
    const size = tag(basic, "size");
    if (!entryStyle || !catalogColor || !size) continue;
    entries.push({
      style: entryStyle,
      catalogColor,
      size,
      sizeIndex: num(tag(basic, "sizeIndex")),
      inventoryKey: tag(basic, "inventoryKey"),
      uniqueKey: tag(basic, "uniqueKey"),
      brandName: tag(basic, "brandName"),
      productTitle: tag(basic, "productTitle"),
      productDescription: tag(basic, "productDescription"),
      category: tag(basic, "category"),
      caseSize: num(tag(basic, "caseSize")),
      piecePrice: price ? num(tag(price, "piecePrice")) : null,
      pieceSalePrice: price ? num(tag(price, "pieceSalePrice")) : null,
      casePrice: price ? num(tag(price, "casePrice")) : null,
      caseSalePrice: price ? num(tag(price, "caseSalePrice")) : null,
      saleStartDate: price ? tag(price, "saleStartDate") : null,
      saleEndDate: price ? tag(price, "saleEndDate") : null,
      priceText: price ? tag(price, "priceText") : null,
      colorSwatchImage: image ? tag(image, "colorSquareImage") : null,
      colorProductImage: image ? tag(image, "colorProductImage") : null,
    });
  }
  return entries;
}

/**
 * PromoStandards services report problems via ServiceMessageArray (severity
 * Error/Warning), not SanMar's errorOccured flag — surface Errors as thrown
 * SanMarApiError so callers never mistake an error response for "not found".
 */
function throwOnPromoStandardsError(text: string, label: string): void {
  const messages =
    text.match(/<(?:\w+:)?ServiceMessage>[\s\S]*?<\/(?:\w+:)?ServiceMessage>/g) ?? [];
  for (const m of messages) {
    const severity =
      m.match(/<(?:\w+:)?severity>([^<]*)<\/(?:\w+:)?severity>/)?.[1] ?? "";
    if (!/error/i.test(severity)) continue;
    const desc =
      m.match(/<(?:\w+:)?description>([\s\S]*?)<\/(?:\w+:)?description>/)?.[1] ??
      "unknown error";
    const kind = /authenticat|password|credential/i.test(desc) ? "auth" : "http";
    throw new SanMarApiError(
      `SanMar ${label} error: ${xmlDecode(desc.trim())}`,
      kind,
    );
  }
}
