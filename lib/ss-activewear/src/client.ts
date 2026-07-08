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
}

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
}
