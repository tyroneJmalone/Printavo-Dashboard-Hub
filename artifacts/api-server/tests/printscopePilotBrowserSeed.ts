import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "@workspace/db";
import { getPrivateObjectDir, objectStorageClient, parseObjectPath } from "../src/lib/objectStorage";

if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Development only");
function objectFile(path: string, generation?: string) {
  const { bucketName, objectName } = parseObjectPath(path);
  return objectStorageClient.bucket(bucketName).file(objectName, generation ? { generation } : undefined);
}

const ADMIN_ID = "51f1178d-cc1b-4dc5-9127-2ec22cd3d101";
const STAFF_ID = "51f1178d-cc1b-4dc5-9127-2ec22cd3d102";
const SOURCE_ID = "51f1178d-cc1b-4dc5-9127-2ec22cd3d103";
const ORDER_ID = "printscope-pilot-browser-fixture-2026";
const VISUAL_ID = -26032026;
const FIXTURE_NAME = "PRINTSCOPE-PILOT-BROWSER-ONLY-22499-F.ai";
const MANIFEST = "/tmp/printscope-pilot-browser-seed.json";
const FIXTURE_DIR = process.env.PRINTSCOPE_FIXTURES ?? "/tmp/printscope-041.yKnzqb/printscope-fixtures";
const fixturePath = resolve(FIXTURE_DIR, "#22499 F OUTPUT.ai");
const objectPath = `${getPrivateObjectDir()}/printscope/development/browser-fixture/${SOURCE_ID}.ai`;

async function cleanup() {
  const pilot = (await pool.query("SELECT id FROM printscope_pilots WHERE environment='development' AND created_by=$1", [ADMIN_ID])).rows[0];
  if (pilot) {
    const jobs = (await pool.query("SELECT source_path,generation,assets FROM printscope_jobs WHERE environment='development' AND pilot_id=$1", [pilot.id])).rows;
    for (const job of jobs) {
      for (const asset of Object.values(job.assets ?? {}) as any[]) if (asset?.path && asset?.generation) await objectFile(asset.path, asset.generation).delete({ ignoreNotFound: true });
      if (job.source_path && job.generation) await objectFile(job.source_path, job.generation).delete({ ignoreNotFound: true });
    }
    await pool.query("DELETE FROM printscope_pilot_reviews WHERE job_id IN (SELECT id FROM printscope_jobs WHERE pilot_id=$1)", [pilot.id]);
    await pool.query("DELETE FROM printscope_jobs WHERE pilot_id=$1", [pilot.id]);
    await pool.query("DELETE FROM printscope_pilots WHERE id=$1", [pilot.id]);
  }
  await objectFile(objectPath).delete({ ignoreNotFound: true });
  await pool.query("DELETE FROM pv_files WHERE id=$1 AND order_printavo_id=$2", [SOURCE_ID, ORDER_ID]);
  await pool.query("DELETE FROM pv_orders WHERE printavo_id=$1", [ORDER_ID]);
  await pool.query("DELETE FROM staff_users WHERE (id=$1 AND email='printscope-pilot-admin@example.com') OR (id=$2 AND email='printscope-pilot-staff@example.com')", [ADMIN_ID, STAFF_ID]);
  try {
    const saved = JSON.parse(await readFile(MANIFEST, "utf8"));
    if (saved.moduleAdded === true) {
      await pool.query(`UPDATE app_settings SET value=jsonb_set(value,'{enabled}',COALESCE(value->'enabled','[]'::jsonb) - 'printscope'),updated_at=now() WHERE key='module_access'`);
    }
  } catch {}
  process.stdout.write(JSON.stringify({ cleaned: true, fixtureName: FIXTURE_NAME }) + "\n");
}

async function setup() {
  const migration = await readFile(resolve(process.cwd(), "../../lib/db/src/printscope-additive.sql"), "utf8");
  await pool.query(migration);
  const existing = (await pool.query("SELECT id,ends_at,purge_after FROM printscope_pilots WHERE environment='development'")).rows[0];
  if (existing) {
    process.stdout.write(JSON.stringify({ ready: false, blockedByExistingDevelopmentPilot: true, fixtureName: FIXTURE_NAME }) + "\n");
    return;
  }
  const moduleRow = (await pool.query("SELECT value FROM app_settings WHERE key='module_access'")).rows[0];
  const enabled: string[] = Array.isArray(moduleRow?.value?.enabled) ? moduleRow.value.enabled : [];
  const moduleAdded = !enabled.includes("printscope");
  if (moduleRow) await pool.query(`UPDATE app_settings SET value=jsonb_set(value,'{enabled}',to_jsonb($1::text[])),updated_at=now() WHERE key='module_access'`, [[...enabled, "printscope"]]);
  else await pool.query("INSERT INTO app_settings(key,value) VALUES('module_access',$1)", [JSON.stringify({ enabled: ["printscope"] })]);
  await pool.query(`INSERT INTO staff_users(id,email,role,added_by_email) VALUES
    ($1,'printscope-pilot-admin@example.com','admin','printscope-pilot-browser-seed'),
    ($2,'printscope-pilot-staff@example.com','staff','printscope-pilot-browser-seed')
    ON CONFLICT (email) DO UPDATE SET role=excluded.role,updated_at=now()`, [ADMIN_ID, STAFF_ID]);
  await pool.query(`INSERT INTO pv_orders(printavo_id,visual_id,order_type,data,content_hash,extras_stale,files_stale)
    VALUES($1,$2,'invoice',$3,'synthetic-printscope-browser-fixture',false,false)
    ON CONFLICT (printavo_id) DO UPDATE SET files_stale=false,extras_stale=false`, [ORDER_ID, VISUAL_ID, JSON.stringify({ synthetic: true, purpose: "printscope-pilot-browser" })]);
  const bytes = await readFile(fixturePath);
  await objectFile(objectPath).save(bytes, { resumable: false, contentType: "application/pdf" });
  await pool.query(`INSERT INTO pv_files(id,order_printavo_id,order_visual_id,source_kind,source_id,source_url,file_name,mime_type,byte_size,object_path,status,mirrored_at)
    VALUES($1,$2,$3,'production_file','browser-fixture','synthetic://printscope-pilot-browser',$4,'application/pdf',$5,$6,'mirrored',now())
    ON CONFLICT (id) DO UPDATE SET file_name=excluded.file_name,byte_size=excluded.byte_size,object_path=excluded.object_path,status='mirrored',mirrored_at=now()`,
    [SOURCE_ID, ORDER_ID, VISUAL_ID, FIXTURE_NAME, bytes.length, objectPath]);
  await writeFile(MANIFEST, JSON.stringify({ moduleAdded, ids: { admin: ADMIN_ID, staff: STAFF_ID, source: SOURCE_ID, order: ORDER_ID }, objectPath }), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ready: true, fixtureName: FIXTURE_NAME, adminEmail: "printscope-pilot-admin@example.com", staffEmail: "printscope-pilot-staff@example.com", cleanup: "pnpm --filter @workspace/api-server run printscope:pilot-browser-cleanup" }) + "\n");
}

try {
  if (process.argv.includes("--cleanup")) await cleanup();
  else await setup();
} finally {
  await pool.end();
}