import type {
  PvLineItemGroupNode,
  PvLineItemNode,
  PvOrderDetailNode,
  PvSizeEntry,
} from "@workspace/printavo";
import { contentHashOf, moneyStr } from "./differ";

export function isCompleteOrderDetail(node: PvOrderDetailNode): boolean {
  if (node.lineItemGroups.pageInfo.hasNextPage) return false;
  return !node.lineItemGroups.nodes.some(
    (group) =>
      group.lineItems.pageInfo.hasNextPage || group.imprints.pageInfo.hasNextPage,
  );
}

/** Returns true when this response started no later than the accepted one. */
export function isFetchedObservationStale(
  fetchedAt: Date,
  acceptedAt: Date | null | undefined,
): boolean {
  return acceptedAt !== null &&
    acceptedAt !== undefined &&
    fetchedAt.getTime() <= acceptedAt.getTime();
}

/**
 * The stable, JSON-safe representation used by line-item history.
 *
 * `lineItemId` is the upstream Printavo id. Group and display position are
 * retained for the current snapshot, but intentionally excluded from
 * semantic comparison so a Printavo reorder is not reported as a change.
 */
export interface LineItemHistoryState {
  lineItemId: string;
  groupId: string;
  position: number | null;
  itemNumber: string | null;
  color: string | null;
  description: string | null;
  product: {
    id: string | null;
    brand: string | null;
    itemNumber: string | null;
    categoryId: string | null;
    categoryName: string | null;
  } | null;
  quantity: {
    items: number;
    sizes: PvSizeEntry[] | null;
  };
  unitPrice: string | null;
  merch: boolean;
  productStatus: string | null;
}

export interface LineItemHistoryChange {
  kind: "added" | "removed" | "changed";
  lineItemId: string;
  field: "quantity" | "unitPrice" | "description" | "product" | "color" | null;
  oldValue: unknown;
  newValue: unknown;
}

function normalizeSizes(sizes: PvSizeEntry[] | null | undefined): PvSizeEntry[] | null {
  if (!sizes) return null;
  return [...sizes]
    .map((entry) => ({ size: entry.size, count: entry.count }))
    .sort((a, b) => a.size.localeCompare(b.size));
}

export function lineItemHistoryState(
  group: PvLineItemGroupNode,
  lineItem: PvLineItemNode,
): LineItemHistoryState {
  return {
    lineItemId: lineItem.id,
    groupId: group.id,
    position: group.position ?? null,
    itemNumber: lineItem.itemNumber ?? null,
    color: lineItem.color ?? null,
    description: lineItem.description ?? null,
    product: lineItem.product
      ? {
          id: lineItem.product.id ?? null,
          brand: lineItem.product.brand ?? null,
          itemNumber: lineItem.itemNumber ?? null,
          categoryId: lineItem.category?.id ?? null,
          categoryName: lineItem.category?.name ?? null,
        }
      : null,
    quantity: {
      items: lineItem.items ?? 0,
      sizes: normalizeSizes(lineItem.sizes),
    },
    unitPrice: moneyStr(lineItem.price),
    merch: lineItem.merch ?? false,
    productStatus: lineItem.productStatus ?? null,
  };
}

export function lineItemHistoryStates(
  groups: readonly PvLineItemGroupNode[],
): LineItemHistoryState[] {
  return groups.flatMap((group) =>
    group.lineItems.nodes.map((lineItem) => lineItemHistoryState(group, lineItem)),
  );
}

/**
 * Stable semantic fingerprint. It sorts by the upstream line id and omits
 * group/position, making an unchanged/reordered response hash-identical.
 */
export function lineItemHistoryHash(
  states: readonly LineItemHistoryState[],
): string {
  return contentHashOf(
    [...states]
      .sort((a, b) => a.lineItemId.localeCompare(b.lineItemId))
      .map(({ groupId: _groupId, position: _position, ...state }) => state),
  );
}

function productValue(state: LineItemHistoryState): LineItemHistoryState["product"] {
  return state.product;
}

function quantityValue(
  state: LineItemHistoryState,
): LineItemHistoryState["quantity"] {
  return state.quantity;
}

/**
 * Compare two complete observations. Set `baseline` for the first complete
 * response: it establishes history and intentionally emits no additions.
 */
export function compareLineItemSnapshots(
  previous: readonly LineItemHistoryState[],
  current: readonly LineItemHistoryState[],
  baseline = false,
): LineItemHistoryChange[] {
  if (baseline) return [];

  const before = new Map(previous.map((item) => [item.lineItemId, item]));
  const after = new Map(current.map((item) => [item.lineItemId, item]));
  const changes: LineItemHistoryChange[] = [];
  const ids = new Set([...before.keys(), ...after.keys()]);

  for (const lineItemId of [...ids].sort()) {
    const oldItem = before.get(lineItemId);
    const newItem = after.get(lineItemId);
    if (!oldItem && newItem) {
      changes.push({
        kind: "added",
        lineItemId,
        field: null,
        oldValue: null,
        newValue: newItem,
      });
      continue;
    }
    if (oldItem && !newItem) {
      changes.push({
        kind: "removed",
        lineItemId,
        field: null,
        oldValue: oldItem,
        newValue: null,
      });
      continue;
    }
    if (!oldItem || !newItem) continue;

    const fields: Array<{
      field: LineItemHistoryChange["field"];
      oldValue: unknown;
      newValue: unknown;
    }> = [
      {
        field: "quantity",
        oldValue: quantityValue(oldItem),
        newValue: quantityValue(newItem),
      },
      {
        field: "unitPrice",
        oldValue: oldItem.unitPrice,
        newValue: newItem.unitPrice,
      },
      {
        field: "description",
        oldValue: oldItem.description,
        newValue: newItem.description,
      },
      {
        field: "product",
        oldValue: productValue(oldItem),
        newValue: productValue(newItem),
      },
      { field: "color", oldValue: oldItem.color, newValue: newItem.color },
    ];

    for (const change of fields) {
      if (contentHashOf(change.oldValue) !== contentHashOf(change.newValue)) {
        changes.push({
          kind: "changed",
          lineItemId,
          field: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
        });
      }
    }
  }

  return changes;
}

export function lineItemLabel(state: Partial<LineItemHistoryState> | null): string {
  if (!state) return "Line item";
  return (
    state.description ||
    state.itemNumber ||
    state.product?.itemNumber ||
    state.product?.id ||
    state.color ||
    "Line item"
  );
}