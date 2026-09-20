import type { GuardedQueryResult } from "./guard";

const SUMMARY_ROW_LIMIT = 50;
const CAUSAL_CLAIM_RE =
  /\b(because|caused?|causing|drives?|drove|led to|results? in)\b/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-]+Z?)?$/;
const WINDOW_START_RE = /(?:^|_)window_start$/i;
const WINDOW_END_RE = /(?:^|_)window_end$/i;

export interface InsightsFindingEvidence {
  row: number;
  column: string;
  value: unknown;
}

export interface InsightsAnalysis {
  interpretedQuestion: string;
  sources: Array<{
    name: string;
    kind: "table";
    usage: "referenced";
    description: string;
    descriptionStatus: "model_described";
  }>;
  dateCoverage: {
    status: "measured" | "not_measured";
    start: string | null;
    end: string | null;
    basis: string | null;
  };
  filters: Array<{ description: string; status: "model_described" }>;
  calculations: Array<{ description: string; status: "model_described" }>;
  exclusions: Array<{ description: string; status: "model_described" }>;
  freshness: {
    status: "known" | "unknown";
    asOf: string | null;
    source: string | null;
    note: string;
  };
  limitations: string[];
  summary: {
    status: "available" | "unavailable";
    sampledRows: number;
    returnedRows: number;
    truncated: boolean;
    note: string | null;
  };
  findings: Array<{
    text: string;
    evidence: InsightsFindingEvidence[];
  }>;
  provenanceNote: string;
}

export interface ModelAnalysis {
  answer: string;
  interpretedQuestion: string;
  sourceDescriptions: Record<string, string>;
  filters: string[];
  calculations: string[];
  exclusions: string[];
  limitations: string[];
  findings: Array<{
    text: string;
    evidence: InsightsFindingEvidence[];
  }>;
}

function collectPlanRelations(
  value: unknown,
  allowedRelations: ReadonlySet<string>,
  found = new Set<string>(),
) {
  if (Array.isArray(value)) {
    value.forEach((item) =>
      collectPlanRelations(item, allowedRelations, found),
    );
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (
        key === "Relation Name" &&
        typeof child === "string" &&
        allowedRelations.has(child)
      ) {
        found.add(child);
      } else {
        collectPlanRelations(child, allowedRelations, found);
      }
    }
  }
  return found;
}

