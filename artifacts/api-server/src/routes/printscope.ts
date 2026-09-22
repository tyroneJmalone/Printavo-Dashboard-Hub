import { Router, type ErrorRequestHandler } from "express";
import { randomUUID, createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { CreatePrintscopeUploadBody, ImportPrintscopePilotSourceBody, ReviewPrintscopePilotJobBody, UpdatePrintscopeRulesBody } from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireStaff";
import { getPrivateObjectDir, parseObjectPath } from "../lib/objectStorage";
import { activeRules, ruleDto, ruleDefinitions, validateRules, toCsv, versionMatches } from "../lib/printscope/rules";
import { capabilities, environment, MAX_BYTES, objectFile, safeFilename } from "../lib/printscope/worker";

const router = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function jobDto(j: any) {
  return { id: j.id, state: j.state, filename: j.filename, byteSize: j.byte_size, sha256: j.sha256, ruleVersionId: j.rule_version_id, submittedBy: j.submitted_by, createdAt: j.created_at, completedAt: j.completed_at, parentJobId: j.parent_job_id, result: j.assets_expired_at ? redactExpiredAssets(j.result) : j.result, error: j.error };
}
function redactExpiredAssets(result: any) {
  if (!result) return result;
  const copy = structuredClone(result);
  for (const preview of copy.previews ?? []) for (const plate of preview.plates ?? []) plate.src = null;
  return copy;
}
function reviewDto(r: any) {
  return r ? { id: r.id, jobId: r.job_id, outcome: r.outcome, reason: r.reason, note: r.note, reviewerId: r.reviewer_id, createdAt: r.created_at } : null;
}
function pilotJobDto(j: any) {
  return { ...jobDto(j), pilotId: j.pilot_id, provenance: j.pilot_provenance, latestReview: reviewDto(j.review_id ? {
    id: j.review_id, job_id: j.id, outcome: j.review_outcome, reason: j.review_reason,
    note: j.review_note, reviewer_id: j.review_reviewer_id, created_at: j.review_created_at,
  } : null), assetsExpiredAt: j.assets_expired_at };
}
function pilotDto(p: any) {
  const now = Date.now(), end = new Date(p.ends_at).getTime(), purge = new Date(p.purge_after).getTime();
  return { id: p.id, environment: p.environment, state: now < end ? "active" : now < purge ? "review" : "expired", ruleVersionId: p.rule_version_id, createdBy: p.created_by, startedAt: p.started_at, endsAt: p.ends_at, purgeAfter: p.purge_after, createdAt: p.created_at };
}
const emptyMetrics = () => ({ imported: 0, queued: 0, completed: 0, failed: 0, reviewed: 0, unreviewed: 0, comparable: 0, matching: 0, nonmatching: 0, uncertain: 0, falseClear: 0, limitations: ["Only completed jobs with a latest human review are comparable; engine checks may be incomplete."] });
async function pilotSummary(p: any | undefined) {
  if (!p) return { pilot: null, metrics: emptyMetrics() };
  const m = (await pool.query(`WITH latest AS (
    SELECT DISTINCT ON (r.job_id) r.job_id,r.outcome FROM printscope_pilot_reviews r
    JOIN printscope_jobs j ON j.id=r.job_id WHERE j.pilot_id=$1 ORDER BY r.job_id,r.created_at DESC,r.id DESC
  ) SELECT count(*)::int imported,
    count(*) FILTER (WHERE j.state IN ('queued','processing'))::int queued,
    count(*) FILTER (WHERE j.state='completed')::int completed,
    count(*) FILTER (WHERE j.state='failed')::int failed,
    count(*) FILTER (WHERE j.state='completed' AND l.job_id IS NOT NULL)::int reviewed,
    count(*) FILTER (WHERE j.state='completed' AND l.job_id IS NULL)::int unreviewed,
    count(*) FILTER (WHERE j.state='completed' AND l.outcome IN ('pass','flag','fail'))::int comparable,
    count(*) FILTER (WHERE j.state='completed' AND l.outcome IN ('pass','flag','fail') AND j.result->>'verdict'=l.outcome)::int matching,
    count(*) FILTER (WHERE j.state='completed' AND l.outcome IN ('pass','flag','fail') AND j.result->>'verdict'<>l.outcome)::int nonmatching,
    count(*) FILTER (WHERE j.state='completed' AND l.outcome='uncertain')::int uncertain,
    count(*) FILTER (WHERE j.state='completed' AND j.result->>'verdict'='pass' AND l.outcome IN ('flag','fail'))::int false_clear
    FROM printscope_jobs j LEFT JOIN latest l ON l.job_id=j.id WHERE j.pilot_id=$1`, [p.id])).rows[0];
  return { pilot: pilotDto(p), metrics: { ...m, falseClear: m.false_clear, limitations: emptyMetrics().limitations } };
}
export function sourceEligibilityReasons(row: any) {
  const reasons: string[] = [];
  if (row.source_kind !== "production_file") reasons.push("not_production_file");
  if (row.status !== "mirrored" || !row.object_path) reasons.push("not_mirrored");
  if (!safeFilename(row.file_name ?? "")) reasons.push("unsupported_filename");
  if (!Number.isSafeInteger(Number(row.byte_size)) || Number(row.byte_size) < 1 || Number(row.byte_size) > MAX_BYTES) reasons.push("unsupported_size");
  return reasons;
}
export function sourceMetadataReasons(row: any, metadata?: { generation?: unknown; size?: unknown }) {
  if (!metadata) return ["mirror_object_unavailable"];
  const reasons: string[] = [];
  if (!metadata.generation) reasons.push("mirror_generation_unavailable");
  if (Number(metadata.size) !== Number(row.byte_size)) reasons.push("mirror_size_mismatch");
  return reasons;
}
export function revisionToken(row: any, generation: string) {
  return createHash("sha256").update(JSON.stringify([row.id, row.order_printavo_id, row.order_visual_id, row.file_name, Number(row.byte_size), row.mirrored_at, row.object_path, generation])).digest("hex");
}
export function sourceBindingMatches(row: any, generation: string, input: { expectedGeneration: string; expectedFilename: string; expectedBytes: number; revisionToken: string }, objectBytes: number) {
  return generation === input.expectedGeneration && row.file_name === input.expectedFilename && Number(row.byte_size) === input.expectedBytes &&
    objectBytes === input.expectedBytes && revisionToken(row, generation) === input.revisionToken;
}
export function rerunValues(old: any, versionId: number, submittedBy: string) {
  if (!old.sha256 || !old.generation) throw new Error("Original has not been verified");
  return [randomUUID(), environment, old.filename, old.byte_size, old.content_type, old.source_path, old.generation, old.sha256, versionId, submittedBy, old.id];
}
router.use("/printscope", (req, res, next) => {
  if (!req.staff) { res.status(401).json({ error: "Staff session required" }); return; }
  next();
});
router.get("/printscope/capabilities", (_req, res) => { res.json(capabilities()); });
router.get("/printscope/pilot", async (_req, res) => {
  const p = (await pool.query("SELECT * FROM printscope_pilots WHERE environment=$1", [environment])).rows[0];
  res.json(await pilotSummary(p));
});
router.post("/printscope/pilot/start", requireAdmin, async (req, res) => {
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(728421)");
    const existing = (await c.query("SELECT * FROM printscope_pilots WHERE environment=$1", [environment])).rows[0];
    if (existing) {
      await c.query("COMMIT");
      if (Date.now() < new Date(existing.ends_at).getTime()) res.json(await pilotSummary(existing));
      else res.status(409).json({ error: "This environment's pilot has already been started and cannot be extended or restarted" });
      return;
    }
    const version = await activeRules();
    const p = (await c.query(`INSERT INTO printscope_pilots(environment,rule_version_id,created_by,started_at,ends_at,purge_after)
      VALUES($1,$2,$3,now(),now()+interval '14 days',now()+interval '44 days') RETURNING *`, [environment, version.id, req.staff!.id])).rows[0];
    await c.query("COMMIT"); res.status(201).json(await pilotSummary(p));
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
});
router.get("/printscope/pilot/sources", async (req, res) => {
  const limit = Number(req.query.limit ?? 25), offset = Number(req.query.offset ?? 0), search = String(req.query.search ?? "").trim();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || search.length > 200) { res.status(400).json({ error: "Invalid search or pagination" }); return; }
  const where = `f.source_kind='production_file' AND f.status='mirrored' AND f.object_path IS NOT NULL AND f.file_name ~* '\\.ai$' AND f.byte_size BETWEEN 1 AND $1
    AND ($2='' OR f.file_name ILIKE '%'||$2||'%' OR f.order_printavo_id ILIKE '%'||$2||'%' OR f.order_visual_id::text ILIKE '%'||$2||'%')`;
  const rows = (await pool.query(`SELECT f.* FROM pv_files f JOIN pv_orders o ON o.printavo_id=f.order_printavo_id WHERE ${where} ORDER BY f.mirrored_at DESC,f.id LIMIT $3 OFFSET $4`, [MAX_BYTES, search, limit, offset])).rows;
  const sources = [];
  for (const row of rows) {
    try {
      const [meta] = await objectFile(row.object_path).getMetadata();
      const reasons = sourceMetadataReasons(row, meta);
      const generation = reasons.length ? null : String(meta.generation);
      sources.push({ sourceId: row.id, revisionToken: generation ? revisionToken(row, generation) : null, sourceGeneration: generation, orderPrintavoId: row.order_printavo_id, visualId: row.order_visual_id, filename: row.file_name, bytes: Number(row.byte_size), mirroredAt: row.mirrored_at, firstSeenAt: row.first_seen_at, eligible: reasons.length === 0, reasons });
    } catch {
      sources.push({ sourceId: row.id, revisionToken: null, sourceGeneration: null, orderPrintavoId: row.order_printavo_id, visualId: row.order_visual_id, filename: row.file_name, bytes: Number(row.byte_size), mirroredAt: row.mirrored_at, firstSeenAt: row.first_seen_at, eligible: false, reasons: sourceMetadataReasons(row) });
    }
  }
  const total = Number((await pool.query(`SELECT count(*) FROM pv_files f JOIN pv_orders o ON o.printavo_id=f.order_printavo_id WHERE ${where}`, [MAX_BYTES, search])).rows[0].count);
  res.json({ sources, total });
});
router.post("/printscope/pilot/imports", async (req, res) => {
  if (!capabilities().available) { res.status(503).json({ error: "Processing unavailable" }); return; }
  const parsed = ImportPrintscopePilotSourceBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid pilot import request" }); return; }
  const input = parsed.data, c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${environment}:${input.pilotId}:${input.sourceId}`]);
    const pilot = (await c.query("SELECT * FROM printscope_pilots WHERE id=$1 AND environment=$2 FOR UPDATE", [input.pilotId, environment])).rows[0];
    if (!pilot || Date.now() >= new Date(pilot.ends_at).getTime()) { await c.query("ROLLBACK"); res.status(409).json({ error: "Pilot intake is not active" }); return; }
    const row = (await c.query(`SELECT f.* FROM pv_files f JOIN pv_orders o ON o.printavo_id=f.order_printavo_id WHERE f.id=$1 FOR UPDATE OF f`, [input.sourceId])).rows[0];
    if (!row || sourceEligibilityReasons(row).length) {
      await c.query("ROLLBACK"); res.status(422).json({ error: "Unsupported input: select a mirrored production_file with a PDF-compatible .ai filename up to 50 MiB" }); return;
    }
    const [meta] = await objectFile(row.object_path).getMetadata();
    const generation = String(meta.generation ?? "");
    if (!generation || !sourceBindingMatches(row, generation, input, Number(meta.size))) {
      await c.query("ROLLBACK"); res.status(409).json({ error: "Source changed since selection; refresh and select it again" }); return;
    }
    const [data] = await objectFile(row.object_path, generation).download();
    if (data.length !== input.expectedBytes || data.subarray(0, 5).toString() !== "%PDF-") {
      await c.query("ROLLBACK"); res.status(422).json({ error: "Unsupported input: mirrored .ai file is not PDF-compatible" }); return;
    }
    const sha = createHash("sha256").update(data).digest("hex");
    const prior = (await c.query("SELECT * FROM printscope_jobs WHERE environment=$1 AND pilot_id=$2 AND pilot_source_id=$3 AND sha256=$4 AND rule_version_id=$5", [environment, pilot.id, row.id, sha, pilot.rule_version_id])).rows[0];
    if (prior) { await c.query("COMMIT"); res.json(pilotJobDto(prior)); return; }
    const id = randomUUID(), dest = `${getPrivateObjectDir()}/printscope/${environment}/pilots/${pilot.id}/originals/${row.id}/${sha}.ai`;
    try { await objectFile(dest).save(data, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, contentType: "application/pdf" }); }
    catch (e: any) { if (Number(e.code) !== 412) throw e; }
    const [destMeta] = await objectFile(dest).getMetadata();
    const provenance = { sourceId: row.id, orderPrintavoId: row.order_printavo_id, visualId: row.order_visual_id, filename: row.file_name, bytes: Number(row.byte_size), mirroredAt: row.mirrored_at, sourceGeneration: generation, contentSha256: sha, importedAt: new Date().toISOString() };
    const job = (await c.query(`INSERT INTO printscope_jobs(id,environment,state,filename,byte_size,content_type,source_path,generation,sha256,rule_version_id,submitted_by,pilot_id,pilot_source_id,pilot_provenance)
      VALUES($1,$2,'queued',$3,$4,'application/pdf',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [id, environment, row.file_name, data.length, dest, String(destMeta.generation), sha, pilot.rule_version_id, req.staff!.id, pilot.id, row.id, JSON.stringify(provenance)])).rows[0];
    await c.query("COMMIT"); res.status(201).json(pilotJobDto(job));
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
});
router.get("/printscope/pilot/jobs", async (req, res) => {
  const limit = Number(req.query.limit ?? 25), offset = Number(req.query.offset ?? 0), pilotId = req.query.pilotId ? String(req.query.pilotId) : null;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || (pilotId && !uuid.test(pilotId))) { res.status(400).json({ error: "Invalid pagination or pilot ID" }); return; }
  const selected = pilotId ?? (await pool.query("SELECT id FROM printscope_pilots WHERE environment=$1", [environment])).rows[0]?.id;
  if (!selected) { res.json({ jobs: [], total: 0 }); return; }
  const base = `FROM printscope_jobs j LEFT JOIN LATERAL (
    SELECT r.id review_id,r.outcome review_outcome,r.reason review_reason,r.note review_note,r.reviewer_id review_reviewer_id,r.created_at review_created_at
    FROM printscope_pilot_reviews r WHERE r.job_id=j.id ORDER BY r.created_at DESC,r.id DESC LIMIT 1
  ) r ON true WHERE j.environment=$1 AND j.pilot_id=$2`;
  const jobs = (await pool.query(`SELECT j.*,r.* ${base} ORDER BY j.created_at DESC,j.id DESC LIMIT $3 OFFSET $4`, [environment, selected, limit, offset])).rows;
  const total = Number((await pool.query(`SELECT count(*) ${base}`, [environment, selected])).rows[0].count);
  res.json({ jobs: jobs.map(pilotJobDto), total });
});
router.get("/printscope/pilot/jobs/:id/reviews", async (req, res) => {
  if (!uuid.test(String(req.params.id))) { res.sendStatus(404); return; }
  const limit = Number(req.query.limit ?? 25), offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) { res.status(400).json({ error: "Invalid pagination" }); return; }
  const job = (await pool.query("SELECT id FROM printscope_jobs WHERE id=$1 AND environment=$2 AND pilot_id IS NOT NULL", [req.params.id, environment])).rows[0];
  if (!job) { res.sendStatus(404); return; }
  const reviews = (await pool.query("SELECT * FROM printscope_pilot_reviews WHERE job_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3", [job.id, limit, offset])).rows;
  const total = Number((await pool.query("SELECT count(*) FROM printscope_pilot_reviews WHERE job_id=$1", [job.id])).rows[0].count);
  res.json({ reviews: reviews.map(reviewDto), total });
});
router.post("/printscope/pilot/jobs/:id/reviews", async (req, res) => {
  if (!uuid.test(String(req.params.id))) { res.sendStatus(404); return; }
  const parsed = ReviewPrintscopePilotJobBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid review" }); return; }
  if (!parsed.data.reason.trim()) { res.status(400).json({ error: "Review reason is required" }); return; }
  const job = (await pool.query(`SELECT j.id,j.state,p.purge_after FROM printscope_jobs j JOIN printscope_pilots p ON p.id=j.pilot_id
    WHERE j.id=$1 AND j.environment=$2`, [req.params.id, environment])).rows[0];
  if (!job) { res.sendStatus(404); return; }
  if (job.state !== "completed") { res.status(409).json({ error: "Only completed pilot jobs can be reviewed" }); return; }
  if (Date.now() >= new Date(job.purge_after).getTime()) { res.status(410).json({ error: "Pilot review period has ended; history remains available" }); return; }
  const { outcome, reason, note } = parsed.data;
  const row = (await pool.query("INSERT INTO printscope_pilot_reviews(job_id,outcome,reason,note,reviewer_id) VALUES($1,$2,$3,$4,$5) RETURNING *", [job.id, outcome, reason.trim(), note?.trim() || null, req.staff!.id])).rows[0];
  res.status(201).json(reviewDto(row));
});
router.get("/printscope/rules", async (_req, res) => { res.json(await ruleDto(await activeRules())); });
router.get("/printscope/rules/versions", async (_req, res) => {
  await activeRules();
  res.json(await Promise.all((await pool.query("SELECT * FROM printscope_rule_versions ORDER BY id DESC")).rows.map(ruleDto)));
});
router.get("/printscope/rules/versions/:id", async (req, res) => {
  if (!/^\d+$/.test(String(req.params.id))) { res.status(400).json({ error: "Invalid version" }); return; }
  const row = (await pool.query("SELECT * FROM printscope_rule_versions WHERE id=$1", [req.params.id])).rows[0];
  if (!row) { res.sendStatus(404); return; } res.json(await ruleDto(row));
});
router.put("/printscope/rules", requireAdmin, async (req, res) => {
  const parsed = UpdatePrintscopeRulesBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid rule snapshot" }); return; }
  await activeRules();
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(728419)");
    const current = (await c.query("SELECT * FROM printscope_rule_versions ORDER BY id DESC LIMIT 1")).rows[0];
    if (!versionMatches(parsed.data.expectedVersion, current.id)) { await c.query("ROLLBACK"); res.status(409).json({ error: "Rules changed; reload before saving" }); return; }
    try { validateRules(parsed.data.rows, current.rows, await ruleDefinitions()); }
    catch (e) { await c.query("ROLLBACK"); res.status(400).json({ error: e instanceof Error ? e.message : "Invalid rules" }); return; }
    const csv = toCsv(parsed.data.rows);
    const row = (await c.query("INSERT INTO printscope_rule_versions(rows,csv,hash,created_by) VALUES($1,$2,$3,$4) RETURNING *", [JSON.stringify(parsed.data.rows), csv, createHash("sha256").update(csv).digest("hex"), req.staff!.id])).rows[0];
    await c.query("COMMIT"); res.json(await ruleDto(row));
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
});
router.get("/printscope/jobs", async (req, res) => {
  const limit = Number(req.query.limit ?? 25), offset = Number(req.query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) { res.status(400).json({ error: "Invalid pagination" }); return; }
  const rows = await pool.query("SELECT * FROM printscope_jobs WHERE environment=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3", [environment, limit, offset]);
  const total = Number((await pool.query("SELECT count(*) FROM printscope_jobs WHERE environment=$1", [environment])).rows[0].count);
  res.json({ jobs: rows.rows.map(jobDto), total });
});
router.post("/printscope/uploads", async (req, res) => {
  if (!capabilities().available) { res.status(503).json({ error: "Processing unavailable" }); return; }
  const parsed = CreatePrintscopeUploadBody.safeParse(req.body);
  if (!parsed.success || !safeFilename(parsed.data.filename)) { res.status(400).json({ error: "Upload a PDF-compatible .ai filename without path characters (maximum 50 MiB)" }); return; }
  const { filename, byteSize, contentType } = parsed.data;
  if (!["application/pdf", "application/postscript", "application/illustrator", "application/octet-stream", ""].includes(contentType)) { res.status(400).json({ error: "Unsupported content type" }); return; }
  const version = await activeRules(), id = randomUUID();
  const path = `${getPrivateObjectDir()}/printscope/${environment}/staging/${id}`;
  const { bucketName, objectName } = parseObjectPath(path);
  const signed = await fetch("http://127.0.0.1:1106/object-storage/signed-object-url", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ bucket_name: bucketName, object_name: objectName, method: "PUT", expires_at: new Date(Date.now() + 900000).toISOString() }), signal: AbortSignal.timeout(15000) });
  if (!signed.ok) { res.status(503).json({ error: "Private upload signing unavailable" }); return; }
  const { signed_url: uploadURL } = await signed.json() as { signed_url: string };
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(728420)");
    const count = Number((await c.query("SELECT count(*) FROM printscope_jobs WHERE environment=$1 AND (state IN ('queued','processing') OR (state='uploading' AND created_at>now()-interval '1 hour'))", [environment])).rows[0].count);
    if (count >= 20) { await c.query("ROLLBACK"); res.status(429).json({ error: "Inspection queue is full; try later" }); return; }
    const job = (await c.query("INSERT INTO printscope_jobs(id,environment,state,filename,byte_size,content_type,source_path,rule_version_id,submitted_by) VALUES($1,$2,'uploading',$3,$4,$5,$6,$7,$8) RETURNING *", [id, environment, filename, byteSize, contentType, path, version.id, req.staff!.id])).rows[0];
    await c.query("COMMIT"); res.status(201).json({ job: jobDto(job), uploadURL });
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
});
router.use("/printscope/jobs/:id", async (req, res, next) => {
  if (!uuid.test(String(req.params.id))) { res.sendStatus(404); return; }
  const job = (await pool.query("SELECT * FROM printscope_jobs WHERE id=$1 AND environment=$2", [req.params.id, environment])).rows[0];
  if (!job) { res.sendStatus(404); return; }
  res.locals.printscopeJob = job; next();
});
router.get("/printscope/jobs/:id", (_req, res) => { res.json(jobDto(res.locals.printscopeJob)); });
router.post("/printscope/jobs/:id/complete", async (req, res) => {
  const job = res.locals.printscopeJob;
  if (job.submitted_by !== req.staff!.id && req.staff!.role !== "admin") { res.sendStatus(403); return; }
  if (job.state !== "uploading") { res.json(jobDto(job)); return; }
  if (Date.now() - new Date(job.created_at).getTime() > 3600000) { res.status(410).json({ error: "Upload reservation expired" }); return; }
  try {
    const file = objectFile(job.source_path), [meta] = await file.getMetadata();
    if (Number(meta.size) !== job.byte_size || Number(meta.size) > MAX_BYTES || !meta.generation) throw new Error("Invalid size");
    const pinned = objectFile(job.source_path, String(meta.generation));
    const [data] = await pinned.download();
    if (data.length !== job.byte_size || data.subarray(0, 5).toString() !== "%PDF-") throw new Error("Invalid PDF");
    const sha = createHash("sha256").update(data).digest("hex");
    const dest = job.source_path.replace("/staging/", "/originals/");
    // Copy the bytes actually verified, with create-only generation precondition.
    try { await objectFile(dest).save(data, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, contentType: "application/pdf" }); }
    catch (e: any) { if (Number(e.code) !== 412) throw e; }
    const [finalMeta] = await objectFile(dest).getMetadata();
    const [finalBytes] = await objectFile(dest, String(finalMeta.generation)).download();
    if (createHash("sha256").update(finalBytes).digest("hex") !== sha) throw new Error("Immutable original conflict");
    const updated = (await pool.query("UPDATE printscope_jobs SET state='queued',sha256=$2,source_path=$3,generation=$4 WHERE id=$1 AND state='uploading' RETURNING *", [job.id, sha, dest, String(finalMeta.generation)])).rows[0];
    res.json(jobDto(updated ?? (await pool.query("SELECT * FROM printscope_jobs WHERE id=$1", [job.id])).rows[0]));
  } catch { res.status(400).json({ error: "Upload verification failed: ensure the complete reserved-size file is a PDF-compatible Illustrator file" }); }
});
router.post("/printscope/jobs/:id/reinspect", async (req, res) => {
  const old = res.locals.printscopeJob;
  if (!capabilities().available) { res.status(503).json({ error: "Processing unavailable" }); return; }
  if (!old.sha256 || !old.generation) { res.status(409).json({ error: "Original has not been verified" }); return; }
  if (old.pilot_id) {
    const pilot = (await pool.query("SELECT * FROM printscope_pilots WHERE id=$1 AND environment=$2", [old.pilot_id, environment])).rows[0];
    if (!pilot || Date.now() >= new Date(pilot.purge_after).getTime() || old.assets_expired_at) { res.status(410).json({ error: "Pilot assets have expired; reinspection is unavailable" }); return; }
  }
  const version = old.pilot_id ? { id: old.rule_version_id } : await activeRules(), c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(728420)");
    const count = Number((await c.query("SELECT count(*) FROM printscope_jobs WHERE environment=$1 AND (state IN ('queued','processing') OR (state='uploading' AND created_at>now()-interval '1 hour'))", [environment])).rows[0].count);
    if (count >= 20) { await c.query("ROLLBACK"); res.status(429).json({ error: "Inspection queue is full" }); return; }
    const values = rerunValues(old, version.id, req.staff!.id);
    const job = (await c.query("INSERT INTO printscope_jobs(id,environment,state,filename,byte_size,content_type,source_path,generation,sha256,rule_version_id,submitted_by,parent_job_id,pilot_id,pilot_source_id,pilot_provenance) VALUES($1,$2,'queued',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *", [...values, old.pilot_id, old.pilot_source_id, old.pilot_provenance ? JSON.stringify(old.pilot_provenance) : null])).rows[0];
    await c.query("COMMIT"); res.status(201).json(jobDto(job));
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
});
router.get("/printscope/jobs/:id/plates/:assetId", async (req, res) => {
  const job = res.locals.printscopeJob, assetId = String(req.params.assetId);
  if (job.pilot_id) {
    const retained = (await pool.query("SELECT 1 FROM printscope_pilots WHERE id=$1 AND environment=$2 AND purge_after>now()", [job.pilot_id, environment])).rowCount;
    if (!retained || job.assets_expired_at) { res.sendStatus(410); return; }
  }
  const asset = uuid.test(assetId) && job.assets?.[assetId];
  if (job.state !== "completed" || !asset || !asset.generation || !["svg", "png"].includes(asset.kind)) { res.sendStatus(404); return; }
  res.set({ "Content-Type": asset.kind === "svg" ? "image/svg+xml" : "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'", "Content-Disposition": "inline" });
  objectFile(asset.path, asset.generation).createReadStream().on("error", () => { if (!res.headersSent) res.sendStatus(502); else res.destroy(); }).pipe(res);
});
const safeError: ErrorRequestHandler = (_err, _req, res, _next) => {
  if (!res.headersSent) res.status(503).json({ error: "PrintScope is temporarily unavailable; please retry later" });
};
router.use(safeError);
export default router;