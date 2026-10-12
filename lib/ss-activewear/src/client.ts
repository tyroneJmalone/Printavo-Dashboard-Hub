const BASE_URL = "https://api.ssactivewear.com/v2";
const READ_RETRY_STATUSES = new Set([429, 502, 503, 504]);

/**
 * S&S order endpoints don't return a bare array of orders as the docs imply —
 * a real POST /orders response (first live order, 2026-07-16) came wrapped as
 * `{ orders: [...], lineErrors: [...] }`. Normalize wrapper / bare array /
 * single object to an array of order records.
 */
function unwrapOrders(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw != null && typeof raw === "object") {
    const orders = (raw as { orders?: unknown }).orders;
    if (Array.isArray(orders)) return orders;
    return [raw];
  }
  return [];
}

/**
 * Summarize the wrapper's lineErrors array (shape not fully documented —
 * parsed defensively). Returns null when there are no line errors.
 */
function summarizeLineErrors(raw: unknown): string | null {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const lineErrors = (raw as { lineErrors?: unknown }).lineErrors;
  if (!Array.isArray(lineErrors) || lineErrors.length === 0) return null;
  const parts = lineErrors.slice(0, 10).map((e) => {
    if (e == null) return "unknown line error";
    if (typeof e === "string") return e;
    if (typeof e === "object") {
      const o = e as Record<string, unknown>;
      const msg = ["message", "error", "errorMessage", "description"]
        .map((k) => o[k])
        .find((v) => typeof v === "string" && v.trim() !== "");
      const ident = ["identifier", "sku", "lineNumber"]
        .map((k) => o[k])
        .find((v) => v != null && String(v).trim() !== "");
      if (msg) return ident != null ? `${String(ident)}: ${String(msg)}` : String(msg);
      try {
        return JSON.stringify(e).slice(0, 200);
      } catch {
        return "unparseable line error";
      }
    }
    return String(e);
  });
  const more = lineErrors.length > 10 ? ` (+${lineErrors.length - 10} more)` : "";
  return `${lineErrors.length} line error(s): ${parts.join("; ")}${more}`;
}

export interface SSCredentials {
  accountNumber: string;
  apiKey: string;
}

export interface SSStyle {
  styleID: number;
  styleName: string;
  brandName: string;
  title: string | null;
  /** Style hero image — RELATIVE path (prefix https://www.ssactivewear.com/). */
  styleImage: string | null;
}

/** Catalog-level style record from GET /styles/ (full-catalog import). */
export interface SSCatalogStyle {
  styleID: number;
  styleName: string;
  brandName: string;
  title: string | null;
  description: string | null;
  baseCategory: string | null;
  /** RELATIVE path (prefix https://www.ssactivewear.com/). */
  styleImage: string | null;
}

export interface SSWarehouseQty {
  warehouseAbbr: string;
  qty: number;
}

export interface SSProduct {
  sku: string;
  colorName: string;
  sizeName: string;
  /** Regular dealer price — the baseline cost. */
  piecePrice: number | null;
  /** Promo price; genuine only if >0, < piecePrice, and saleExpiration set. */
  salePrice: number | null;
  /** Mirrors salePrice during sales — never use as regular baseline. */
  customerPrice: number | null;
  saleExpiration: string | null;
  qty: number;
  warehouses: SSWarehouseQty[];
  /** Color swatch image — RELATIVE path (prefix https://www.ssactivewear.com/). */
  colorSwatchImage: string | null;
  /** Front product photo in this color — RELATIVE path (same prefix). */
  colorFrontImage: string | null;
}

export interface SSPoLine {
  /** S&S "identifier" — the SKU. */
  identifier: string;
  qty: number;
  /** Warehouse abbr to ship from (autoselectWarehouse stays false). */
  warehouseAbbr: string;
}

export interface SSShippingAddress {
  customer: string;
  attn?: string | null;
  address: string;
  city: string;
  state: string;
  /** 5-digit ZIP. */
  zip: string;
  residential: boolean;
}

