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
