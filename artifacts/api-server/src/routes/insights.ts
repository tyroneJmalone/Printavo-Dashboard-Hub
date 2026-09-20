import { Router, type IRouter } from "express";
import { db, insightsPresetsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { askInsights } from "../lib/insights/ask";
import {
  runGuardedQuery,
  validateSql,
  InsightsSqlError,
} from "../lib/insights/guard";
import {
  buildInsightsAnalysis,
  publicQueryResult,
} from "../lib/insights/provenance";

/**
 * Ask AI insights — natural-language questions over the local Printavo
 * mirror, answered via guarded read-only SQL (see lib/insights/guard.ts),
 * plus saved report presets that re-run the stored SQL deterministically
 * (no AI call on preset runs).
 *
 * Mounted behind requireStaff. Hub DB only — never the live moMINTum /
 * MintBucks databases.
 */

const router: IRouter = Router();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function presetJson(p: typeof insightsPresetsTable.$inferSelect) {
  return {
    id: p.id,
    name: p.name,
    question: p.question,
    sql: p.sql,
    createdByEmail: p.createdByEmail,
    archived: p.archived,
    lastRunAt: p.lastRunAt ? p.lastRunAt.toISOString() : null,
    createdAt: p.createdAt.toISOString(),
  };
}

// ── Ask ──────────────────────────────────────────────────────────────

router.post("/insights/ask", async (req, res) => {
  const question =
    typeof req.body?.question === "string" ? req.body.question.trim() : "";
  if (question.length < 3 || question.length > 1000) {
    res.status(400).json({ error: "Question must be 3-1000 characters" });
    return;
  }
  try {
    const outcome = await askInsights(question, req.log);
    res.json({ question, ...outcome });
  } catch (err) {
    req.log.error({ err }, "insights ask failed");
    const message =
      err instanceof Error ? err.message : "Ask AI failed — try rephrasing";
    res.status(502).json({ error: message });
  }
});

// ── Presets ──────────────────────────────────────────────────────────

router.get("/insights/presets", async (req, res) => {
  try {
    const includeArchived = req.query.includeArchived === "true";
    const rows = await db
      .select()
      .from(insightsPresetsTable)
      .where(
        includeArchived ? undefined : eq(insightsPresetsTable.archived, false),
      )
      .orderBy(desc(insightsPresetsTable.createdAt));
    res.json({ presets: rows.map(presetJson) });
  } catch (err) {
    req.log.error({ err }, "list presets failed");
    res.status(500).json({ error: "Failed to load presets" });
  }
});

router.post("/insights/presets", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const question =
    typeof req.body?.question === "string" ? req.body.question.trim() : "";
  const sqlText = typeof req.body?.sql === "string" ? req.body.sql.trim() : "";
  if (!name || name.length > 120) {
    res.status(400).json({ error: "Preset name is required (max 120 chars)" });
    return;
  }
  if (!question || question.length > 1000) {
    res.status(400).json({ error: "Question is required (max 1000 chars)" });
    return;
  }
  let cleanedSql: string;
  try {
    cleanedSql = validateSql(sqlText);
  } catch (err) {
    const message =
      err instanceof InsightsSqlError ? err.message : "Invalid SQL";
    res.status(400).json({ error: message });
    return;
  }
  try {
    const [created] = await db
      .insert(insightsPresetsTable)
      .values({
        name,
        question,
        sql: cleanedSql,
        createdByEmail: req.staff?.email ?? null,
      })
      .returning();
    res.status(201).json({ preset: presetJson(created) });
  } catch (err) {
    req.log.error({ err }, "create preset failed");
    res.status(500).json({ error: "Failed to save preset" });
  }
});

router.patch("/insights/presets/:id", async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "Invalid preset id" });
    return;
  }
  const updates: Partial<typeof insightsPresetsTable.$inferInsert> = {};
  if (req.body?.name !== undefined) {
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 120) {
      res.status(400).json({ error: "Preset name must be 1-120 chars" });
      return;
    }
    updates.name = name;
  }
  if (req.body?.archived !== undefined) {
    if (typeof req.body.archived !== "boolean") {
      res.status(400).json({ error: "archived must be a boolean" });
      return;
    }
    updates.archived = req.body.archived;
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }
  updates.updatedAt = new Date();
  try {
    const [updated] = await db
      .update(insightsPresetsTable)
      .set(updates)
      .where(eq(insightsPresetsTable.id, id))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    res.json({ preset: presetJson(updated) });
  } catch (err) {
    req.log.error({ err }, "update preset failed");
    res.status(500).json({ error: "Failed to update preset" });
  }
});

router.post("/insights/presets/:id/run", async (req, res) => {
  const { id } = req.params;
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: "Invalid preset id" });
    return;
  }
  try {
    const [preset] = await db
      .select()
      .from(insightsPresetsTable)
      .where(eq(insightsPresetsTable.id, id))
      .limit(1);
    if (!preset) {
      res.status(404).json({ error: "Preset not found" });
      return;
    }
    const result = await runGuardedQuery(preset.sql);
    const ranAt = new Date();
    await db
      .update(insightsPresetsTable)
      .set({ lastRunAt: ranAt, updatedAt: ranAt })
      .where(eq(insightsPresetsTable.id, id));
    res.json({
      preset: presetJson({ ...preset, lastRunAt: ranAt }),
      ...publicQueryResult(result),
      ranAt: ranAt.toISOString(),
      analysis: buildInsightsAnalysis(preset.question, result, null),
    });
  } catch (err) {
    if (err instanceof InsightsSqlError) {
      res.status(400).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "run preset failed");
    const message = err instanceof Error ? err.message : "Preset run failed";
    // Schema drift can break old presets — surface the DB error so the
    // user can re-ask AI and save a fresh version.
    res.status(500).json({ error: `Preset query failed: ${message}` });
  }
});

export default router;
