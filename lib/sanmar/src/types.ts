export interface SanMarCredentials {
  customerNumber: string;
  username: string;
  password: string;
}

export interface SanMarProductEntry {
  style: string;
  catalogColor: string;
  size: string;
  sizeIndex: number | null;
  inventoryKey: string | null;
  uniqueKey: string | null;
  brandName: string | null;
  productTitle: string | null;
  caseSize: number | null;
  /** Regular account NET piece cost — THE cost figure for POs (not MSRP). */
  piecePrice: number | null;
  /** Promotional piece price — populated ONLY during a dated sale, else null. */
  pieceSalePrice: number | null;
  casePrice: number | null;
  caseSalePrice: number | null;
  saleStartDate: string | null;
  saleEndDate: string | null;
  priceText: string | null;
  /** Small color-square swatch image (productImageInfo.colorSquareImage) — absolute CDN URL. */
  colorSwatchImage: string | null;
  /** Product photo in this color (productImageInfo.colorProductImage) — absolute CDN URL. */
  colorProductImage: string | null;
}

export interface SanMarInventoryResult {
  /** Quantity per warehouse, aligned with SANMAR_WAREHOUSES order. */
  quantities: number[];
  total: number;
}

export interface SanMarPoLine {
  style: string;
  color: string;
  size: string;
  sizeIndex: number | null;
  inventoryKey: string | null;
  quantity: number;
  /** SanMar warehouse number (see SANMAR_WAREHOUSES). */
  whseNo: number;
}

/**
 * PO header + lines for submitPO. Credentials are supplied separately to the
 * client and are NEVER part of this payload (which gets persisted). SanMar
 * limits: poNumber ≤ 12 chars, shipTo ≤ 28, address/attention ≤ 35, city ≤ 28.
 */
export interface SanMarPoInput {
  poNumber: string;
  attention?: string | null;
  notes?: string | null;
  /** Ship-to company name. */
  shipTo: string;
  shipAddress1: string;
  shipAddress2?: string | null;
  shipCity: string;
  /** 2-letter state code. */
  shipState: string;
  /** 5- or 9-digit ZIP. */
  shipZip: string;
  /** Already mapped to SanMar's carrier string (see SANMAR_SHIP_METHODS). */
  shipMethod: string;
  shipEmail?: string | null;
  residential: boolean;
  lines: SanMarPoLine[];
}

export interface SanMarPoResult {
  success: boolean;
  message: string;
  raw: string;
}

/** One status line from PromoStandards getOrderStatusDetails. */
export interface SanMarOrderStatusDetail {
  /** SanMar's internal sales-order number for this PO. */
  factoryOrderNumber: string | null;
  statusName: string | null;
  expectedShipDate: string | null;
}

export interface SanMarOrderStatusResult {
  /** false = SanMar has no record of this PO number. */
  found: boolean;
  details: SanMarOrderStatusDetail[];
}

/** One shipped package from PromoStandards getOrderShipmentNotification. */
export interface SanMarShipmentPackage {
  /** SanMar sales-order number the package belongs to. */
  orderNumber: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  shipMethod: string | null;
  shipmentDate: string | null;
}

export interface SanMarShipmentResult {
  /** false = no shipment notification exists (yet) for this PO number. */
  found: boolean;
  /** All shipments for the PO are complete (null when not reported). */
  complete: boolean | null;
  packages: SanMarShipmentPackage[];
}

/** Our canonical ship-method codes → SanMar carrier strings. */
export const SANMAR_SHIP_METHODS: Record<string, string> = {
  GROUND: "UPS",
  "2DAY": "UPS 2ND DAY",
  OVERNIGHT: "UPS NEXT DAY",
};

export const SANMAR_WAREHOUSES = [
  { whseNo: 1, name: "Seattle, WA" },
  { whseNo: 2, name: "Cincinnati, OH" },
  { whseNo: 3, name: "Dallas, TX" },
  { whseNo: 4, name: "Reno, NV" },
  { whseNo: 5, name: "Robbinsville, NJ" },
  { whseNo: 6, name: "Jacksonville, FL" },
  { whseNo: 7, name: "Minneapolis, MN" },
  { whseNo: 12, name: "Phoenix, AZ" },
  { whseNo: 31, name: "Richmond, VA" },
] as const;
