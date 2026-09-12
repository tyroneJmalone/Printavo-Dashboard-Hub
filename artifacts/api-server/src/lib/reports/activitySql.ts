import { sql, type SQL } from "drizzle-orm";

/**
 * Keep the report and detail endpoint on the exact same persisted-event
 * predicate. The sync feed uses entity_id for order events and order_id for
 * line-item events.
 */
export function qualifyingActivitySql(
  entityType: SQL,
  eventType: SQL,
  entityId: SQL,
  orderId: SQL,
): SQL {
  return sql`(
    (
      ${entityType} = 'order'
      AND ${eventType} IN ('status_change', 'field_change', 'updated')
      AND ${entityId} IS NOT NULL
    )
    OR (
      ${entityType} = 'line_item'
      AND ${eventType} IN ('status_change', 'field_change', 'created', 'deleted')
      AND ${orderId} IS NOT NULL
    )
  )`;
}

export function activityCategorySql(
  entityType: SQL,
  eventType: SQL,
  field: SQL,
): SQL {
  return sql`CASE
    WHEN ${eventType} = 'status_change' OR ${field} = 'productStatus'
      THEN 'status'
    WHEN ${field} = 'quantity'
      THEN 'quantity'
    WHEN ${field} IN ('unitPrice', 'total')
      THEN 'price'
    WHEN ${field} = 'amountOutstanding'
      THEN 'balance'
    WHEN ${entityType} = 'line_item'
      THEN 'lineItem'
    ELSE 'order'
  END`;
}