export interface SSOrderInput {
  poNumber: string;
  shippingAddress: SSShippingAddress;
  /** S&S code: "1" ground, "2" next day, "3" 2nd day (see SS_SHIP_METHODS). */
  shippingMethod: string;
  emailConfirmation?: string | null;
  lines: SSPoLine[];
}

export interface SSOrderResult {
  /** S&S order numbers — one order can split across warehouses → several. */
  orderNumbers: string[];
  /** Human-readable summary of the wrapper's lineErrors array (null if none). */
  lineErrorSummary: string | null;
  raw: unknown;
}

/** One order returned by GET /orders/{poNumber} (status/tracking lookup). */
export interface SSOrderInfo {
  poNumber?: string | null;
  orderDate?: string | null;
  warehouse?: string | null;
  deliveryStatus?: string | null;
  orderNumber: string | null;
  /** e.g. "In Progress", "Shipped", "Cancelled" — S&S's own wording. */
  orderStatus: string | null;
  trackingNumber: string | null;
  shippingCarrier: string | null;
  shippingMethod: string | null;
  shipDate: string | null;
}

export interface SSOrderLookupResult {
  /** false = S&S has no record for this PO number (can be lag — not proof). */
  found: boolean;
  orders: SSOrderInfo[];
}

/** Our canonical ship-method codes → S&S shippingMethod codes. */
export const SS_SHIP_METHODS: Record<string, string> = {
  GROUND: "1",
  OVERNIGHT: "2",
  "2DAY": "3",
};

