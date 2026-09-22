import { Router, type ErrorRequestHandler } from "express";
import { randomUUID, createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { CreatePrintscopeUploadBody, UpdatePrintscopeRulesBody } from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireStaff";
import { getPrivateObjectDir, parseObjectPath } from "../lib/objectStorage";
import { activeRules, ruleDto, ruleDefinitions, validateRules, toCsv, versionMatches } from "../lib/printscope/rules";
import { capabilities, environment, MAX_BYTES, objectFile, safeFilename } from "../lib/printscope/worker";

const router = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function jobDto(j: any) {
  return { id: j.id, state: j.state, filename: j.filename, byteSize: j.byte_size, sha256: j.sha256, ruleVersionId: j.rule_version_id, submittedBy: j.submitted_by, createdAt: j.created_at, completedAt: j.completed_at, parentJobId: j.parent_job_id, result: j.result, error: j.error };
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
  const version = await activeRules(), c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(728420)");
    const count = Number((await c.query("SELECT count(*) FROM printscope_jobs WHERE environment=$1 AND (state IN ('queued','processing') OR (state='uploading' AND created_at>now()-interval '1 hour'))", [environment])).rows[0].count);
    if (count >= 20) { await c.query("ROLLBACK"); res.status(429).json({ error: "Inspection queue is full" }); return; }
    const job = (await c.query("INSERT INTO printscope_jobs(id,environment,state,filename,byte_size,content_type,source_path,generation,sha256,rule_version_id,submitted_by,parent_job_id) VALUES($1,$2,'queued',$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *", rerunValues(old, version.id, req.staff!.id))).rows[0];
    await c.query("COMMIT"); res.status(201).json(jobDto(job));
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
});
router.get("/printscope/jobs/:id/plates/:assetId", async (req, res) => {
  const job = res.locals.printscopeJob, assetId = String(req.params.assetId);
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