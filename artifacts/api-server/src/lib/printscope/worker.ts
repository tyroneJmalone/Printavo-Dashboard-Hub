import { spawn, execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { pool } from "@workspace/db";
import { objectStorageClient, parseObjectPath } from "../objectStorage";
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
    let out = "", bytes = 0, aborted = false, checking = false, closed = false;
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
    child.stderr.on("data", b => { bytes += b.length; if (bytes > 262144) kill(); });
    child.on("error", () => { cleanup(); fail(new Error("ENGINE_UNAVAILABLE")); });
    child.on("close", code => {
      cleanup();
      if (aborted || code !== 0) { fail(new Error(aborted ? "ENGINE_LIMIT" : "ENGINE_FAILED")); return; }
      try { ok(JSON.parse(out.trim())); } catch { fail(new Error("ENGINE_PROTOCOL")); }
    });
  });
}
let capability: any = { available: false, reason: "Processing capability has not been checked" };
export function capabilities() {
  return { ...capability, maxUploadBytes: MAX_BYTES, assistedOnly: true, retention: "No automatic deletion; retention policy pending." };
}
export async function scopedPath(root: string, relative: string) {
  if (!relative || relative.startsWith("/") || relative.includes("\\") || relative.split("/").includes("..")) throw new Error("ASSET_SCOPE");
  const path = await realpath(resolve(root, relative)), base = await realpath(root);
  if (!path.startsWith(base + sep) || !(await stat(path)).isFile()) throw new Error("ASSET_SCOPE");
  return path;
}
export async function processOne(onlyJobId?: string) {
  const token = randomUUID();
  await pool.query("UPDATE printscope_jobs SET state='failed', error=$2, lease_token=NULL WHERE environment=$1 AND state='processing' AND lease_until < now() AND attempts>=3 AND ($3::uuid IS NULL OR id=$3)", [environment, JSON.stringify({ code: "ATTEMPTS_EXHAUSTED", message: "Inspection interrupted repeatedly. Reinspect to try again." }), onlyJobId ?? null]);
  const job = (await pool.query(`UPDATE printscope_jobs SET state='processing',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '90 seconds'
    WHERE id=(SELECT id FROM printscope_jobs WHERE environment=$1 AND attempts<3 AND ($3::uuid IS NULL OR id=$3) AND (state='queued' OR (state='processing' AND lease_until<now())) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [environment, token, onlyJobId ?? null])).rows[0];
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
    const completion = await pool.query("UPDATE printscope_jobs SET state='completed',result=$3,assets=$4,completed_at=now(),lease_until=NULL WHERE id=$1 AND lease_token=$2 AND state='processing' AND lease_until>now()", [job.id, token, JSON.stringify(result), JSON.stringify(assets)]);
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
export async function probePrintscope() {
  const dir = await mkdtemp(resolve(tmpdir(), "printscope-probe-"));
  try {
    const probe = await runPython(["--probe"], dir, 30000);
    capability = probe.available === true && !!process.env.PRIVATE_OBJECT_DIR ? { available: true, engineVersion: probe.engineVersion, measureDpi: probe.measureDpi, ghostscript: String(probe.ghostscript), mupdf: String(probe.mupdf) } : { available: false, reason: "Engine dependencies or private storage unavailable" };
  } catch { capability = { available: false, reason: "Engine dependencies unavailable" }; }
  finally { await rm(dir, { recursive: true, force: true }); }
  return capabilities();
}
export async function startPrintscopeWorker() {
  if (started) return; started = true;
  await probePrintscope();
  if (!capability.available) return;
  setInterval(() => {
    if (busy) return; busy = true;
    void processOne().catch(() => logger.warn("PrintScope queue temporarily unavailable")).finally(() => { busy = false; });
  }, 3000).unref();
}