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

export interface PvAddress {
  customerName: string | null;
  companyName: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  stateIso: string | null;
  zipCode: string | null;
  country: string | null;
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
  visualPoNumber: string | null;
  tags: string[] | null;
  /** Date-only creation date (top-level scalar; timestamps.createdAt is the instant). */
  createdAt?: string | null;
  startAt?: string | null;
  discount?: number | null;
  discountAmount?: number | null;
  discountAsPercentage?: boolean | null;
  salesTax?: number | null;
  salesTaxAmount?: number | null;
  totalUntaxed?: number | null;
  totalQuantity?: number | null;
  paidInFull?: boolean | null;
  merch?: boolean | null;
  packingSlipUrl?: string | null;
  publicPdf?: string | null;
  publicHash?: string | null;
  url?: string | null;
  status: PvStatusRef | null;
  owner: PvOwnerRef | null;
  contact: PvContactRef | null;
  shippingAddress: PvAddress | null;
  billingAddress: PvAddress | null;
  deliveryMethod: {
    id?: string;
    name: string | null;
    archived?: boolean | null;
  } | null;
  paymentTerm?: {
    id: string;
    name: string | null;
    days: number | null;
    archived: boolean | null;
  } | null;
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

/** Nested connection in detail queries — endCursor only where requested. */
export interface NestedConnection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
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

/** Minimal exact-order status response used by print/status stale guards. */
export interface PvOrderStatusNode {
  id: string;
  visualId: number | string;
  status: PvStatusRef | null;
}

export interface SingleOrderStatus {
  invoice?: PvOrderStatusNode | null;
  quote?: PvOrderStatusNode | null;
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

/* ── Order extras (backup module) ──────────────────────────────────────── */

export interface PvMockupNode {
  id: string;
  fullImageUrl: string | null;
  thumbnailUrl: string | null;
  mimeType: string | null;
  displayThumbnail: boolean | null;
  timestamps: PvTimestamps;
}

export interface PvFeeNode {
  id: string;
  amount: number | null;
  description: string | null;
  quantity: number | null;
  taxable: boolean | null;
  unitPrice: number | null;
  unitPriceAsPercentage: boolean | null;
  timestamps: PvTimestamps;
}

export interface PvExpenseNode {
  id: string;
  name: string;
  amount: number;
  transactionAt: string | null;
  userGenerated: boolean;
  timestamps: PvTimestamps;
}

export interface PvApprovalRequestNode {
  id: string;
  name: string;
  status: string;
  requester: { id: string; name: string; email: string | null } | null;
  retractor: { id: string; name: string; email: string | null } | null;
  response: {
    name: string;
    email: string | null;
    reason: string | null;
    respondedAt: string;
  } | null;
  timestamps: PvTimestamps;
}

export interface PvProductionFileNode {
  id: string;
  name: string | null;
  fileUrl: string;
  mimeType: string;
  timestamps: PvTimestamps;
}

export interface PvCustomAddressNode {
  id: string;
  name: string | null;
  customerName: string | null;
  companyName: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  stateIso: string | null;
  zipCode: string | null;
  country: string | null;
  countryIso: string | null;
  timestamps: PvTimestamps;
}

export interface PvExtrasLineItemNode {
  id: string;
  position: number | null;
  markupPercentage: number | null;
  taxed: boolean | null;
  personalizations: Array<{
    id: string;
    name: string;
    personalization: string;
  }> | null;
  priceReceipt: {
    defaultMarkupPercentage: number | null;
    description: string | null;
    price: number | null;
    signature: string | null;
  } | null;
  product: {
    id: string;
    brand: string | null;
    color: string | null;
    description: string | null;
    itemNumber: string | null;
    catalog: { id: string; name: string } | null;
  } | null;
  poLineItem: {
    id: string;
    purchaseOrder: {
      id: string;
      visualPoId: string;
      goodsStatus: string;
      note: string | null;
      vendor: {
        id: string;
        name: string | null;
        company: string;
        email: string | null;
        accountNumber: string | null;
      } | null;
    } | null;
  } | null;
  mockups: NestedConnection<PvMockupNode>;
}

export interface PvExtrasImprintNode {
  id: string;
  mockups: NestedConnection<PvMockupNode>;
}

export interface PvExtrasGroupNode {
  id: string;
  lineItems: NestedConnection<PvExtrasLineItemNode>;
  imprints: NestedConnection<PvExtrasImprintNode>;
}

export interface PvOrderExtrasNode {
  id: string;
  visualId: number;
  fees: Connection<PvFeeNode>;
  expenses: Connection<PvExpenseNode>;
  approvalRequests: Connection<PvApprovalRequestNode>;
  productionFiles: Connection<PvProductionFileNode>;
  customAddresses: Connection<PvCustomAddressNode> | null;
  threadSummary: { id: string; unread: boolean } | null;
  paymentRequest: {
    id: string;
    amount: number;
    description: string | null;
    nickname: string | null;
    status: string;
    requestedAt: string;
    visualId: string;
  } | null;
  contractorProfile: {
    id: string;
    companyName: string;
    email: string | null;
    phone: string | null;
    website: string | null;
    logo: string | null;
  } | null;
  lineItemGroups: Connection<PvExtrasGroupNode>;
}

export interface SingleOrderExtras {
  invoice?: PvOrderExtrasNode | null;
  quote?: PvOrderExtrasNode | null;
}

export interface SingleOrderExtrasGroupsPage {
  invoice?: { id: string; lineItemGroups: Connection<PvExtrasGroupNode> } | null;
  quote?: { id: string; lineItemGroups: Connection<PvExtrasGroupNode> } | null;
}

/** The assembled blob persisted in pv_orders.extras (connections flattened). */
export interface PvOrderExtrasBlob {
  fees: PvFeeNode[];
  expenses: PvExpenseNode[];
  approvalRequests: PvApprovalRequestNode[];
  productionFiles: PvProductionFileNode[];
  customAddresses: PvCustomAddressNode[];
  threadSummary: { id: string; unread: boolean } | null;
  paymentRequest: PvOrderExtrasNode["paymentRequest"];
  contractorProfile: PvOrderExtrasNode["contractorProfile"];
  lineItems: Array<Omit<PvExtrasLineItemNode, "mockups"> & { mockups: PvMockupNode[] }>;
  imprints: Array<{ id: string; mockups: PvMockupNode[] }>;
  /** True if any nested connection still had more pages after paging. */
  truncated: boolean;
  /**
   * GraphQL error messages salvaged from a partial-data response
   * (Printavo non-nullable-field bugs, e.g. deleted PO vendor). Present
   * only when the blob was captured despite such errors.
   */
  partialErrors?: string[];
}

export interface SingleOrderGroupsPage {
  invoice?: { id: string; lineItemGroups: NestedConnection<PvLineItemGroupNode> } | null;
  quote?: { id: string; lineItemGroups: NestedConnection<PvLineItemGroupNode> } | null;
}

export interface InvoicesPage {
  invoices: Connection<PvOrderNode>;
}

/** Response of orderTotalsQuery (history-backfill progress/verification). */
export interface OrderTotals {
  invoices: { totalNodes: number };
  quotes: { totalNodes: number };
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
