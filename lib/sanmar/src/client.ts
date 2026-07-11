import type {
  SanMarCredentials,
  SanMarProductEntry,
  SanMarInventoryResult,
  SanMarPoInput,
  SanMarPoResult,
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
 * Build the submitPO SOAP envelope. Kept as a standalone pure function so the
 * dry-run path can render a preview without a client/network. Credentials are
 * injected here and only here — they are NEVER part of the persisted payload.
 *
 * Field structure per the SanMar PO Integration Guide v24.3 (poNum ≤ 12 chars,
 * shipTo ≤ 28, shipAddress1/attention ≤ 35, shipCity ≤ 28, shipState 2-letter,
 * one <webServicePoDetailList> per line). Validate against PO_TEST_ENDPOINT
 * before any live submission.
 */
export function buildSanMarPoEnvelope(
  creds: SanMarCredentials,
  input: SanMarPoInput,
): string {
  const details = input.lines
    .map(
      (l) => `
        <webServicePoDetailList>
          <style>${xmlEscape(l.style)}</style>
          <color>${xmlEscape(l.color)}</color>
          <size>${xmlEscape(l.size)}</size>${
            l.sizeIndex != null
              ? `\n          <sizeIndex>${l.sizeIndex}</sizeIndex>`
              : ""
          }${
            l.inventoryKey
              ? `\n          <inventoryKey>${xmlEscape(l.inventoryKey)}</inventoryKey>`
              : ""
          }
          <quantity>${l.quantity}</quantity>
          <whseNo>${l.whseNo}</whseNo>
        </webServicePoDetailList>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="${PO_NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <web:submitPO>
      <arg0>
        <sanMarCustomerNumber>${xmlEscape(creds.customerNumber)}</sanMarCustomerNumber>
        <sanMarUserName>${xmlEscape(creds.username)}</sanMarUserName>
        <sanMarUserPassword>${xmlEscape(creds.password)}</sanMarUserPassword>
        <poNum>${xmlEscape(input.poNumber)}</poNum>${
          input.attention
            ? `\n        <attention>${xmlEscape(input.attention)}</attention>`
            : ""
        }${input.notes ? `\n        <notes>${xmlEscape(input.notes)}</notes>` : ""}
        <shipTo>${xmlEscape(input.shipTo)}</shipTo>
        <shipAddress1>${xmlEscape(input.shipAddress1)}</shipAddress1>${
          input.shipAddress2
            ? `\n        <shipAddress2>${xmlEscape(input.shipAddress2)}</shipAddress2>`
            : ""
        }
        <shipCity>${xmlEscape(input.shipCity)}</shipCity>
        <shipState>${xmlEscape(input.shipState)}</shipState>
        <shipZip>${xmlEscape(input.shipZip)}</shipZip>
        <shipMethod>${xmlEscape(input.shipMethod)}</shipMethod>${
          input.shipEmail
            ? `\n        <shipEmail>${xmlEscape(input.shipEmail)}</shipEmail>`
            : ""
        }
        <residence>${input.residential ? "Y" : "N"}</residence>${details}
      </arg0>
    </web:submitPO>
  </soapenv:Body>
</soapenv:Envelope>`;
}

export class SanMarClient {
  constructor(private readonly creds: SanMarCredentials) {}

  private async soapCall(endpoint: string, body: string): Promise<string> {
    let text: string | null = null;
    let status = 0;
    let ok = false;
    let lastErr: unknown = null;
    for (const timeoutMs of ATTEMPT_TIMEOUTS_MS) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' },
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

    const text = await this.soapCall(PRODUCT_INFO_ENDPOINT, body);
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
}
