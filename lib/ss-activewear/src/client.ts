const BASE_URL = "https://api.ssactivewear.com/v2";

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
  raw: unknown;
}

/** One order returned by GET /orders/{poNumber} (status/tracking lookup). */
export interface SSOrderInfo {
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
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class SSClient {
  private readonly authHeader: string;

  constructor(creds: SSCredentials, private readonly timeoutMs = 12_000) {
    this.authHeader = `Basic ${Buffer.from(`${creds.accountNumber}:${creds.apiKey}`).toString("base64")}`;
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        headers: { Authorization: this.authHeader, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SSApiError(
        `S&S request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw new SSApiError(`S&S HTTP ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  }

  /** Search styles by style number / name. Returns [] when nothing matches. */
  async searchStyles(term: string): Promise<SSStyle[]> {
    const raw = await this.get<unknown>(`/styles/?search=${encodeURIComponent(term)}`);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
      .map((s) => ({
        styleID: Number(s.styleID),
        styleName: String(s.styleName ?? ""),
        brandName: String(s.brandName ?? ""),
        title: s.title ? String(s.title) : null,
        styleImage: s.styleImage ? String(s.styleImage) : null,
      }))
      .filter((s) => Number.isFinite(s.styleID));
  }

  /** All SKUs (color × size) for a styleID, incl. pricing + per-warehouse inventory. */
  async getProducts(styleID: number): Promise<SSProduct[]> {
    const raw = await this.get<unknown>(`/products/?styleid=${styleID}`);
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p): p is Record<string, unknown> => typeof p === "object" && p !== null)
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
   * Field names parsed defensively (not yet validated against a real S&S
   * order — none has been placed as of 2026-07-13).
   */
  async getOrders(poNumber: string): Promise<SSOrderLookupResult> {
    const raw = await this.get<unknown>(
      `/orders/${encodeURIComponent(poNumber)}?lines=false`,
    );
    const arr = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
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
        orderNumber: str(o, "orderNumber", "OrderNumber"),
        orderStatus: str(o, "orderStatus", "OrderStatus"),
        trackingNumber: str(o, "trackingNumber", "TrackingNumber"),
        shippingCarrier: str(o, "shippingCarrier", "ShippingCarrier"),
        shippingMethod: str(o, "shippingMethod", "ShippingMethod"),
        shipDate: str(o, "shipDate", "ShipDate", "shippingDate"),
      }));
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
    const orders = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
    const orderNumbers = orders
      .map((o) =>
        o && typeof o === "object" && "orderNumber" in o
          ? String((o as { orderNumber: unknown }).orderNumber)
          : null,
      )
      .filter((n): n is string => !!n && n !== "null" && n !== "undefined");
    return { orderNumbers, raw };
  }
}
