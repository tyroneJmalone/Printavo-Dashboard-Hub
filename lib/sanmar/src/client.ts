import type {
  SanMarCredentials,
  SanMarProductEntry,
  SanMarInventoryResult,
} from "./types";

const PRODUCT_INFO_ENDPOINT =
  "https://ws.sanmar.com:8080/SanMarWebService/SanMarProductInfoServicePort";
const INVENTORY_ENDPOINT =
  "https://ws.sanmar.com:8080/SanMarWebService/SanMarWebServicePort";
const PRODUCT_INFO_NS = "http://impl.webservice.integration.sanmar.com/";
const INVENTORY_NS = "http://webservice.integration.sanmar.com/";

export class SanMarApiError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth" | "fault" | "http" | "network" = "http",
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

export class SanMarClient {
  constructor(
    private readonly creds: SanMarCredentials,
    private readonly timeoutMs = 30_000,
  ) {}

  private async soapCall(endpoint: string, body: string): Promise<string> {
    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '""' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SanMarApiError(
        `SanMar request failed: ${err instanceof Error ? err.message : String(err)}`,
        "network",
      );
    }
    const text = await res.text();
    const fault = text.match(/<faultstring>([^<]*)<\/faultstring>/);
    if (fault) throw new SanMarApiError(`SanMar SOAP fault: ${fault[1]}`, "fault");
    if (!res.ok) {
      throw new SanMarApiError(`SanMar HTTP ${res.status}`, "http");
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
}
