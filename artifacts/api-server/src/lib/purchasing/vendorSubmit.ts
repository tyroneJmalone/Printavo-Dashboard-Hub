import { db, vendorOrdersTable, poFilesTable, type VendorOrder } from "@workspace/db";
import { desc, eq } from "drizzle-orm";
import {
  SanMarClient,
  SanMarApiError,
  SANMAR_SHIP_METHODS,
  type SanMarPoInput,
  type SanMarPoLine,
} from "@workspace/sanmar";
import {
  SSClient,
  SSApiError,
  SS_SHIP_METHODS,
  type SSOrderInput,
  type SSPoLine,
} from "@workspace/ss-activewear";
import { getPoFile, type PoFileDto } from "./poFiles";
import { getVendorShipTo, type VendorShipTo } from "./vendorSettings";

/**
 * Electronic vendor order submission (SanMar submitPO / S&S POST /orders).
 *
 * Safety model:
 * - dry_run builds + previews the payload with NO network call. It is the
 *   default and the ONLY thing that happens unless VENDOR_SUBMIT_ENABLED is set
 *   (the route coerces test/live → dry_run when the flag is unset).
 * - A real send claims a vendor_orders row (status "submitting") BEFORE the
 *   network call. A partial unique index guarantees at most one active
 *   (submitting/submitted/unknown) real order per PO — the core guard against
 *   double-ordering.
 * - Sends are SINGLE-ATTEMPT. A network timeout is recorded as "unknown"
 *   (ambiguous — the order may or may not exist) and is NEVER auto-retried;
 *   it must be reconciled via a status lookup first.
 * - Credentials are injected only on the wire. The persisted requestPayload is
 *   credential-free.
 */

export type VendorId = "sanmar" | "ss";
export type VendorSubmitMode = "dry_run" | "test" | "live";

export type VendorSubmitOutcome =
  | "preview"
  | "ineligible"
  | "submitted"
  | "failed"
  | "unknown"
  | "not_found"
  | "already_active"
  | "in_progress"
  | "not_configured";

export interface VendorSubmitEligibility {
  ok: boolean;
  blockers: string[];
  warnings: string[];
}

export interface VendorSubmitPreviewLine {
  style: string;
  color: string;
  size: string;
  quantity: number;
  warehouseCode: string;
  sku: string | null;
  inventoryKey: string | null;
  sizeIndex: number | null;
  unitCost: number;
}

export interface VendorSubmitPreview {
  vendor: VendorId;
  poNumber: string;
  shipTo: VendorShipTo | null;
  shipMethod: string | null;
  shipMethodVendorCode: string | null;
  totalQuantity: number;
  totalCost: number;
  lineCount: number;
  lines: VendorSubmitPreviewLine[];
}

/** One tracking number persisted on a vendor_orders row (tracking jsonb). */
export interface VendorTrackingEntry {
  /** Vendor's own order/sales-order number the package belongs to. */
  orderNumber: string | null;
  carrier: string | null;
  trackingNumber: string;
  shipMethod: string | null;
  shipmentDate: string | null;
}

