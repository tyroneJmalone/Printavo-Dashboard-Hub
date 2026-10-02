import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
export { pvOrdersTable } from "../../../lib/db/src/schema/pvOrders";
import { appSettingsTable } from "../../../lib/db/src/schema/appSettings";
export { appSettingsTable };

export const fixture = {
  order: {
    id: "invoice-1", visualId: 123, customerCompany: "Customer", contactName: "Contact",
    customerId: "customer-1", nickname: null, statusName: "Ready", orderType: "invoice",
    detailSyncState: "complete", detailSyncedAt: new Date("2026-01-02T00:00:00Z"),
  } as Record<string, unknown> | null,
  queries: [] as Array<{ sql: string; params: unknown[] }>,
  responses: [] as Array<{ rows: Record<string, unknown>[] } | Error>,
  enabled: ["reports"],
};
export const db = {
  select() {
    let settings = false;
    const query = {
      from(table: unknown) { settings = table === appSettingsTable; return query; },
      where() { return query; },
      async limit() { return settings ? [{ value: { enabled: fixture.enabled } }] : fixture.order ? [fixture.order] : []; },
    };
    return query;
  },
  async execute(query: SQL) {
    fixture.queries.push(new PgDialect().sqlToQuery(query));
    const response = fixture.responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected database query");
    return response;
  },
};