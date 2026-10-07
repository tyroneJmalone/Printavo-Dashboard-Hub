import type {
  DecorationProductionReport, DecorationProductionGroup, DecorationProductionJob,
  DecorationProductionTotals,
} from "@workspace/api-zod";
import type { ReportOrder, ReportImprint } from "./dataset";

type Method = "print" | "embroidery";
const normalized = (value: string | null | undefined) => (value ?? "").toLowerCase().replace(/\s+/g, " ").trim();

/** Prefer explicit method evidence; never infer Print just from a color tier. */
export function imprintMethod(imp: ReportImprint): Method | "heat" | null {
  const classify = (value: string): Method | "heat" | null => {
    if (/\b(heat|dtf|vinyl|transfer|sublimation)\b/.test(value)) return "heat";
    const embroidery = /\b(embroidery|embroidered|stitching)\b/.test(value);
    const print = /\b(screen print(?:ing)?|print loc|printing)\b/.test(value) || value === "print";
    return embroidery === print ? null : embroidery ? "embroidery" : "print";
  };
  const explicit = classify(normalized(imp.typeOfWork));
  const matrix = classify(normalized(imp.matrixName));
  if (explicit && matrix && explicit !== matrix) return null;
  // Known Heat is deliberately excluded, not reassigned via garment category.
  return explicit ?? matrix;
}

