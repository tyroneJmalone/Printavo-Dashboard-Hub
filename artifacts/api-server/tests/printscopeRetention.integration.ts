import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { getPrivateObjectDir } from "../src/lib/objectStorage";
import { cleanupExpiredPrintscopePilots, environment, objectFile, processOne } from "../src/lib/printscope/worker";

if (environment !== "development" || process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Development only");

const run = randomUUID();
const expiredPilot = randomUUID();
const nonexpiredPilot = randomUUID();
const completedJob = randomUUID();
const sharedPilotJob = randomUUID();
const staleJob = randomUUID();
const manualJob = randomUUID();
const nonexpiredJob = randomUUID();
const wrongPrefixJob = randomUUID();
const reviewId = randomUUID();
const actor = randomUUID();
const testEnvironment = `development-retention-${run}`;
const base = `${getPrivateObjectDir()}/printscope/${testEnvironment}/pilots/${expiredPilot}`;
const paths = {
  original: `${base}/originals/source-one/expired-original.ai`,
  plate: `${base}/plates/${completedJob}/attempt/expired-plate.png`,
  shared: `${base}/originals/source-two/shared-original.ai`,
  stale: `${base}/originals/source-three/stale-original.ai`,
  manualPlate: `${getPrivateObjectDir()}/printscope/development/manual-retention-decoy-${run}.png`,
  nonexpired: `${getPrivateObjectDir()}/printscope/${testEnvironment}-decoy/pilots/${nonexpiredPilot}/originals/source/nonexpired-original.ai`,
  mirror: `${getPrivateObjectDir()}/pv-files/retention-integration-${run}/production_file/mirror.ai`,
};
const createdObjects: { path: string; generation: string }[] = [];

async function put(path: string, data: string) {
  await objectFile(path).save(Buffer.from(data), { resumable: false, preconditionOpts: { ifGenerationMatch: 0 }, contentType: "application/pdf" });
  const [meta] = await objectFile(path).getMetadata();
  const generation = String(meta.generation);
  createdObjects.push({ path, generation });
  return generation;
}
async function exists(path: string, generation: string) {
  const [present] = await objectFile(path, generation).exists();
  return present;
}

const rule = (await pool.query("SELECT id FROM printscope_rule_versions ORDER BY id DESC LIMIT 1")).rows[0];
if (!rule) throw new Error("PrintScope rule version missing");

try {
  const generation: Record<string, string> = {};
  for (const [key, path] of Object.entries(paths)) generation[key] = await put(path, `%PDF-${key}-${run}`);
  await pool.query(`INSERT INTO printscope_pilots(id,environment,rule_version_id,created_by,started_at,ends_at,purge_after)
    VALUES($1,$5,$3,$4,now()-interval '50 days',now()-interval '36 days',now()-interval '6 days'),
          ($2,$6,$3,$4,now(),now()+interval '14 days',now()+interval '44 days')`,
    [expiredPilot, nonexpiredPilot, rule.id, actor, testEnvironment, `${testEnvironment}-decoy`]);
  const result = { verdict: "pass", completeness: { complete: true }, results: [], previews: [{ plates: [{ kind: "png", src: `/api/printscope/jobs/${completedJob}/plates/${reviewId}` }] }] };
  await pool.query(`INSERT INTO printscope_jobs(id,environment,state,filename,byte_size,content_type,source_path,generation,sha256,rule_version_id,submitted_by,pilot_id,pilot_source_id,pilot_provenance,result,assets,completed_at)
    VALUES
    ($1,$25,'completed','expired.ai',20,'application/pdf',$7,$8,repeat('a',64),$13,$14,$6,$15,'{}',$16,$17,now()),
    ($2,$25,'completed','shared.ai',20,'application/pdf',$9,$10,repeat('b',64),$13,$14,$6,$18,'{}',$16,'{}',now()),
    ($3,$25,'queued','stale.ai',20,'application/pdf',$11,$12,repeat('c',64),$13,$14,$6,$19,'{}',NULL,NULL,NULL),
    ($4,$25,'completed','manual.ai',20,'application/pdf',$9,$10,repeat('b',64),$13,$14,NULL,NULL,NULL,'{}',$20,now()),
    ($5,$26,'completed','nonexpired.ai',20,'application/pdf',$21,$22,repeat('d',64),$13,$14,$23,$24,'{}','{}','{}',now())`,
    [completedJob, sharedPilotJob, staleJob, manualJob, nonexpiredJob, expiredPilot, paths.original, generation.original,
      paths.shared, generation.shared, paths.stale, generation.stale, rule.id, actor, randomUUID(), JSON.stringify(result),
      JSON.stringify({ [reviewId]: { path: paths.plate, kind: "png", generation: generation.plate } }), randomUUID(),
      randomUUID(), JSON.stringify({ [randomUUID()]: { path: paths.manualPlate, kind: "png", generation: generation.manualPlate } }),
      paths.nonexpired, generation.nonexpired, nonexpiredPilot, randomUUID(), testEnvironment, `${testEnvironment}-decoy`]);
  await pool.query("INSERT INTO printscope_pilot_reviews(id,job_id,outcome,reason,note,reviewer_id) VALUES($1,$2,'flag','retention-test','must remain',$3)", [reviewId, completedJob, actor]);

  await processOne(staleJob, testEnvironment);
  const stale = (await pool.query("SELECT state,error FROM printscope_jobs WHERE id=$1", [staleJob])).rows[0];
  assert.equal(stale.state, "failed");
  assert.equal(stale.error.code, "PILOT_ASSETS_EXPIRED");

  let failedOnce = false;
  await cleanupExpiredPrintscopePilots(10, async (path, generationValue) => {
    assert.ok(createdObjects.some(o => o.path === path && o.generation === generationValue), "cleanup must use an exact recorded generation");
    if (!failedOnce && path === paths.plate) { failedOnce = true; throw new Error("controlled delete failure"); }
    await objectFile(path, generationValue).delete({ ignoreNotFound: true });
  }, testEnvironment);
  assert.equal(failedOnce, true);
  assert.equal((await pool.query("SELECT assets_expired_at FROM printscope_jobs WHERE id=$1", [completedJob])).rows[0].assets_expired_at, null);
  assert.equal(await exists(paths.original, generation.original), true);
  assert.equal(await exists(paths.plate, generation.plate), true);

  await cleanupExpiredPrintscopePilots(10, undefined, testEnvironment);
  assert.equal(await exists(paths.original, generation.original), false);
  assert.equal(await exists(paths.plate, generation.plate), false);
  assert.equal(await exists(paths.stale, generation.stale), false);
  assert.equal(await exists(paths.shared, generation.shared), true);
  assert.equal(await exists(paths.manualPlate, generation.manualPlate), true);
  assert.equal(await exists(paths.nonexpired, generation.nonexpired), true);
  assert.equal(await exists(paths.mirror, generation.mirror), true);
  const retained = (await pool.query("SELECT state,result,assets,assets_expired_at FROM printscope_jobs WHERE id=$1", [completedJob])).rows[0];
  assert.equal(retained.state, "completed");
  assert.deepEqual(retained.result, result);
  assert.equal(retained.assets, null);
  assert.ok(retained.assets_expired_at);
  assert.equal(Number((await pool.query("SELECT count(*) FROM printscope_pilot_reviews WHERE id=$1 AND job_id=$2", [reviewId, completedJob])).rows[0].count), 1);

  const markedAt = retained.assets_expired_at;
  await cleanupExpiredPrintscopePilots(10, undefined, testEnvironment);
  assert.equal(String((await pool.query("SELECT assets_expired_at FROM printscope_jobs WHERE id=$1", [completedJob])).rows[0].assets_expired_at), String(markedAt));
  assert.equal(await exists(paths.shared, generation.shared), true);

  await pool.query(`INSERT INTO printscope_jobs(id,environment,state,filename,byte_size,content_type,source_path,generation,sha256,rule_version_id,submitted_by,pilot_id,pilot_source_id,pilot_provenance,result,assets,completed_at)
    VALUES($1,$9,'completed','wrong-prefix.ai',20,'application/pdf',$2,$3,repeat('e',64),$4,$5,$6,$7,'{}','{}',$8,now())`,
    [wrongPrefixJob, paths.mirror, generation.mirror, rule.id, actor, expiredPilot, randomUUID(),
      JSON.stringify({ [randomUUID()]: { path: paths.manualPlate, kind: "png", generation: generation.manualPlate } }), testEnvironment]);
  await cleanupExpiredPrintscopePilots(10, undefined, testEnvironment);
  const wrongPrefix = (await pool.query("SELECT assets_expired_at,cleanup_error FROM printscope_jobs WHERE id=$1", [wrongPrefixJob])).rows[0];
  assert.equal(wrongPrefix.assets_expired_at, null);
  assert.equal(wrongPrefix.cleanup_error, "OWNERSHIP_SCOPE_VIOLATION");
  assert.equal(await exists(paths.mirror, generation.mirror), true);
  assert.equal(await exists(paths.manualPlate, generation.manualPlate), true);
  process.stdout.write(JSON.stringify({ passed: true, exactGenerationDeletes: true, retryVerified: true, idempotent: true, staleWorkerFenced: true, retainedResultAndReview: true, decoysPreserved: true }) + "\n");
} finally {
  await pool.query("DELETE FROM printscope_pilot_reviews WHERE job_id=ANY($1::uuid[])", [[completedJob, sharedPilotJob, staleJob, wrongPrefixJob]]);
  await pool.query("DELETE FROM printscope_jobs WHERE id=ANY($1::uuid[])", [[completedJob, sharedPilotJob, staleJob, manualJob, nonexpiredJob, wrongPrefixJob]]);
  await pool.query("DELETE FROM printscope_pilots WHERE id=ANY($1::uuid[])", [[expiredPilot, nonexpiredPilot]]);
  for (const object of createdObjects) await objectFile(object.path, object.generation).delete({ ignoreNotFound: true });
  assert.equal(Number((await pool.query("SELECT count(*) FROM printscope_jobs WHERE id=ANY($1::uuid[])", [[completedJob, sharedPilotJob, staleJob, manualJob, nonexpiredJob, wrongPrefixJob]])).rows[0].count), 0);
  assert.equal(Number((await pool.query("SELECT count(*) FROM printscope_pilots WHERE id=ANY($1::uuid[])", [[expiredPilot, nonexpiredPilot]])).rows[0].count), 0);
  for (const object of createdObjects) assert.equal(await exists(object.path, object.generation), false);
  const browser = (await pool.query("SELECT object_path FROM pv_files WHERE id='51f1178d-cc1b-4dc5-9127-2ec22cd3d103' AND status='mirrored'")).rows[0];
  assert.ok(browser, "browser source seed must remain");
  assert.equal((await objectFile(browser.object_path).exists())[0], true, "browser source object must remain");
  process.stdout.write(JSON.stringify({ cleanupVerified: true, browserFixturePreserved: true }) + "\n");
  await pool.end();
}