export interface VendorOrderDto {
  id: string;
  poFileId: string;
  vendor: string;
  mode: string;
  status: string;
  poNumber: string;
  shipMethod: string | null;
  vendorOrderNumbers: string[];
  vendorStatus: string | null;
  tracking: VendorTrackingEntry[];
  error: string | null;
  submittedAt: string | null;
  lastStatusCheckAt: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VendorSubmitResult {
  outcome: VendorSubmitOutcome;
  vendor: VendorId | null;
  mode: VendorSubmitMode;
  poNumber: string | null;
  eligibility: VendorSubmitEligibility | null;
  preview: VendorSubmitPreview | null;
  vendorOrder: VendorOrderDto | null;
  message: string | null;
}

/** In-process single-flight guard — no two concurrent sends for one PO. */
const inFlight = new Set<string>();

export class VendorNotConfigured extends Error {}

function isUniqueViolation(err: unknown): boolean {
  let e: unknown = err;
  while (typeof e === "object" && e !== null) {
    if ((e as { code?: unknown }).code === "23505") return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function truncate(s: string, max = 6000): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

export function toVendorOrderDto(row: VendorOrder): VendorOrderDto {
  return {
    id: row.id,
    poFileId: row.poFileId,
    vendor: row.vendor,
    mode: row.mode,
    status: row.status,
    poNumber: row.poNumber,
    shipMethod: row.shipMethod,
    vendorOrderNumbers: (row.vendorOrderNumbers as string[] | null) ?? [],
    vendorStatus: row.vendorStatus,
    tracking: (row.tracking as VendorTrackingEntry[] | null) ?? [],
    error: row.error,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    lastStatusCheckAt: row.lastStatusCheckAt?.toISOString() ?? null,
    archived: row.archived,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function sanMarClient(): SanMarClient {
  const customerNumber = process.env.SANMAR_ACCOUNT_NUMBER;
  const username = process.env.SANMAR_USERNAME;
  const password = process.env.SANMAR_PASSWORD;
  if (!customerNumber || !username || !password) {
    throw new VendorNotConfigured("SanMar credentials are not configured");
  }
  return new SanMarClient({ customerNumber, username, password });
}

export function ssClient(): SSClient {
  const accountNumber = process.env.SS_ACCOUNT_NUMBER;
  const apiKey = process.env.SS_API_KEY;
  if (!accountNumber || !apiKey) {
    throw new VendorNotConfigured("S&S Activewear credentials are not configured");
  }
  return new SSClient({ accountNumber, apiKey });
}

function validateShipTo(s: VendorShipTo | null): string[] {
  if (!s) {
    return [
      "Ship-to address isn't set up yet — configure it in Settings before submitting.",
    ];
  }
  const missing: string[] = [];
  if (!s.companyName?.trim()) missing.push("company name");
  if (!s.address1?.trim()) missing.push("address");
  if (!s.city?.trim()) missing.push("city");
  if (!/^[A-Za-z]{2}$/.test(s.state ?? "")) missing.push("2-letter state");
  if (!/^\d{5}(-\d{4})?$/.test(s.zip ?? "")) missing.push("ZIP");
  if (!s.defaultShipMethod || !(s.defaultShipMethod in SANMAR_SHIP_METHODS)) {
    missing.push("ship method");
  }
  return missing.length
    ? [`Ship-to address is incomplete (${missing.join(", ")}).`]
    : [];
}

interface EligibleLine {
  style: string;
  /** Vendor catalog color (SanMar needs the exact spelling). */
  color: string;
  size: string;
  quantity: number;
  warehouseCode: string;
  sku: string | null;
  inventoryKey: string | null;
  sizeIndex: number | null;
  unitCost: number;
}

function buildEligibility(
  vendor: VendorId,
  dto: PoFileDto,
): { eligibility: VendorSubmitEligibility; lines: EligibleLine[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const lines: EligibleLine[] = [];

  // Already ordered (electronically or marked by hand) — never re-order without
  // an admin unlock first. Belt-and-suspenders with the active-order unique idx.
  if (dto.submittedToVendorAt) {
    blockers.push(
      `This PO is already marked as submitted to the vendor${
        dto.vendorOrderNumber ? ` (order ${dto.vendorOrderNumber})` : ""
      }. Admin-unlock it first if you really need to re-order.`,
    );
  }

  if (vendor === "sanmar" && dto.poNumber.length > 12) {
    blockers.push(
      `PO number "${dto.poNumber}" is ${dto.poNumber.length} characters — SanMar allows 12 max.`,
    );
  }

  for (const li of dto.lineItems) {
    const label = `${li.styleNumber}${li.color ? ` / ${li.color}` : ""}`;
    if (li.source === "manual") {
      blockers.push(
        `"${label}" is a manual line — it can't be ordered electronically. Remove it or order it another way.`,
      );
      continue;
    }
    const color = (li.vendorCatalogColor ?? li.color ?? "").trim();
    if (!color) blockers.push(`"${label}" has no vendor catalog color.`);
    const warehouseCode = (li.warehouseCode ?? "").trim();
    for (const s of li.sizes) {
      if (s.qty <= 0) continue;
      const lineLabel = `${label} ${s.size}`;
      if (!warehouseCode) {
        blockers.push(`"${lineLabel}" has no warehouse selected.`);
        continue;
      }
      if (vendor === "sanmar") {
        if (s.inventoryKey == null || s.sizeIndex == null) {
          blockers.push(
            `"${lineLabel}" is missing SanMar inventoryKey/sizeIndex — re-run the vendor lookup for this line.`,
          );
          continue;
        }
        if (!Number.isInteger(Number(warehouseCode))) {
          blockers.push(`"${lineLabel}" has an invalid SanMar warehouse "${warehouseCode}".`);
          continue;
        }
      } else if (!s.sku) {
        blockers.push(
          `"${lineLabel}" is missing the S&S SKU — re-run the vendor lookup for this line.`,
        );
        continue;
      }
      if (!color) continue; // already blocked above
      lines.push({
        style: li.styleNumber.trim(),
        color,
        // Send the vendor's real size label (SanMar's combined "S/M"), not the
        // Printavo column it was stocked in. Falls back to size for normal lines.
        size: s.vendorSize ?? s.size,
        quantity: s.qty,
        warehouseCode,
        sku: s.sku,
        inventoryKey: s.inventoryKey,
        sizeIndex: s.sizeIndex,
        unitCost: s.unitCost,
      });
    }
  }

  // Two lines resolving to the SAME vendor unit + warehouse would place two
  // detail lines for one item — a double order (the shop's cardinal rule). This
  // only arises from combined-size mapping (S and M both → S/M). Block it.
  // Identity is style+color+SIZE+warehouse (the wire size SanMar/S&S orders by).
  // SanMar's inventoryKey is shared across a whole size RANGE (S–XL share one
  // key, distinguished only by sizeIndex), so it must NOT be the discriminator —
  // doing so falsely flags every normal S/M/L/XL run as a duplicate.
  const dupKey = (l: EligibleLine) =>
    `${l.style}|${l.color}|${vendor === "sanmar" ? l.size : (l.sku ?? l.size)}|${l.warehouseCode}`;
  const dupCounts = new Map<string, number>();
  for (const l of lines) dupCounts.set(dupKey(l), (dupCounts.get(dupKey(l)) ?? 0) + 1);
  const dupSeen = new Set<string>();
  for (const l of lines) {
    const k = dupKey(l);
    if ((dupCounts.get(k) ?? 0) > 1 && !dupSeen.has(k)) {
      dupSeen.add(k);
      blockers.push(
        `"${l.style} / ${l.color} ${l.size}" resolves to the same vendor item + warehouse as another line — combine them into one line so it isn't double-ordered.`,
      );
    }
  }

  if (lines.length === 0 && blockers.length === 0) {
    blockers.push("This PO has no orderable line items.");
  }
  return {
    eligibility: { ok: blockers.length === 0 && lines.length > 0, blockers, warnings },
    lines,
  };
}

function buildPreview(
  vendor: VendorId,
  dto: PoFileDto,
  shipTo: VendorShipTo | null,
  lines: EligibleLine[],
): VendorSubmitPreview {
  const method = shipTo?.defaultShipMethod ?? null;
  const vendorCode =
    method == null
      ? null
      : vendor === "sanmar"
        ? (SANMAR_SHIP_METHODS[method] ?? null)
        : (SS_SHIP_METHODS[method] ?? null);
  return {
    vendor,
    poNumber: dto.poNumber,
    shipTo,
    shipMethod: method,
    shipMethodVendorCode: vendorCode,
    totalQuantity: lines.reduce((a, l) => a + l.quantity, 0),
    totalCost:
      Math.round(lines.reduce((a, l) => a + l.quantity * l.unitCost, 0) * 100) / 100,
    lineCount: lines.length,
    lines: lines.map((l) => ({
      style: l.style,
      color: l.color,
      size: l.size,
      quantity: l.quantity,
      warehouseCode: l.warehouseCode,
      sku: l.sku,
      inventoryKey: l.inventoryKey,
      sizeIndex: l.sizeIndex,
      unitCost: l.unitCost,
    })),
  };
}

function buildSanMarInput(
  dto: PoFileDto,
  shipTo: VendorShipTo,
  lines: EligibleLine[],
): SanMarPoInput {
  const poLines: SanMarPoLine[] = lines.map((l) => ({
    style: l.style,
    color: l.color,
    size: l.size,
    sizeIndex: l.sizeIndex,
    inventoryKey: l.inventoryKey,
    quantity: l.quantity,
    whseNo: Number(l.warehouseCode),
  }));
  return {
    poNumber: dto.poNumber,
    attention: shipTo.attention,
    notes: dto.notes,
    shipTo: shipTo.companyName,
    shipAddress1: shipTo.address1,
    shipAddress2: shipTo.address2,
    shipCity: shipTo.city,
    shipState: shipTo.state,
    shipZip: shipTo.zip,
    shipMethod: SANMAR_SHIP_METHODS[shipTo.defaultShipMethod] ?? "UPS",
    shipEmail: shipTo.email,
    residential: shipTo.residential,
    lines: poLines,
  };
}

function buildSsInput(
  dto: PoFileDto,
  shipTo: VendorShipTo,
  lines: EligibleLine[],
): SSOrderInput {
  const poLines: SSPoLine[] = lines.map((l) => ({
    identifier: l.sku ?? "",
    qty: l.quantity,
    warehouseAbbr: l.warehouseCode,
  }));
  return {
    poNumber: dto.poNumber,
    shippingAddress: {
      customer: shipTo.companyName,
      attn: shipTo.attention,
      address: shipTo.address1,
      city: shipTo.city,
      state: shipTo.state,
      zip: shipTo.zip,
      residential: shipTo.residential,
    },
    shippingMethod: SS_SHIP_METHODS[shipTo.defaultShipMethod] ?? "1",
    emailConfirmation: shipTo.email,
    lines: poLines,
  };
}

function result(
  outcome: VendorSubmitOutcome,
  fields: Partial<Omit<VendorSubmitResult, "outcome">> & { mode: VendorSubmitMode },
): VendorSubmitResult {
  return {
    outcome,
    vendor: fields.vendor ?? null,
    mode: fields.mode,
    poNumber: fields.poNumber ?? null,
    eligibility: fields.eligibility ?? null,
    preview: fields.preview ?? null,
    vendorOrder: fields.vendorOrder ?? null,
    message: fields.message ?? null,
  };
}

async function updateOrder(
  id: string,
  patch: Partial<VendorOrder>,
): Promise<VendorOrder> {
  const [row] = await db
    .update(vendorOrdersTable)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(vendorOrdersTable.id, id))
    .returning();
  return row;
}

async function lockPoAsSubmitted(poFileId: string, vendorOrderNumber: string): Promise<void> {
  await db
    .update(poFilesTable)
    .set({ submittedToVendorAt: new Date(), vendorOrderNumber, updatedAt: new Date() })
    .where(eq(poFilesTable.id, poFileId));
}

/**
 * Run a submission (or preview) for a PO. The route is responsible for the
 * PIN gate, the VENDOR_SUBMIT_ENABLED kill switch, and coercing test/live →
 * dry_run when submission is disabled — by the time we get here `mode` is the
 * effective, authorized mode.
 */
export async function submitVendorOrder(
  poFileId: string,
  mode: VendorSubmitMode,
): Promise<VendorSubmitResult> {
  const dto = await getPoFile(poFileId);
  if (!dto) return result("not_found", { mode });

  const vendor: VendorId | null =
    dto.vendorName === "sanmar" || dto.vendorName === "ss" ? dto.vendorName : null;
  if (!vendor) {
    return result("ineligible", {
      mode,
      poNumber: dto.poNumber,
      eligibility: {
        ok: false,
        blockers: [`Vendor "${dto.vendorName}" doesn't support electronic ordering.`],
        warnings: [],
      },
    });
  }

  const shipTo = await getVendorShipTo();
  const { eligibility, lines } = buildEligibility(vendor, dto);
  const shipBlockers = validateShipTo(shipTo);
  if (shipBlockers.length) {
    eligibility.blockers.push(...shipBlockers);
    eligibility.ok = false;
  }
  const preview = buildPreview(vendor, dto, shipTo, lines);

  if (!eligibility.ok) {
    return result("ineligible", { vendor, mode, poNumber: dto.poNumber, eligibility, preview });
  }
  if (mode === "dry_run") {
    return result("preview", { vendor, mode, poNumber: dto.poNumber, eligibility, preview });
  }

  // Real send (test or live). shipTo is non-null here (eligibility passed).
  if (inFlight.has(poFileId)) {
    return result("in_progress", {
      vendor,
      mode,
      poNumber: dto.poNumber,
      eligibility,
      preview,
      message: "A submission for this PO is already running.",
    });
  }
  inFlight.add(poFileId);
  try {
    const input = vendor === "sanmar"
      ? buildSanMarInput(dto, shipTo!, lines)
      : buildSsInput(dto, shipTo!, lines);

    // Claim the active row BEFORE the network call. The partial unique index
    // rejects a second active order for this PO (idempotency guard).
    let order: VendorOrder;
    try {
      [order] = await db
        .insert(vendorOrdersTable)
        .values({
          poFileId,
          vendor,
          mode,
          status: "submitting",
          poNumber: dto.poNumber,
          shipMethod: shipTo!.defaultShipMethod,
          shippingAddress: shipTo,
          requestPayload: input,
        })
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) {
        return result("already_active", {
          vendor,
          mode,
          poNumber: dto.poNumber,
          eligibility,
          preview,
          message:
            "There's already an active submission for this PO. Reconcile it before submitting again.",
        });
      }
      throw err;
    }

    try {
      if (vendor === "sanmar") {
        const res = await sanMarClient().submitPO(input as SanMarPoInput, {
          test: mode === "test",
        });
        if (res.success) {
          // SanMar keys status lookups by the PO number itself.
          const updated = await updateOrder(order.id, {
            status: "submitted",
            vendorOrderNumbers: [dto.poNumber],
            rawResponse: { message: res.message, raw: truncate(res.raw) },
            submittedAt: new Date(),
          });
          if (mode === "live") await lockPoAsSubmitted(poFileId, dto.poNumber);
          return result("submitted", {
            vendor,
            mode,
            poNumber: dto.poNumber,
            eligibility,
            preview,
            vendorOrder: toVendorOrderDto(updated),
            message: res.message,
          });
        }
        const updated = await updateOrder(order.id, {
          status: "failed",
          error: res.message,
          rawResponse: { message: res.message, raw: truncate(res.raw) },
        });
        return result("failed", {
          vendor,
          mode,
          poNumber: dto.poNumber,
          eligibility,
          preview,
          vendorOrder: toVendorOrderDto(updated),
          message: res.message,
        });
      }

      // S&S
      const res = await ssClient().submitOrder(input as SSOrderInput, {
        test: mode === "test",
      });
      if (res.orderNumbers.length === 0) {
        const updated = await updateOrder(order.id, {
          status: "unknown",
          error:
            "S&S accepted the request but returned no order number — verify with S&S before resubmitting." +
            (res.lineErrorSummary ? ` S&S reported ${res.lineErrorSummary}` : ""),
          rawResponse: (res.raw as object) ?? null,
        });
        return result("unknown", {
          vendor,
          mode,
          poNumber: dto.poNumber,
          eligibility,
          preview,
          vendorOrder: toVendorOrderDto(updated),
          message: updated.error,
        });
      }
      const updated = await updateOrder(order.id, {
        status: "submitted",
        vendorOrderNumbers: res.orderNumbers,
        rawResponse: (res.raw as object) ?? null,
        submittedAt: new Date(),
      });
      if (mode === "live") await lockPoAsSubmitted(poFileId, res.orderNumbers[0]);
      return result("submitted", {
        vendor,
        mode,
        poNumber: dto.poNumber,
        eligibility,
        preview,
        vendorOrder: toVendorOrderDto(updated),
        message: `S&S order ${res.orderNumbers.join(", ")}`,
      });
    } catch (err) {
      // Distinguish an ambiguous failure (order may exist → "unknown", never
      // auto-retry) from a clear vendor rejection (→ "failed", retryable).
      // Ambiguous = the request may have reached the vendor: a network/read
      // error (no HTTP status) OR a 5xx (server errored AFTER receiving it).
      // A 4xx, SOAP fault, or auth error is a definite rejection → "failed".
      const ambiguous =
        (err instanceof SanMarApiError &&
          (err.kind === "network" ||
            (err.kind === "http" && (err.httpStatus ?? 0) >= 500))) ||
        (err instanceof SSApiError &&
          (err.httpStatus == null || err.httpStatus >= 500));
      const updated = await updateOrder(order.id, {
        status: ambiguous ? "unknown" : "failed",
        error: errMsg(err),
      });
      return result(ambiguous ? "unknown" : "failed", {
        vendor,
        mode,
        poNumber: dto.poNumber,
        eligibility,
        preview,
        vendorOrder: toVendorOrderDto(updated),
        message: errMsg(err),
      });
    }
  } catch (err) {
    if (err instanceof VendorNotConfigured) {
      return result("not_configured", {
        vendor,
        mode,
        poNumber: dto.poNumber,
        message: err.message,
      });
    }
    throw err;
  } finally {
    inFlight.delete(poFileId);
  }
}

export async function listVendorOrders(poFileId?: string): Promise<VendorOrderDto[]> {
  const rows = poFileId
    ? await db
        .select()
        .from(vendorOrdersTable)
        .where(eq(vendorOrdersTable.poFileId, poFileId))
        .orderBy(desc(vendorOrdersTable.createdAt))
    : await db.select().from(vendorOrdersTable).orderBy(desc(vendorOrdersTable.createdAt));
  return rows.map(toVendorOrderDto);
}