export function colorCount(tier: string | null): number | null {
  const match = normalized(tier).match(/^(\d+)\s*colou?rs?$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Bounded tiers only. K units carry across a range such as 6–8K. */
export function stitchMidpoint(tier: string | null): number | null {
  const value = normalized(tier).replace(/,/g, "").replace(/[–—]/g, "-")
    .replace(/\s*stitches?$/, "").trim();
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(k)?\s*(?:-|to)\s*(\d+(?:\.\d+)?)\s*(k)?$/);
  if (!match) return null;
  const low = Number(match[1]) * (match[2] || (match[4] && Number(match[1]) < 1000) ? 1000 : 1);
  const high = Number(match[3]) * (match[4] || (match[2] && Number(match[3]) < 1000) ? 1000 : 1);
  if (!Number.isFinite(low + high) || low < 0 || high <= 0 || high < low) return null;
  return (low + high) / 2;
}

function totals(jobs: DecorationProductionJob[], method: Method): DecorationProductionTotals {
  const groups = jobs.flatMap(j => j.groups);
  const quantity = groups.reduce((n, g) => n + g.quantity, 0);
  const imprints = groups.reduce((n, g) => n + g.quantity * g.locations.length, 0);
  const locations = groups.flatMap(g => g.locations);
  const unknownLocations = locations.filter(l => l.complexity === null).length;
  const knownWorkUnits = locations.reduce((n, l) => n + (l.workUnits ?? 0), 0);
  const pricesKnown = groups.every(g => g.averageItemPrice !== null);
  return {
    invoices: jobs.length, quantity, imprints, knownWorkUnits, unknownLocations,
    workUnits: unknownLocations ? null : knownWorkUnits,
    estimatedScreens: method === "print" && !unknownLocations
      ? locations.reduce((n, l) => n + (l.complexity ?? 0), 0) : null,
    averageJobQuantity: jobs.length ? quantity / jobs.length : null,
    averageItemPrice: quantity && pricesKnown
      ? groups.reduce((n, g) => n + g.quantity * (g.averageItemPrice ?? 0), 0) / quantity : null,
    averageLocationsPerItem: quantity ? imprints / quantity : null,
  };
}

export function decorationProduction(
  orders: ReportOrder[], method: Method,
  options: { locationCount?: number; offset?: number; limit?: number } = {},
): DecorationProductionReport {
  let excludedIncompleteInvoices = 0, unclassifiedGroups = 0, unassignedGroups = 0, excludedQuantityGroups = 0;
  const jobs: DecorationProductionJob[] = [];
  for (const order of orders) {
    if (order.orderType !== "invoice") continue;
    if (order.detailSyncState !== "complete") { excludedIncompleteInvoices++; continue; }
    const groups: DecorationProductionGroup[] = [];
    for (const group of order.groups) {
      if (!group.imprints.length) { unassignedGroups++; continue; }
      const classified = group.imprints.map(imprint => ({ imprint, method: imprintMethod(imprint) }));
      if (classified.some(i => i.method === null)) { unclassifiedGroups++; continue; }
      const imprints = classified.filter(i => i.method === method).map(i => i.imprint);
      if (!imprints.length) continue;
      // Setup/service-only rows do not represent garments or decoration repetitions.
      const items = group.lineItems.filter(li => !/\b(set[\s-]?up|digitizing|digitising)\b/i.test(li.categoryName ?? ""));
      if (items.some(li => !Number.isFinite(li.items) || li.items < 0)) { excludedQuantityGroups++; continue; }
      const quantity = items.reduce((n, li) => n + li.items, 0);
      if (quantity <= 0) { excludedQuantityGroups++; continue; }
      const pricesKnown = items.filter(li => li.items > 0).every(li => li.priceKnown !== false && Number.isFinite(li.price));
      groups.push({
        id: group.id,
        items: [...new Set(items.filter(li => li.items > 0).map(li =>
          [li.itemNumber, li.color, li.description].filter(Boolean).join(" · ") || "Unlabeled item"))],
        quantity,
        averageItemPrice: pricesKnown ? items.reduce((n, li) => n + li.items * li.price, 0) / quantity : null,
        locations: imprints.map((imp, index) => {
          const complexity = method === "print" ? colorCount(imp.columnName) : stitchMidpoint(imp.columnName);
          return { id: imp.id ?? `${group.id}:${index}`, label: `Location ${index + 1}`,
            details: imp.details ?? null, matrix: imp.matrixName, tier: imp.columnName,
            complexity, workUnits: complexity === null ? null : quantity * complexity };
        }),
      });
    }
    if (!groups.length) continue;
    const job = { id: order.id, visualId: order.visualId, customer: order.customerName,
      nickname: order.nickname, groups } as DecorationProductionJob;
    job.totals = totals([job], method);
    jobs.push(job);
  }
  const narrow = (count: number) => jobs.flatMap(job => {
    const groups = job.groups.filter(g => g.locations.length === count);
    if (!groups.length) return [];
    const selected = { ...job, groups };
    selected.totals = totals([selected], method);
    return [selected];
  });
  const counts = [...new Set(jobs.flatMap(j => j.groups.map(g => g.locations.length)))].sort((a, b) => a - b);
  const complexities = [...new Set(jobs.flatMap(j => j.groups.flatMap(g => g.locations.map(l => l.complexity))))]
    .sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
  const complexityBreakdown = complexities.map(complexity => {
    const narrowed = jobs.flatMap(job => {
      const groups = job.groups.flatMap(g => {
        const locations = g.locations.filter(l => l.complexity === complexity);
        return locations.length ? [{ ...g, locations }] : [];
      });
      return groups.length ? [{ ...job, groups }] : [];
    });
    return { complexity, tiers: [...new Set(narrowed.flatMap(j => j.groups.flatMap(g =>
      g.locations.map(l => l.tier ?? "Unassigned tier"))))].sort(), totals: totals(narrowed, method) };
  });
  const selected = options.locationCount ? narrow(options.locationCount) : jobs;
  const offset = options.offset ?? 0, limit = options.limit ?? 20;
  return {
    method, summary: totals(jobs, method), complexityBreakdown,
    buckets: counts.map(locations => ({ locations, totals: totals(narrow(locations), method) })),
    jobs: selected.slice(offset, offset + limit), totalJobs: selected.length, offset, limit,
    excludedIncompleteInvoices, unclassifiedGroups, unassignedGroups, excludedQuantityGroups,
  };
}
