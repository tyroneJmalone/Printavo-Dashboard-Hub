export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface Connection<T> {
  nodes: T[];
  pageInfo: PageInfo;
}

export interface PvTimestamps {
  createdAt: string;
  updatedAt: string;
}

export interface PvStatusRef {
  id: string;
  name: string;
}

export interface PvOwnerRef {
  id: string;
  email: string | null;
}

export interface PvCustomerRef {
  id: string;
  companyName: string | null;
}

export interface PvContactRef {
  id: string;
  fullName: string | null;
  email: string | null;
  customer: PvCustomerRef | null;
}

export interface PvOrderNode {
  id: string;
  visualId: number;
  nickname: string | null;
  total: number | null;
  subtotal: number | null;
  amountPaid: number | null;
  amountOutstanding: number | null;
  customerDueAt: string | null;
  /** User-editable invoice date (date-only, defaults to creation date). */
  invoiceAt: string | null;
  /** Production due date (full datetime; usually a few days before customerDueAt). */
  dueAt: string | null;
  /** Payment due date (date-only, defaults to invoiceAt). */
  paymentDueAt: string | null;
  publicUrl: string | null;
  workorderUrl: string | null;
  customerNote: string | null;
  productionNote: string | null;
  tags: string[] | null;
  status: PvStatusRef | null;
  owner: PvOwnerRef | null;
  contact: PvContactRef | null;
  timestamps: PvTimestamps;
}

export interface PvCustomerNode {
  id: string;
  companyName: string | null;
  owner: PvOwnerRef | null;
  primaryContact: {
    id: string;
    fullName: string | null;
    email: string | null;
  } | null;
  timestamps: PvTimestamps;
}

export interface PvContactNode {
  id: string;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  customer: PvCustomerRef | null;
  timestamps: PvTimestamps;
}

export interface PvStatusNode {
  id: string;
  name: string;
  color?: string | null;
  position?: number | null;
}

export interface PvSizeEntry {
  size: string;
  count: number;
}

export interface PvCategoryRef {
  id: string;
  name: string | null;
}

export interface PvProductRef {
  id: string;
  brand: string | null;
}

export interface PvLineItemNode {
  id: string;
  itemNumber: string | null;
  color: string | null;
  description: string | null;
  items: number;
  price: number | null;
  merch: boolean;
  productStatus: string | null;
  sizes: PvSizeEntry[] | null;
  category: PvCategoryRef | null;
  product: PvProductRef | null;
}

export interface PvImprintNode {
  id: string;
  details: string | null;
  pricingMatrixColumn: {
    id: string;
    columnName: string | null;
    matrix: { id: string; name: string | null } | null;
  } | null;
  typeOfWork: { id: string; name: string | null } | null;
}

/** Nested connection in detail queries — inner pageInfo has no endCursor. */
export interface NestedConnection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean };
}

export interface PvLineItemGroupNode {
  id: string;
  position: number | null;
  lineItems: NestedConnection<PvLineItemNode>;
  imprints: NestedConnection<PvImprintNode>;
}

export interface PvOrderDetailNode {
  id: string;
  visualId: number;
  totalQuantity: number | null;
  timestamps: PvTimestamps;
  lineItemGroups: NestedConnection<PvLineItemGroupNode>;
}

export interface InvoicesDetailPage {
  invoices: Connection<PvOrderDetailNode>;
}

export interface QuotesDetailPage {
  quotes: Connection<PvOrderDetailNode>;
}

export interface SingleOrderDetail {
  invoice?: PvOrderDetailNode | null;
  quote?: PvOrderDetailNode | null;
}

export interface PvSweepLineItemNode {
  id: string;
  productStatus: string | null;
}

export interface PvSweepGroupNode {
  id: string;
  lineItems: NestedConnection<PvSweepLineItemNode>;
}

export interface PvSweepOrderNode {
  id: string;
  timestamps: PvTimestamps;
  lineItemGroups: NestedConnection<PvSweepGroupNode>;
}

export interface ProductStatusSweepPage {
  invoices: Connection<PvSweepOrderNode>;
}

export type PvTransactionTypename =
  | "Payment"
  | "PaymentDispute"
  | "Refund"
  | "Return"
  | "Void";

export interface PvTransactedForRef {
  __typename: "Invoice" | "Quote" | "MerchOrder";
  id: string;
  visualId?: number;
}

export interface PvTransactionNode {
  __typename: PvTransactionTypename;
  id: string;
  amount: number | null;
  category: string | null;
  description: string | null;
  processing: boolean | null;
  transactionDate: string | null;
  timestamps: PvTimestamps;
  transactedFor: PvTransactedForRef | null;
  /** Payment only */
  source?: string | null;
  /** PaymentDispute only */
  status?: string | null;
}

export interface TransactionsPage {
  transactions: Connection<PvTransactionNode>;
}

export interface InvoicesPage {
  invoices: Connection<PvOrderNode>;
}

export interface QuotesPage {
  quotes: Connection<PvOrderNode>;
}

export interface CustomersPage {
  customers: Connection<PvCustomerNode>;
}

export interface ContactsPage {
  contacts: Connection<PvContactNode>;
}

export interface StatusesPage {
  statuses: Connection<PvStatusNode>;
}