export class SSApiError extends Error {
  constructor(
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "SSApiError";
  }
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function safeHttpError(status: number): string {
  if (status === 401) return "S&S authentication failed (HTTP 401)";
  if (status === 403) return "S&S account is not authorized for this catalog request (HTTP 403)";
  if (status === 404) return "S&S catalog endpoint was not found (HTTP 404)";
  if (status === 429) return "S&S rate limit reached (HTTP 429)";
  if (status >= 500) return `S&S service is temporarily unavailable (HTTP ${status})`;
  return `S&S catalog request failed (HTTP ${status})`;
}

function expectArray(raw: unknown, resource: string): Record<string, unknown>[] {
  if (!Array.isArray(raw)) {
    throw new SSApiError(`S&S returned an unexpected ${resource} response`);
  }
  return raw.filter(
    (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
  );
}

export class SSClient {
  private readonly authHeader: string;

  constructor(creds: SSCredentials, private readonly timeoutMs = 12_000) {
    this.authHeader = `Basic ${Buffer.from(`${creds.accountNumber}:${creds.apiKey}`).toString("base64")}`;
  }

  private async get<T>(path: string, timeoutMs = this.timeoutMs): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(`${BASE_URL}${path}`, {
          headers: { Authorization: this.authHeader, Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt === 0) continue;
        const timedOut =
          err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
        throw new SSApiError(
          timedOut
            ? `S&S catalog request timed out after ${timeoutMs}ms`
            : "S&S catalog request could not reach the vendor",
        );
      }
      if (!res.ok) {
        if (attempt === 0 && READ_RETRY_STATUSES.has(res.status)) continue;
        throw new SSApiError(safeHttpError(res.status), res.status);
      }
      try {
        return (await res.json()) as T;
      } catch {
        throw new SSApiError("S&S returned an unreadable catalog response");
      }
    }
    throw new SSApiError("S&S catalog request failed");
  }

  /** Search styles by style number / name. Returns [] when nothing matches. */
  async searchStyles(term: string): Promise<SSStyle[]> {
    const raw = await this.get<unknown>(`/styles/?search=${encodeURIComponent(term)}`);
    return expectArray(raw, "styles")
      .map((s) => ({
        styleID: Number(s.styleID),
        styleName: String(s.styleName ?? ""),
        brandName: String(s.brandName ?? ""),
        title: s.title ? String(s.title) : null,
        styleImage: s.styleImage ? String(s.styleImage) : null,
      }))
      .filter((s) => Number.isFinite(s.styleID));
  }

  /**
   * The ENTIRE S&S style catalog in one call (~5,600 styles, verified live
   * 2026-08-09). Slow-moving catalog data for the local catalog import —
   * per-style colors/prices still come from getProducts().
   */
  async listAllStyles(): Promise<SSCatalogStyle[]> {
    const raw = await this.get<unknown>(`/styles/`, 120_000);
    return expectArray(raw, "styles")
      .map((s) => ({
        styleID: Number(s.styleID),
        styleName: String(s.styleName ?? ""),
        brandName: String(s.brandName ?? ""),
        title: s.title ? String(s.title) : null,
        /** HTML bullet list — strip tags before storing/searching. */
        description: s.description ? String(s.description) : null,
        baseCategory: s.baseCategory ? String(s.baseCategory) : null,
        styleImage: s.styleImage ? String(s.styleImage) : null,
      }))
      .filter((s) => Number.isFinite(s.styleID) && s.styleName.length > 0);
  }

  /** All SKUs (color × size) for a styleID, incl. pricing + per-warehouse inventory. */
  async getProducts(styleID: number): Promise<SSProduct[]> {
    const raw = await this.get<unknown>(`/products/?styleid=${styleID}`);
    return expectArray(raw, "products")
      .map((p) => ({
        sku: String(p.sku ?? ""),
        colorName: String(p.colorName ?? ""),
        sizeName: String(p.sizeName ?? ""),
        piecePrice: toNum(p.piecePrice),
        salePrice: toNum(p.salePrice),
        customerPrice: toNum(p.customerPrice),
        saleExpiration: p.saleExpiration ? String(p.saleExpiration) : null,
        qty: toNum(p.qty) ?? 0,
        colorSwatchImage: p.colorSwatchImage ? String(p.colorSwatchImage) : null,
        colorFrontImage: p.colorFrontImage ? String(p.colorFrontImage) : null,
        warehouses: Array.isArray(p.warehouses)
          ? p.warehouses
              .filter((w): w is Record<string, unknown> => typeof w === "object" && w !== null)
              .map((w) => ({
                warehouseAbbr: String(w.warehouseAbbr ?? ""),
                qty: toNum(w.qty) ?? 0,
              }))
          : [],
      }))
      .filter((p) => p.sku.length > 0);
  }

  /**
   * Status/tracking lookup by PO number (GET /orders/{poNumber}). READ-ONLY
   * and safe to retry. Returns found=false on an empty array — that can be
   * vendor lag right after submission, never proof the order doesn't exist.
   * Field names match the real submit response observed 2026-07-16
   * (camelCase: orderNumber/orderStatus/trackingNumber/...).
   */
  async getOrders(poNumber: string): Promise<SSOrderLookupResult> {
    const raw = await this.get<unknown>(
      `/orders/${encodeURIComponent(poNumber)}?lines=false`,
    );
    const arr = unwrapOrders(raw);
    const str = (o: Record<string, unknown>, ...keys: string[]): string | null => {
      for (const k of keys) {
        const v = o[k];
        if (v != null && String(v).trim() !== "") return String(v).trim();
      }
      return null;
    };
    const orders = arr
      .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
      .map((o) => ({
        poNumber: str(o, "poNumber", "PONumber"),
        orderDate: str(o, "orderDate", "OrderDate"),
        warehouse: str(o, "warehouseAbbr", "WarehouseAbbr"),
        deliveryStatus: str(o, "deliveryStatus", "DeliveryStatus"),
        orderNumber: str(o, "orderNumber", "OrderNumber"),
        orderStatus: str(o, "orderStatus", "OrderStatus"),
        trackingNumber: str(o, "trackingNumber", "TrackingNumber"),
        shippingCarrier: str(o, "shippingCarrier", "ShippingCarrier"),
        shippingMethod: str(o, "shippingMethod", "ShippingMethod"),
        shipDate: str(o, "shipDate", "ShipDate", "shippingDate"),
      }))
      // Only entries with a real order number or status count — a stray
      // non-order object (e.g. {"message": ...} via the [raw] fallback) must
      // NOT flip found=true: found feeds the unknown→submitted auto-reconcile.
      .filter((o) => o.orderNumber !== null || o.orderStatus !== null);
    return { found: orders.length > 0, orders };
  }

  /** Read-only discovery; filter by orderDate, not invoice or shipping date. */
  async getRecentOrders(since: Date): Promise<SSOrderLookupResult> {
    const raw = await this.get<unknown>("/orders/?All=True&lines=false&fields=orderNumber,poNumber,orderDate,orderStatus,shipDate");
    if (!Array.isArray(raw) && !(raw && typeof raw === "object" && Array.isArray((raw as {orders?:unknown}).orders))) {
      throw new SSApiError("Unexpected S&S order history response");
    }
    const orders = unwrapOrders(raw)
      .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
      .filter(o => {
        const date = Date.parse(String(o.orderDate ?? ""));
        if (!Number.isFinite(date)) throw new SSApiError("S&S order history is missing an order date");
        return date >= since.getTime() && date <= Date.now();
      })
      .map(o => ({
        orderNumber: String(o.orderNumber ?? ""),
        poNumber: String(o.poNumber ?? ""),
        orderDate: String(o.orderDate),
        warehouse: o.warehouseAbbr == null ? null : String(o.warehouseAbbr),
        deliveryStatus: o.deliveryStatus == null ? null : String(o.deliveryStatus),
        orderStatus: o.orderStatus == null ? null : String(o.orderStatus),
        trackingNumber: o.trackingNumber == null ? null : String(o.trackingNumber),
        shippingCarrier: o.shippingCarrier == null ? null : String(o.shippingCarrier),
        shippingMethod: o.shippingMethod == null ? null : String(o.shippingMethod),
        shipDate: o.shipDate == null ? null : String(o.shipDate),
      }));
    if (orders.some(o => !o.orderNumber)) throw new SSApiError("S&S history contains an order without an identifier");
    return { found: orders.length > 0, orders };
  }

  /**
   * Place an order with S&S (POST /orders).
   *
   * SINGLE ATTEMPT — deliberately NOT retried: a lost response after the order
   * was accepted would double-order. A network failure throws (caller marks
   * the order "unknown" and reconciles). The response is an ARRAY of orders
   * (S&S splits across warehouses).
   *
   * @param opts.test send testOrder=true (S&S creates then immediately cancels).
   */
  async submitOrder(
    input: SSOrderInput,
    opts: { test?: boolean } = {},
  ): Promise<SSOrderResult> {
    const body = {
      poNumber: input.poNumber,
      testOrder: opts.test === true,
      autoselectWarehouse: false,
      // false = fill the lines we can and report per-line errors, rather than
      // rejecting the whole order.
      rejectLineErrors: false,
      shippingMethod: input.shippingMethod,
      emailConfirmation: input.emailConfirmation ?? "",
      shippingAddress: {
        customer: input.shippingAddress.customer,
        attn: input.shippingAddress.attn ?? "",
        address: input.shippingAddress.address,
        city: input.shippingAddress.city,
        state: input.shippingAddress.state,
        zip: input.shippingAddress.zip,
        residential: input.shippingAddress.residential,
      },
      lines: input.lines.map((l) => ({
        identifier: l.identifier,
        qty: l.qty,
        warehouseAbbr: l.warehouseAbbr,
      })),
    };
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/orders/`, {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SSApiError(
        `S&S order network error (ambiguous — order may or may not exist, do NOT retry): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const raw = await res.json().catch(() => null);
    if (!res.ok) {
      const msg =
        raw && typeof raw === "object" && "message" in raw
          ? String((raw as { message: unknown }).message)
          : `S&S HTTP ${res.status}`;
      throw new SSApiError(msg, res.status);
    }
    const orders = unwrapOrders(raw);
    const orderNumbers = orders
      .map((o) =>
        o && typeof o === "object" && "orderNumber" in o
          ? String((o as { orderNumber: unknown }).orderNumber)
          : null,
      )
      .filter((n): n is string => !!n && n !== "null" && n !== "undefined");
    return { orderNumbers, lineErrorSummary: summarizeLineErrors(raw), raw };
  }
}