export function extractReferencedRelationsFromPlan(
  value: unknown,
  allowedRelations: readonly string[],
): string[] {
  return [
    ...collectPlanRelations(value, new Set<string>(allowedRelations)),
  ].sort();
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function sameValue(actual: unknown, claimed: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(claimed);
}

export function parseModelAnalysis(
  content: string,
  result: GuardedQueryResult,
): ModelAnalysis {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (typeof parsed.answer !== "string" || !parsed.answer.trim()) {
    throw new Error("Summary JSON must contain an answer");
  }
  const sourceDescriptions: Record<string, string> = {};
  if (
    parsed.sourceDescriptions &&
    typeof parsed.sourceDescriptions === "object" &&
    !Array.isArray(parsed.sourceDescriptions)
  ) {
    for (const [key, value] of Object.entries(parsed.sourceDescriptions)) {
      if (typeof value === "string" && value.trim()) {
        sourceDescriptions[key] = value.trim();
      }
    }
  }

  const findings: ModelAnalysis["findings"] = [];
  if (Array.isArray(parsed.findings)) {
    for (const candidate of parsed.findings.slice(0, 3)) {
      if (!candidate || typeof candidate !== "object") continue;
      const item = candidate as Record<string, unknown>;
      if (
        typeof item.text !== "string" ||
        !item.text.trim() ||
        CAUSAL_CLAIM_RE.test(item.text)
      ) {
        continue;
      }
      if (!Array.isArray(item.evidence) || item.evidence.length === 0) continue;
      const evidence: InsightsFindingEvidence[] = [];
      let valid = true;
      for (const rawEvidence of item.evidence) {
        if (!rawEvidence || typeof rawEvidence !== "object") {
          valid = false;
          break;
        }
        const ref = rawEvidence as Record<string, unknown>;
        if (
          !Number.isInteger(ref.row) ||
          (ref.row as number) < 0 ||
          (ref.row as number) >=
            Math.min(result.rows.length, SUMMARY_ROW_LIMIT) ||
          typeof ref.column !== "string"
        ) {
          valid = false;
          break;
        }
        const columnIndex = result.columns.indexOf(ref.column);
        if (
          columnIndex < 0 ||
          !sameValue(result.rows[ref.row as number]?.[columnIndex], ref.value)
        ) {
          valid = false;
          break;
        }
        evidence.push({
          row: ref.row as number,
          column: ref.column,
          value: ref.value,
        });
      }
      if (valid && evidence.length > 0) {
        findings.push({ text: item.text.trim(), evidence });
      }
    }
  }

  return {
    answer: parsed.answer.trim(),
    interpretedQuestion:
      typeof parsed.interpretedQuestion === "string" &&
      parsed.interpretedQuestion.trim()
        ? parsed.interpretedQuestion.trim()
        : "",
    sourceDescriptions,
    filters: stringArray(parsed.filters),
    calculations: stringArray(parsed.calculations),
    exclusions: stringArray(parsed.exclusions),
    limitations: stringArray(parsed.limitations),
    findings,
  };
}

function measuredDateCoverage(result: GuardedQueryResult) {
  const starts: Array<{ value: string; time: number; column: string }> = [];
  const ends: Array<{ value: string; time: number; column: string }> = [];
  result.columns.forEach((column, columnIndex) => {
    const target = WINDOW_START_RE.test(column)
      ? starts
      : WINDOW_END_RE.test(column)
        ? ends
        : null;
    if (!target) return;
    result.rows.forEach((row) => {
      const value = row[columnIndex];
      if (typeof value !== "string" || !ISO_DATE_RE.test(value)) return;
      const time = Date.parse(value);
      if (Number.isFinite(time)) target.push({ value, time, column });
    });
  });
  if (starts.length === 0 && ends.length === 0) {
    return {
      status: "not_measured" as const,
      start: null,
      end: null,
      basis: null,
    };
  }
  starts.sort((a, b) => a.time - b.time);
  ends.sort((a, b) => a.time - b.time);
  const basisColumns = [...starts, ...ends].map((item) => item.column);
  return {
    status: "measured" as const,
    start: starts[0]?.value ?? null,
    end: ends[ends.length - 1]?.value ?? null,
    basis: `Observed result coverage from ${[
      ...new Set(basisColumns),
    ].join(", ")}; timezone and bucketing are defined by the SQL. This is not independent proof of the query's filter period.`,
  };
}

export function buildInsightsAnalysis(
  question: string,
  result: GuardedQueryResult,
  model: ModelAnalysis | null,
): InsightsAnalysis {
  const sampledRows = model
    ? Math.min(result.rows.length, SUMMARY_ROW_LIMIT)
    : 0;
  const limitations = [...(model?.limitations ?? [])];
  if (result.rows.length === 0) {
    limitations.push("The executed query returned no matching rows.");
  }
  if (model && result.rows.length > SUMMARY_ROW_LIMIT) {
    limitations.push(
      `The answer summary used only the first ${SUMMARY_ROW_LIMIT} of ${result.rowCount} returned rows.`,
    );
  }
  if (result.truncated) {
    limitations.push(
      "The displayed result was capped at 500 rows; totals over the uncapped result were not measured.",
    );
  }
  if (result.metadata.planStatus === "unavailable") {
    limitations.push(
      "Executed-relation metadata was unavailable; no data sources are claimed.",
    );
  }
  if (result.metadata.referencedRelations.includes("change_events")) {
    limitations.push(
      "Status-change history is only tracked from July 8, 2026; earlier transitions are unavailable.",
      "Status transitions use sync observation timestamps with approximately five-minute polling granularity, not exact human action times.",
    );
  }

  const explained = (items: string[]) =>
    items.map((description) => ({
      description,
      status: "model_described" as const,
    }));

  const summaryNote = model
    ? result.rows.length > SUMMARY_ROW_LIMIT
      ? `Summary sampled the first ${SUMMARY_ROW_LIMIT} returned rows.`
      : result.truncated
        ? "Summary used returned rows, but the result itself was capped."
        : null
    : "The explanatory summary was unavailable; the successful SQL result remains usable.";

  return {
    interpretedQuestion: model?.interpretedQuestion || question,
    sources: result.metadata.referencedRelations.map((name) => ({
      name,
      kind: "table" as const,
      usage: "referenced" as const,
      description:
        model?.sourceDescriptions[name] ??
        "Referenced by the database execution plan; EXPLAIN was not run with ANALYZE, so this does not prove rows were scanned.",
      descriptionStatus: "model_described" as const,
    })),
    dateCoverage: measuredDateCoverage(result),
    filters: explained(model?.filters ?? []),
    calculations: explained(model?.calculations ?? []),
    exclusions: explained(model?.exclusions ?? []),
    freshness: result.metadata.freshness,
    limitations: [...new Set(limitations)],
    summary: {
      status: model ? "available" : "unavailable",
      sampledRows,
      returnedRows: result.rowCount,
      truncated: result.truncated,
      note: summaryNote,
    },
    findings: model?.findings ?? [],
    provenanceNote:
      "Sources are relations referenced by the database execution plan, not proof of runtime scans. Date coverage comes only from returned window_start/window_end values and is not independent proof of the filter period. Freshness, row references, and values come from guarded metadata or returned values. Filters, calculations, exclusions, source descriptions, and narrative findings are model-described explanations, not independently verified; inspect the SQL as the audit truth.",
  };
}

export function publicQueryResult(result: GuardedQueryResult) {
  return {
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rowCount,
    truncated: result.truncated,
  };
}