import { openai } from "@workspace/integrations-openai-ai-server";
import type pino from "pino";
import { getSchemaDoc } from "./schemaDoc";
import {
  runGuardedQuery,
  InsightsSqlError,
  type GuardedQueryResult,
} from "./guard";
import {
  buildInsightsAnalysis,
  parseModelAnalysis,
  publicQueryResult,
  type InsightsAnalysis,
  type ModelAnalysis,
} from "./provenance";

/**
 * Ask AI core loop: question → SQL (model, JSON output) → guarded execution
 * (retry loop feeding Postgres errors back to the model) → plain-language
 * answer from the result rows.
 *
 * Provider: Replit-managed OpenAI proxy (legacy Insights app used the same).
 * PLANNED SWAP to Tyler's own OpenAI developer account later: point
 * AI_INTEGRATIONS_OPENAI_BASE_URL/API_KEY at api.openai.com + his key (see
 * lib/integrations-openai-ai-server/src/client.ts) — no code changes here.
 */

const MODEL = "gpt-5.6-terra";
const MAX_SQL_ATTEMPTS = 3;
/** Per-model-call cap. */
const CALL_TIMEOUT_MS = 25_000;
/**
 * Whole-request budget. The Replit edge proxy kills held-open responses at
 * ~48s (see .agents/memory/replit-proxy-long-requests.md), so the entire
 * ask flow (all SQL attempts + summarize) must finish well under that.
 */
const TOTAL_BUDGET_MS = 40_000;
/** Don't start another model call with less than this left. */
const MIN_CALL_MS = 4_000;
/** Max result rows serialized into the summarization prompt. */
const SUMMARY_ROW_LIMIT = 50;

const FALLBACK_ANSWER =
  "Query ran successfully — see the results table below.";

export interface AskOutcome extends Omit<GuardedQueryResult, "metadata"> {
  answer: string;
  sql: string;
  analysis: InsightsAnalysis;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function extractSql(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new InsightsSqlError("Response was not valid JSON");
  }
  const sqlValue = (parsed as Record<string, unknown>)?.sql;
  if (typeof sqlValue !== "string" || !sqlValue.trim()) {
    throw new InsightsSqlError('JSON must contain a non-empty "sql" string');
  }
  return sqlValue;
}

export async function askInsights(
  question: string,
  logger: pino.Logger,
): Promise<AskOutcome> {
  const schemaDoc = await getSchemaDoc();
  const today = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });

  const system = `You are an expert PostgreSQL analyst for Mint Printworks' internal Printavo data warehouse. Today is ${today} (shop timezone America/New_York).

Write ONE PostgreSQL query that answers the user's question.

Respond with ONLY a JSON object: {"sql": "<the query>"}

Hard rules:
- A single SELECT (or WITH ... SELECT) statement. No semicolons, no comments.
- Read-only: never write, create, or alter anything. Never touch system catalogs (pg_catalog / information_schema) — the full schema is below.
- Only the whitelisted tables listed below exist for you.
- Prefer aggregates; results are hard-capped at 500 rows.
- Use clear lowercase snake_case column aliases (they become table headers).
- Make evidence visible in the result itself. If a time window is used or measured, include actual window_start and window_end result columns; never imply a window that the query did not measure. For status comparisons, include each exact matched status name and its count rather than only a combined total.
- When the user asks for an overall total or average plus a breakdown, return the overall aggregate as an explicit result row (for example GROUPING SETS/ROLLUP or a UNION ALL overall row). Do not leave overall arithmetic for the summarizer.
- Return durations as numeric hours or days (for example EXTRACT(EPOCH FROM duration) / 3600.0), never as raw PostgreSQL interval objects.

${schemaDoc}`;

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: question },
  ];

  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const remaining = () => deadline - Date.now();

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_SQL_ATTEMPTS; attempt++) {
    if (remaining() < MIN_CALL_MS) {
      throw new Error(
        `Ran out of time after ${attempt - 1} attempt(s) (last error: ${lastError || "none"})`,
      );
    }
    const resp = await openai.chat.completions.create(
      {
        model: MODEL,
        max_completion_tokens: 8192,
        messages,
        response_format: { type: "json_object" },
      },
      { timeout: Math.min(CALL_TIMEOUT_MS, remaining()) },
    );
    const content = resp.choices[0]?.message?.content ?? "";

    let result: GuardedQueryResult;
    let sqlText: string;
    try {
      sqlText = extractSql(content);
      result = await runGuardedQuery(sqlText);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.warn(
        { attempt, err: lastError },
        "insights SQL attempt failed, retrying",
      );
      messages.push(
        { role: "assistant", content },
        {
          role: "user",
          content: `That query failed with: ${lastError}\nReturn a corrected JSON object {"sql": "..."} following all the rules.`,
        },
      );
      continue;
    }

    let modelAnalysis: ModelAnalysis | null = null;
    if (remaining() >= MIN_CALL_MS) {
      try {
        modelAnalysis = await summarize(question, sqlText, result, remaining());
      } catch (err) {
        logger.warn({ err }, "insights summarize failed — using fallback answer");
      }
    }
    return {
      answer: modelAnalysis?.answer ?? FALLBACK_ANSWER,
      sql: sqlText,
      ...publicQueryResult(result),
      analysis: buildInsightsAnalysis(question, result, modelAnalysis),
    };
  }

  throw new Error(
    `Couldn't produce a working query after ${MAX_SQL_ATTEMPTS} attempts (last error: ${lastError})`,
  );
}

