import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  hubCalcUploadsTable,
  pvLineItemsTable,
  pvOrdersTable,
} from "@workspace/db";
import {
  calculatorLineItemGroupCreateMutation,
  invoiceLineItemGroupPositionsQuery,
} from "@workspace/printavo";
import { getPrintavoClient } from "../printavoGateway";
import {
  buildLineItemDescription,
  normalizeLineItemInput,
  validateLineItemInput,
  type HubCalculatorLineItemInput,
} from "./pureHelpers";
import { CalcPushError } from "./calcPushError";

export interface HubCalculatorCategory {
  id: string;
  name: string;
}

export async function listHubCalculatorCategories(): Promise<
  HubCalculatorCategory[]
> {
  return db
    .select({
      id: pvLineItemsTable.categoryId,
      name: pvLineItemsTable.categoryName,
      usage: sql<number>`count(*)::int`,
    })
    .from(pvLineItemsTable)
    .where(
      and(
        isNotNull(pvLineItemsTable.categoryId),
        isNotNull(pvLineItemsTable.categoryName),
      ),
    )
    .groupBy(pvLineItemsTable.categoryId, pvLineItemsTable.categoryName)
    .orderBy(desc(sql`count(*)`), pvLineItemsTable.categoryName)
    .then((rows) =>
      rows
        .filter(
          (row): row is typeof row & { id: string; name: string } =>
            Boolean(row.id?.trim() && row.name?.trim()),
        )
        .map(({ id, name }) => ({ id, name })),
    );
}

export async function validateLineItemCategory(
  categoryId: string,
): Promise<HubCalculatorCategory> {
  const [category] = await db
    .select({
      id: pvLineItemsTable.categoryId,
      name: pvLineItemsTable.categoryName,
    })
    .from(pvLineItemsTable)
    .where(eq(pvLineItemsTable.categoryId, categoryId))
    .limit(1);
  if (!category?.id || !category.name) {
    throw new CalcPushError(
      "The selected Printavo category is no longer available",
      "invalid",
    );
  }
  return { id: category.id, name: category.name };
}

export function lineItemSnapshotsEqual(
  a: HubCalculatorLineItemInput | null | undefined,
  b: HubCalculatorLineItemInput | null | undefined,
): boolean {
  return (
    JSON.stringify(a ? normalizeLineItemInput(a) : null) ===
    JSON.stringify(b ? normalizeLineItemInput(b) : null)
  );
}

export interface LineItemPushOutcome {
  requested: boolean;
  ok: boolean;
  locked?: boolean;
  lineItemGroupId?: string;
  lineItemId?: string;
  error?: string;
}

export async function pushCalculatorLineItem(opts: {
  uploadId: string;
  invoiceId: string;
  visualId: number;
  snapshot: HubCalculatorLineItemInput | null;
  priceRows: Array<{ qty: number; unitPrice: number }>;
  attemptedAt: Date | null;
  existingGroupId: string | null;
  existingLineItemId: string | null;
  existingError: string | null;
}): Promise<LineItemPushOutcome> {
  if (!opts.snapshot) return { requested: false, ok: false };
  const snapshot = normalizeLineItemInput(opts.snapshot);
  const validationError = validateLineItemInput(snapshot);
  if (validationError) throw new CalcPushError(validationError, "invalid");

  if (opts.existingGroupId && opts.existingLineItemId) {
    return {
      requested: true,
      ok: true,
      lineItemGroupId: opts.existingGroupId,
      lineItemId: opts.existingLineItemId,
    };
  }
  if (opts.attemptedAt) {
    return {
      requested: true,
      ok: false,
      locked: true,
      error:
        opts.existingError ??
        "Line-item creation was previously attempted with an ambiguous outcome — verify the invoice manually.",
    };
  }

  const [mirror] = await db
    .select({
      visualId: pvOrdersTable.visualId,
      orderType: pvOrdersTable.orderType,
    })
    .from(pvOrdersTable)
    .where(eq(pvOrdersTable.printavoId, opts.invoiceId))
    .limit(1);
  if (!mirror || mirror.visualId !== opts.visualId) {
    throw new CalcPushError("Selected invoice no longer matches the local mirror", "not_found");
  }
  if (mirror.orderType !== "invoice") {
    throw new CalcPushError("Calculator line items can only be added to invoices", "invalid");
  }

  await validateLineItemCategory(snapshot.categoryId);
  const client = getPrintavoClient();
  const live = await client.query<{
    invoice: {
      id: string;
      visualId: number;
      lineItemGroups: {
        nodes: Array<{ id: string; position: number | null }>;
        pageInfo: { hasNextPage: boolean };
      };
    } | null;
  }>(invoiceLineItemGroupPositionsQuery(opts.invoiceId));
  if (!live.invoice || Number(live.invoice.visualId) !== opts.visualId) {
    throw new CalcPushError("Live Printavo invoice was not found or changed", "not_found");
  }
  if (live.invoice.lineItemGroups.pageInfo.hasNextPage) {
    throw new CalcPushError(
      "Invoice has more than 100 line-item groups; no safe append position could be determined",
      "invalid",
    );
  }
  const nextPosition =
    Math.max(-1, ...live.invoice.lineItemGroups.nodes.map((g) => g.position ?? -1)) + 1;

  const claim = await db
    .update(hubCalcUploadsTable)
    .set({ lineItemAttemptedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(hubCalcUploadsTable.id, opts.uploadId),
        sql`${hubCalcUploadsTable.lineItemAttemptedAt} is null`,
      ),
    )
    .returning({ id: hubCalcUploadsTable.id });
  if (claim.length === 0) {
    throw new CalcPushError(
      "Line-item creation is being attempted by another request",
      "conflict",
    );
  }

  try {
    const result = await client.mutate<{
      lineItemGroupCreate: {
        id: string;
        lineItems: { nodes: Array<{ id: string }> };
      };
    }>(
      calculatorLineItemGroupCreateMutation(opts.invoiceId, {
        position: nextPosition,
        categoryId: snapshot.categoryId,
        itemNumber: snapshot.itemNumber,
        color: snapshot.color,
        description: buildLineItemDescription(snapshot, opts.priceRows),
      }),
    );
    const lineItemId = result.lineItemGroupCreate.lineItems.nodes[0]?.id;
    if (!lineItemId) {
      throw new Error(
        "Printavo created the line-item group but did not return a line-item id",
      );
    }
    const lineItemGroupId = result.lineItemGroupCreate.id;
    await db
      .update(hubCalcUploadsTable)
      .set({ lineItemGroupId, lineItemId, updatedAt: new Date() })
      .where(eq(hubCalcUploadsTable.id, opts.uploadId));
    return {
      requested: true,
      ok: true,
      lineItemGroupId,
      lineItemId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .update(hubCalcUploadsTable)
      .set({
        lineItemError: message,
        lineItemErrorAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(hubCalcUploadsTable.id, opts.uploadId));
    return { requested: true, ok: false, locked: true, error: message };
  }
}