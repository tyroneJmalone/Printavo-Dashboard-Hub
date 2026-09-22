import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { pool } from "@workspace/db";
import { getPrivateObjectDir, objectStorageClient, parseObjectPath } from "../objectStorage";
import { pythonRoot, parseCsv, toCsv } from "./rules";
import { logger } from "../logger";

export const MAX_BYTES = 50 * 1024 * 1024;
export const environment = process.env.REPLIT_DEPLOYMENT === "1" ? "production" : "development";
export function objectFile(path: string, generation?: string) {
  const { bucketName, objectName } = parseObjectPath(path);
  return objectStorageClient.bucket(bucketName).file(objectName, generation ? { generation } : undefined);
}
export function safeFilename(name: string) {
  return name.length > 0 && name.length <= 240 && /\.ai$/i.test(name) && !/[\\/\x00-\x1f\x7f]/.test(name) && name !== "..";
}
export function childEnvironment(dir: string) {
  const env: NodeJS.ProcessEnv = { TMPDIR: dir, HOME: dir, LANG: "C.UTF-8" };
  for (const k of ["PATH", "PYTHONPATH", "LD_LIBRARY_PATH", "LIBRARY_PATH", "FONTCONFIG_FILE", "FONTCONFIG_PATH"]) if (process.env[k]) env[k] = process.env[k];
  return env;
}
export function validateProtocol(response: any, dir: string) {
  if (response?.resultPath !== resolve(dir, "result.json") || response?.assetsRoot !== resolve(dir, "site")) throw new Error("ENGINE_PROTOCOL");
}
export function verifyRuleSnapshot(rules: any) {
  if (!rules || createHash("sha256").update(rules.csv).digest("hex") !== rules.hash ||
      !isDeepStrictEqual(parseCsv(rules.csv), rules.rows) ||
      !isDeepStrictEqual(parseCsv(toCsv(rules.rows)), rules.rows)) throw new Error("RULE_SNAPSHOT_INTEGRITY");
}
export function parseProcStat(text: string) {
  const end = text.lastIndexOf(")");
  if (end < 0) throw new Error("PROC_STAT");
  const fields = text.slice(end + 1).trim().split(/\s+/);
  const pgrp = Number(fields[2]), rssPages = Number(fields[21]);
  if (!Number.isInteger(pgrp) || !Number.isInteger(rssPages) || rssPages < 0) throw new Error("PROC_STAT");
  return { pgrp, rssPages };
}
let pageBytes: number | undefined;
async function groupRss(pid: number) {
  if (!pageBytes) {
    pageBytes = Number(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8", timeout: 2000, env: childEnvironment(tmpdir()) }).trim());
    if (!Number.isInteger(pageBytes) || pageBytes <= 0) throw new Error("PROC_PAGE_SIZE");
  }
  let pages = 0;
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const row = parseProcStat(await readFile(`/proc/${name}/stat`, "utf8"));
      if (row.pgrp === pid) pages += row.rssPages;
    } catch (e: any) { if (!["ENOENT", "ESRCH"].includes(e.code)) throw e; }
  }
  return pages * pageBytes;
}
export function runPython(args: string[], dir: string, timeout = 600_000, signal?: AbortSignal): Promise<any> {
  return new Promise((ok, fail) => {
    const child = spawn("python3", [resolve(pythonRoot(), "printscope_worker.py"), ...args], { env: childEnvironment(dir), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", bytes = 0, aborted = false, checking = false, closed = false;
    const kill = () => { aborted = true; try { process.kill(-child.pid!, "SIGKILL"); } catch {} };
    signal?.addEventListener("abort", kill, { once: true });
    if (signal?.aborted) kill();
    const timer = setTimeout(kill, timeout);
    const memory = setInterval(() => {
      if (checking || closed || !child.pid) return;
      checking = true;
      void groupRss(child.pid).then(rss => {
        if (!closed && rss > 1536 * 1024 * 1024) kill();
      }).catch(() => { if (!closed) kill(); }).finally(() => { checking = false; });
    }, 1000);
    const cleanup = () => { closed = true; clearTimeout(timer); clearInterval(memory); signal?.removeEventListener("abort", kill); };
    child.stdout.on("data", b => { bytes += b.length; if (bytes > 65536) kill(); else out += b; });
    child.stderr.on("data", b => { bytes += b.length; if (bytes > 262144) kill(); else err += b; });
    child.on("error", () => { cleanup(); fail(new Error("ENGINE_UNAVAILABLE")); });
    child.on("close", code => {
      cleanup();
      if (aborted || code !== 0) { fail(new Error(aborted ? "ENGINE_LIMIT" : classifyEngineFailure(err))); return; }
      try { ok(JSON.parse(out.trim())); } catch { fail(new Error("ENGINE_PROTOCOL")); }
    });
  });
}
export function classifyEngineFailure(stderr: string) {
  if (/ModuleNotFoundError|No module named/i.test(stderr)) return "ENGINE_PYTHON_DEPENDENCY";
  if (/(?:gs|mutool).*unavailable|No such file or directory.*(?:gs|mutool)/i.test(stderr)) return "ENGINE_RENDERER_DEPENDENCY";
  if (/renderer capability check failed|renderer did not produce/i.test(stderr)) return "ENGINE_RENDERER_PROBE";
  return "ENGINE_FAILED";
}
let capability: any = { available: false, reason: "Processing capability has not been checked" };
let lastProbeAt = 0;
let probeInFlight: Promise<any> | undefined;
export function capabilities() {
  return { ...capability, maxUploadBytes: MAX_BYTES, assistedOnly: true, retention: "Manual jobs are retained. An explicitly admin-started pilot deletes only its owned original copies and plate previews 30 days after its exact 14-day intake ends; metadata and reviews remain." };
}
export async function scopedPath(root: string, relative: string) {
  if (!relative || relative.startsWith("/") || relative.includes("\\") || relative.split("/").includes("..")) throw new Error("ASSET_SCOPE");
  const path = await realpath(resolve(root, relative)), base = await realpath(root);
  if (!path.startsWith(base + sep) || !(await stat(path)).isFile()) throw new Error("ASSET_SCOPE");
  return path;
}
export async function processOne(onlyJobId?: string, scopeEnvironment = environment) {
  const token = randomUUID();
  await pool.query(`UPDATE printscope_jobs j SET state='failed',error=$2,completed_at=now(),lease_token=NULL,lease_until=NULL
    FROM printscope_pilots p WHERE j.pilot_id=p.id AND j.environment=$1 AND p.environment=$1 AND p.purge_after<=now()
    AND j.state IN ('queued','processing')`, [scopeEnvironment, JSON.stringify({ code: "PILOT_ASSETS_EXPIRED", message: "Pilot retention period ended before inspection completed." })]);
  await pool.query("UPDATE printscope_jobs SET state='failed', error=$2, lease_token=NULL WHERE environment=$1 AND state='processing' AND lease_until < now() AND attempts>=3 AND ($3::uuid IS NULL OR id=$3)", [scopeEnvironment, JSON.stringify({ code: "ATTEMPTS_EXHAUSTED", message: "Inspection interrupted repeatedly. Reinspect to try again." }), onlyJobId ?? null]);
  const job = (await pool.query(`UPDATE printscope_jobs SET state='processing',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '90 seconds'
    WHERE id=(SELECT j.id FROM printscope_jobs j LEFT JOIN printscope_pilots p ON p.id=j.pilot_id
      WHERE j.environment=$1 AND j.attempts<3 AND ($3::uuid IS NULL OR j.id=$3)
      AND (p.id IS NULL OR p.purge_after>now()) AND (j.state='queued' OR (j.state='processing' AND j.lease_until<now()))
      ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1) RETURNING *`, [scopeEnvironment, token, onlyJobId ?? null])).rows[0];
  if (!job) return;
  const dir = await mkdtemp(resolve(tmpdir(), "printscope-"));
  const abort = new AbortController();
  let finalized = false;
  const assetPrefix = job.source_path.substring(0, job.source_path.lastIndexOf("/originals/")) + `/plates/${job.id}/${token}/`;
  const assertLease = async () => {
    if (abort.signal.aborted) throw new Error("LEASE_LOST");
    try {
      const lease = await pool.query("SELECT id FROM printscope_jobs WHERE id=$1 AND lease_token=$2 AND state='processing' AND lease_until>now()", [job.id, token]);
      if (!lease.rowCount) throw new Error("LEASE_LOST");
    } catch { abort.abort(); throw new Error("LEASE_LOST"); }
  };
  const heartbeat = setInterval(() => {
    void pool.query("UPDATE printscope_jobs SET lease_until=now()+interval '90 seconds' WHERE id=$1 AND lease_token=$2 AND state='processing' AND lease_until>now()", [job.id, token])
      .then(r => { if (!r.rowCount) abort.abort(); }).catch(() => abort.abort());
  }, 20000);
  try {
    const [data] = await objectFile(job.source_path, job.generation).download();
    if (data.length !== job.byte_size || createHash("sha256").update(data).digest("hex") !== job.sha256) throw new Error("SOURCE_INTEGRITY");
    const rules = (await pool.query("SELECT csv,rows,hash FROM printscope_rule_versions WHERE id=$1", [job.rule_version_id])).rows[0];
    verifyRuleSnapshot(rules);
    await assertLease();
    if (!safeFilename(job.filename)) throw new Error("SOURCE_NAME");
    const input = resolve(dir, job.filename);
    await writeFile(input, data);
    await writeFile(resolve(dir, "rules.csv"), rules.csv);
    const output = resolve(dir, "output");
    await mkdir(output);
    const response = await runPython(["--input", input, "--output-dir", output, "--rules", resolve(dir, "rules.csv")], dir, 600_000, abort.signal);
    // Protocol paths are fixed by the Hub, never used as arbitrary read locations.
    validateProtocol(response, output);
    const resultFile = await scopedPath(output, "result.json");
    if ((await stat(resultFile)).size > 30 * 1024 * 1024) throw new Error("RESULT_LIMIT");
    const result = JSON.parse(await readFile(resultFile, "utf8"));
    if (!Array.isArray(result.results) || !Array.isArray(result.previews) || typeof result.completeness?.complete !== "boolean" || !["pass", "flag", "fail"].includes(result.verdict)) throw new Error("ENGINE_PROTOCOL");
    const assets: Record<string, { path: string; kind: string; generation: string }> = {};
    let totalBytes = 0;
    for (const preview of result.previews) for (const plate of preview.plates ?? []) {
      if (!["svg", "png"].includes(plate.kind) || typeof plate.src !== "string" || !plate.src.endsWith("." + plate.kind)) throw new Error("ASSET_TYPE");
      const path = await scopedPath(resolve(output, "site"), plate.src);
      totalBytes += (await stat(path)).size;
      if (totalBytes > 200 * 1024 * 1024 || Object.keys(assets).length >= 300) throw new Error("ASSET_LIMIT");
      const assetId = randomUUID(), dest = `${assetPrefix}${assetId}.${plate.kind}`;
      await assertLease();
      await objectFile(dest).save(await readFile(path), { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, contentType: plate.kind === "svg" ? "image/svg+xml" : "image/png" });
      const [metadata] = await objectFile(dest).getMetadata();
      if (!metadata.generation) throw new Error("ASSET_GENERATION");
      const generation = String(metadata.generation);
      assets[assetId] = { path: dest, kind: plate.kind, generation };
      plate.src = `/api/printscope/jobs/${job.id}/plates/${assetId}`;
    }
    await assertLease();
    const completion = await pool.query(`UPDATE printscope_jobs j SET state='completed',result=$3,assets=$4,completed_at=now(),lease_until=NULL
      WHERE j.id=$1 AND j.lease_token=$2 AND j.state='processing' AND j.lease_until>now()
      AND NOT EXISTS (SELECT 1 FROM printscope_pilots p WHERE p.id=j.pilot_id AND p.purge_after<=now())`, [job.id, token, JSON.stringify(result), JSON.stringify(assets)]);
    if (!completion.rowCount) throw new Error("LEASE_LOST");
    finalized = true;
  } catch (e) {
    const code = e instanceof Error && /^[A-Z_]+$/.test(e.message) ? e.message : "PROCESSING_FAILED";
    if (!abort.signal.aborted) await pool.query("UPDATE printscope_jobs SET state='failed',error=$3,completed_at=now(),lease_until=NULL WHERE id=$1 AND lease_token=$2 AND state='processing' AND lease_until>now()", [job.id, token, JSON.stringify({ code, message: "Inspection could not finish. Reinspect to retry; contact an administrator if this persists." })]);
  } finally {
    clearInterval(heartbeat);
    if (!finalized) {
      try {
        const state = (await pool.query("SELECT state,lease_token FROM printscope_jobs WHERE id=$1", [job.id])).rows[0];
        // An UPDATE can commit even when its network response is lost. Never remove
        // committed assets; if DB ownership cannot be checked, retain rather than guess.
        if (!(state?.state === "completed" && state.lease_token === token)) {
          const { bucketName, objectName } = parseObjectPath(assetPrefix);
          const [files] = await objectStorageClient.bucket(bucketName).getFiles({ prefix: objectName });
          for (const file of files) {
            const [metadata] = await file.getMetadata();
            if (metadata.generation) await objectFile(`/${bucketName}/${file.name}`, String(metadata.generation)).delete({ ignoreNotFound: true });
          }
        }
      } catch { logger.warn("PrintScope attempt asset cleanup deferred"); }
    }
    await rm(dir, { recursive: true, force: true });
  }
}
let started = false, busy = false;
export type PilotAssetDelete = (path: string, generation: string) => Promise<void>;
const deletePilotAsset: PilotAssetDelete = async (path, generation) => {
  await objectFile(path, generation).delete({ ignoreNotFound: true });
};
export async function cleanupExpiredPrintscopePilots(batch = 10, remove: PilotAssetDelete = deletePilotAsset, scopeEnvironment = environment) {
  const pilots = (await pool.query(`SELECT id FROM printscope_pilots WHERE environment=$1 AND purge_after<=now()
    AND EXISTS (SELECT 1 FROM printscope_jobs WHERE pilot_id=printscope_pilots.id AND assets_expired_at IS NULL)
    ORDER BY purge_after LIMIT $2`, [scopeEnvironment, batch])).rows;
  for (const pilot of pilots) {
    const jobs = (await pool.query("SELECT id,source_path,generation,assets FROM printscope_jobs WHERE environment=$1 AND pilot_id=$2 AND assets_expired_at IS NULL", [scopeEnvironment, pilot.id])).rows;
    if (!jobs.length) continue;
    try {
      const pilotRoot = `${getPrivateObjectDir()}/printscope/${scopeEnvironment}/pilots/${pilot.id}`;
      const inOriginalScope = (job: any) => !job.source_path || !job.generation || job.source_path.startsWith(`${pilotRoot}/originals/`);
      const inPlateScope = (job: any, asset: any) => asset?.path && asset?.generation && asset.path.startsWith(`${pilotRoot}/plates/${job.id}/`);
      if (jobs.some(job => !inOriginalScope(job) || Object.values(job.assets ?? {}).some(asset => !inPlateScope(job, asset)))) {
        await pool.query("UPDATE printscope_jobs SET cleanup_attempted_at=now(),cleanup_error='OWNERSHIP_SCOPE_VIOLATION' WHERE environment=$1 AND pilot_id=$2 AND assets_expired_at IS NULL", [scopeEnvironment, pilot.id]);
        logger.warn({ pilotId: pilot.id, jobs: jobs.length }, "PrintScope pilot cleanup blocked by ownership scope");
        continue;
      }
      await pool.query(`UPDATE printscope_jobs SET state='failed',error=$3,completed_at=COALESCE(completed_at,now()),lease_token=NULL,lease_until=NULL,cleanup_attempted_at=now()
        WHERE environment=$1 AND pilot_id=$2 AND assets_expired_at IS NULL AND state IN ('queued','processing')`, [scopeEnvironment, pilot.id, JSON.stringify({ code: "PILOT_ASSETS_EXPIRED", message: "Pilot retention period ended." })]);
      for (const job of jobs) for (const asset of Object.values(job.assets ?? {}) as any[]) {
        if (asset?.path && asset?.generation) await remove(asset.path, asset.generation);
      }
      const originals = new Map<string, string>();
      for (const job of jobs) if (job.source_path && job.generation) originals.set(job.source_path, job.generation);
      let originalsDeleted = 0, sharedOriginalsPreserved = 0;
      for (const [path, generation] of originals) {
        const shared = (await pool.query(`SELECT 1 FROM printscope_jobs j LEFT JOIN printscope_pilots p ON p.id=j.pilot_id
          WHERE j.source_path=$1 AND j.generation=$2 AND j.pilot_id IS DISTINCT FROM $3
          AND (j.pilot_id IS NULL OR p.purge_after>now() OR j.assets_expired_at IS NULL) LIMIT 1`, [path, generation, pilot.id])).rowCount;
        if (shared) sharedOriginalsPreserved++;
        else { await remove(path, generation); originalsDeleted++; }
      }
      await pool.query("UPDATE printscope_jobs SET assets_expired_at=now(),assets=NULL,cleanup_error=NULL,cleanup_attempted_at=now() WHERE environment=$1 AND pilot_id=$2 AND assets_expired_at IS NULL", [scopeEnvironment, pilot.id]);
      logger.info({ pilotId: pilot.id, jobs: jobs.length, originalsDeleted, sharedOriginalsPreserved }, "PrintScope pilot assets expired");
    } catch {
      await pool.query("UPDATE printscope_jobs SET cleanup_attempted_at=now(),cleanup_error='Storage cleanup will retry' WHERE environment=$1 AND pilot_id=$2 AND assets_expired_at IS NULL", [scopeEnvironment, pilot.id]);
      logger.warn({ pilotId: pilot.id, jobs: jobs.length }, "PrintScope pilot asset cleanup deferred");
    }
  }
}
export async function probePrintscope() {
  lastProbeAt = Date.now();
  const dir = await mkdtemp(resolve(tmpdir(), "printscope-probe-"));
  try {
    const probe = await runPython(["--probe"], dir, 30000);
    capability = probe.available === true && !!process.env.PRIVATE_OBJECT_DIR ? { available: true, engineVersion: probe.engineVersion, measureDpi: probe.measureDpi, ghostscript: String(probe.ghostscript), mupdf: String(probe.mupdf) } : { available: false, reason: process.env.PRIVATE_OBJECT_DIR ? "ENGINE_PROBE_REJECTED" : "PRIVATE_STORAGE_UNAVAILABLE" };
  } catch (error) {
    const code = error instanceof Error && /^ENGINE_[A-Z_]+$/.test(error.message) ? error.message : "ENGINE_PROBE_FAILED";
    capability = { available: false, reason: code };
  }
  finally { await rm(dir, { recursive: true, force: true }); }
  return capabilities();
}
export async function ensurePrintscopeAvailable(retryAfterMs = 60_000) {
  if (capability.available) return capabilities();
  // A caller arriving during a probe must await that probe rather than observe
  // the stale unavailable snapshot merely because lastProbeAt was just updated.
  if (probeInFlight) return probeInFlight;
  if (Date.now() - lastProbeAt < retryAfterMs) return capabilities();
  const prior = capabilities();
  probeInFlight = probePrintscope().then(next => {
    if (next.available) logger.info({ engineVersion: next.engineVersion, ghostscript: next.ghostscript, mupdf: next.mupdf }, "PrintScope processing recovered");
    else logger.warn({ reason: next.reason, reasonChanged: next.reason !== prior.reason }, "PrintScope processing recovery probe failed");
    return next;
  }).finally(() => { probeInFlight = undefined; });
  return probeInFlight;
}
export async function startPrintscopeWorker() {
  if (started) return; started = true;
  await probePrintscope();
  if (capability.available) logger.info({ engineVersion: capability.engineVersion, ghostscript: capability.ghostscript, mupdf: capability.mupdf }, "PrintScope processing available");
  else logger.warn({ reason: capability.reason }, "PrintScope processing unavailable");
  setInterval(() => { void cleanupExpiredPrintscopePilots().catch(() => logger.warn("PrintScope pilot cleanup temporarily unavailable")); }, 60_000).unref();
  setInterval(() => {
    if (busy) return;
    if (!capability.available) {
      void ensurePrintscopeAvailable().catch(() => logger.warn({ reason: "ENGINE_PROBE_FAILED" }, "PrintScope processing recovery probe failed"));
      return;
    }
    busy = true;
    void processOne().catch(() => logger.warn("PrintScope queue temporarily unavailable")).finally(() => { busy = false; });
  }, 3000).unref();
}