async function summarize(
  question: string,
  sqlText: string,
  result: GuardedQueryResult,
  budgetMs: number,
): Promise<ModelAnalysis> {
  const sampleRows = result.rows.slice(0, SUMMARY_ROW_LIMIT);
  const resp = await openai.chat.completions.create(
    {
      model: MODEL,
      max_completion_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a data analyst for a screen-printing shop. Use ONLY the SQL and returned query values provided.
Return ONLY JSON with this shape:
{"answer":"1-3 plain sentences","interpretedQuestion":"visible plain-language interpretation","sourceDescriptions":{"exact_table_name":"explanatory purpose"},"filters":["explanatory filter"],"calculations":["explanatory calculation"],"exclusions":["explanatory exclusion"],"limitations":["material limitation"],"findings":[{"text":"optional notable observation, no causal claim","evidence":[{"row":0,"column":"exact_column","value":"exact JSON value"}]}]}
Rules:
- Lead the answer with concrete values. Format dollars like $1,234.56.
- Model-written descriptions are explanatory, not proof; SQL is the audit truth.
- Never invent a date window. Discuss coverage only when result values measure it.
- Findings are optional, maximum 3. Every finding needs exact zero-based row and column references plus values copied exactly from Results JSON. Make no causal claim.
- State only aggregates and numbers that are explicitly present in Results JSON. Never compute a new weighted average, total, rate, difference, or other arithmetic in prose.
- If results are empty, say no matching data was found.
- If rows were sampled or capped, state that limitation and do not imply the summary inspected omitted rows.
- Do not claim invoice creation is status entry. Status history is observed at polling time and can only support periods present in returned evidence.`,
        },
        {
          role: "user",
          content: `Question: ${question}\n\nSQL used:\n${sqlText}\n\nResults as JSON (${result.rowCount} row(s)${result.truncated ? ", capped at 500" : ""}${result.rows.length > sampleRows.length ? `, first ${sampleRows.length} shown` : ""}):\n${JSON.stringify({ columns: result.columns, rows: sampleRows })}`,
        },
      ],
    },
    { timeout: Math.min(CALL_TIMEOUT_MS, budgetMs) },
  );
  const content = resp.choices[0]?.message?.content?.trim();
  if (!content) throw new Error("Summary response was empty");
  return parseModelAnalysis(content, result);
}
