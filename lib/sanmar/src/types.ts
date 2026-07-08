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
  /** MSRP / catalog price — do NOT use as cost. */
  piecePrice: number | null;
  /** Account net cost — THE cost figure for POs. */
  pieceSalePrice: number | null;
  casePrice: number | null;
  caseSalePrice: number | null;
  saleStartDate: string | null;
  saleEndDate: string | null;
  priceText: string | null;
}

export interface SanMarInventoryResult {
  /** Quantity per warehouse, aligned with SANMAR_WAREHOUSES order. */
  quantities: number[];
  total: number;
}

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
