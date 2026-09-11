/**
 * Report filter parsing. Semantics ported from the legacy Insights app:
 * - multi-value params are `||`-separated
 * - `exclude` lists which list-filters invert to exclusion
 * - date strings are YYYY-MM-DD, interpreted as America/New_York local
 *   day boundaries (applied in SQL via AT TIME ZONE)
 */

export const EXCLUDABLE_FILTERS = [
  "statuses",
  "brands",
  "categories",
  "styleNumbers",
  "colors",
] as const;

export type ExcludableFilter = (typeof EXCLUDABLE_FILTERS)[number];

export interface ReportFilters {
  orderType: "invoice" | "quote" | "all";
  /** Activity mode keeps only orders with at least one qualifying event. */
  activityOnly: boolean;
  /** Inclusive shop-local calendar dates for activity timestamps. */
  activityStart: string | null;
  activityEnd: string | null;
  /** Current owner on pv_orders, never the event actor/historical owner. */
  activityOwner: string | null;
  statuses: string[];
  brands: string[];
  categories: string[];
  styleNumbers: string[];
  colors: string[];
  createdStart: string | null;
  createdEnd: string | null;
  invoiceStart: string | null;
  invoiceEnd: string | null;
  productionDueStart: string | null;
  productionDueEnd: string | null;
  dueStart: string | null;
  dueEnd: string | null;
  minQty: number | null;
  maxQty: number | null;
  minTotal: number | null;
  maxTotal: number | null;
  search: string | null;
  exclude: Set<ExcludableFilter>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Query = Record<string, unknown>;

function str(query: Query, key: string): string | null {
  const v = query[key];
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

function multi(query: Query, key: string): string[] {
  const v = str(query, key);
  if (!v) return [];
  return v
    .split("||")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
}

function num(
  query: Query,
  key: string,
  errors: string[],
): number | null {
  const v = str(query, key);
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    errors.push(`${key} must be a number`);
    return null;
  }
  return n;
}

function dateStr(
  query: Query,
  key: string,
  errors: string[],
): string | null {
  const v = str(query, key);
  if (v === null) return null;
  if (!DATE_RE.test(v)) {
    errors.push(`${key} must be YYYY-MM-DD`);
    return null;
  }
  return v;
}

export function parseReportFilters(query: Query): {
  filters: ReportFilters;
  errors: string[];
} {
  const errors: string[] = [];

  const orderTypeRaw = str(query, "orderType") ?? "invoice";
  let orderType: ReportFilters["orderType"] = "invoice";
  if (orderTypeRaw === "invoice" || orderTypeRaw === "quote" || orderTypeRaw === "all") {
    orderType = orderTypeRaw;
  } else {
    errors.push("orderType must be invoice, quote, or all");
  }

  const activityOnlyRaw = str(query, "activityOnly");
  const activityOnly =
    activityOnlyRaw === "true" || activityOnlyRaw === "1";
  if (
    activityOnlyRaw !== null &&
    activityOnlyRaw !== "true" &&
    activityOnlyRaw !== "false" &&
    activityOnlyRaw !== "1" &&
    activityOnlyRaw !== "0"
  ) {
    errors.push("activityOnly must be true or false");
  }

  const exclude = new Set<ExcludableFilter>();
  for (const name of str(query, "exclude")?.split(/\|\||,/) ?? []) {
    const trimmed = name.trim() as ExcludableFilter;
    if (trimmed === ("" as string)) continue;
    if ((EXCLUDABLE_FILTERS as readonly string[]).includes(trimmed)) {
      exclude.add(trimmed);
    } else {
      errors.push(`exclude: unknown filter "${trimmed}"`);
    }
  }

  const filters: ReportFilters = {
    orderType,
    activityOnly,
    activityStart: dateStr(query, "activityStart", errors),
    activityEnd: dateStr(query, "activityEnd", errors),
    activityOwner: str(query, "activityOwner"),
    statuses: multi(query, "statuses"),
    brands: multi(query, "brands"),
    categories: multi(query, "categories"),
    styleNumbers: multi(query, "styleNumbers"),
    colors: multi(query, "colors"),
    createdStart: dateStr(query, "createdStart", errors),
    createdEnd: dateStr(query, "createdEnd", errors),
    invoiceStart: dateStr(query, "invoiceStart", errors),
    invoiceEnd: dateStr(query, "invoiceEnd", errors),
    productionDueStart: dateStr(query, "productionDueStart", errors),
    productionDueEnd: dateStr(query, "productionDueEnd", errors),
    dueStart: dateStr(query, "dueStart", errors),
    dueEnd: dateStr(query, "dueEnd", errors),
    minQty: num(query, "minQty", errors),
    maxQty: num(query, "maxQty", errors),
    minTotal: num(query, "minTotal", errors),
    maxTotal: num(query, "maxTotal", errors),
    search: str(query, "search"),
    exclude,
  };

  if (
    filters.activityStart &&
    filters.activityEnd &&
    filters.activityStart > filters.activityEnd
  ) {
    errors.push("activityStart must be on or before activityEnd");
  }

  return { filters, errors };
}

/** JSON-friendly echo of the applied filters (for response payloads). */
export function filtersEcho(f: ReportFilters): Record<string, unknown> {
  return {
    orderType: f.orderType,
    activityOnly: f.activityOnly,
    activityStart: f.activityStart,
    activityEnd: f.activityEnd,
    activityOwner: f.activityOwner,
    statuses: f.statuses,
    brands: f.brands,
    categories: f.categories,
    styleNumbers: f.styleNumbers,
    colors: f.colors,
    createdStart: f.createdStart,
    createdEnd: f.createdEnd,
    invoiceStart: f.invoiceStart,
    invoiceEnd: f.invoiceEnd,
    productionDueStart: f.productionDueStart,
    productionDueEnd: f.productionDueEnd,
    dueStart: f.dueStart,
    dueEnd: f.dueEnd,
    minQty: f.minQty,
    maxQty: f.maxQty,
    minTotal: f.minTotal,
    maxTotal: f.maxTotal,
    search: f.search,
    exclude: [...f.exclude],
  };
}
