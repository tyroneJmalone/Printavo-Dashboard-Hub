import { randomBytes } from "node:crypto";
import { copyFile, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pool } from "@workspace/db";
import { getPrivateObjectDir, objectStorageClient, parseObjectPath } from "../src/lib/objectStorage";

if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Development only");

const ADMIN_ID = "2ec667ec-c806-4c41-bb9a-e11bb5c7baf7";
const ADMIN_EMAIL = "sepscope-batch-admin@example.com";
const OWNER_MARKER = "sepscope-batch-browser-seed";
const MANIFEST = "/tmp/sepscope-batch-test-manifest.json";
const FIXTURE = process.env.PRINTSCOPE_BATCH_FIXTURE ??
  "/tmp/printscope-041.yKnzqb/printscope-fixtures/#22499 F OUTPUT.ai";
const PREFIX_ROOT = "SEPSCOPE-BATCH-TEST";

type Manifest = {
  version: 1;
  adminId: string;
  adminEmail: string;
  prefix: string;
  files: string[];
  fixture: string;
  createdAt: string;
};

function objectFile(path: string, generation?: string) {
  const { bucketName, objectName } = parseObjectPath(path);
  return objectStorageClient.bucket(bucketName).file(objectName, generation ? { generation } : undefined);
}

async function loadManifest(): Promise<Manifest> {
  const value = JSON.parse(await readFile(MANIFEST, "utf8"));
  if (value?.version !== 1 || value.adminId !== ADMIN_ID || value.adminEmail !== ADMIN_EMAIL ||
      typeof value.prefix !== "string" || !value.prefix.startsWith(`${PREFIX_ROOT}-`) ||
      !Array.isArray(value.files) || value.files.some((p: unknown) => typeof p !== "string" || !basename(p).startsWith(value.prefix))) {
    throw new Error(`Refusing to use invalid ownership manifest: ${MANIFEST}`);
  }
  return value;
}

async function setup() {
  if (process.env.NODE_ENV !== "development") throw new Error("Development only");
  const fixture = resolve(FIXTURE);
  const fixtureStat = await stat(fixture).catch((error: any) => {
    if (error?.code === "ENOENT") throw new Error(`Required known-good fixture is missing: ${fixture}`);
    throw error;
  });
  if (!fixtureStat.isFile() || fixtureStat.size < 5) throw new Error(`Known-good fixture is not a usable file: ${fixture}`);
  const header = Buffer.alloc(5);
  const fixtureBytes = await readFile(fixture);
  fixtureBytes.copy(header, 0, 0, 5);
  if (header.toString() !== "%PDF-") throw new Error(`Known-good .ai fixture is not PDF-compatible: ${fixture}`);

  try {
    const old = await loadManifest();
    const filesPresent = await Promise.all(old.files.map(async p => {
      try { return (await stat(p)).isFile(); } catch { return false; }
    }));
    const owner = (await pool.query("SELECT id,added_by_email FROM staff_users WHERE email=$1", [ADMIN_EMAIL])).rows[0];
    if (filesPresent.every(Boolean) && owner?.id === ADMIN_ID && owner?.added_by_email === OWNER_MARKER) {
      process.stdout.write(JSON.stringify({ ready: true, reused: true, adminEmail: ADMIN_EMAIL, files: old.files, manifest: MANIFEST }) + "\n");
      return;
    }
    throw new Error(`Existing ${MANIFEST} is incomplete; run cleanup before setup`);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  const conflict = (await pool.query("SELECT id,added_by_email FROM staff_users WHERE id=$1 OR email=$2", [ADMIN_ID, ADMIN_EMAIL])).rows[0];
  if (conflict) throw new Error(`Refusing to replace an existing staff identity for ${ADMIN_EMAIL}`);

  const unique = `${Date.now()}-${randomBytes(5).toString("hex")}`;
  const prefix = `${PREFIX_ROOT}-${unique}`;
  const files = [
    `/tmp/${prefix}-01.ai`,
    `/tmp/${prefix}-02.ai`,
    `/tmp/${prefix}-INVALID.txt`,
  ];
  await copyFile(fixture, files[0]);
  await copyFile(fixture, files[1]);
  await writeFile(files[2], "This intentionally invalid browser-test file is not Illustrator artwork.\n", { mode: 0o600 });

  try {
    await pool.query(
      "INSERT INTO staff_users(id,email,role,added_by_email) VALUES($1,$2,'admin',$3)",
      [ADMIN_ID, ADMIN_EMAIL, OWNER_MARKER],
    );
    const manifest: Manifest = {
      version: 1, adminId: ADMIN_ID, adminEmail: ADMIN_EMAIL, prefix, files,
      fixture, createdAt: new Date().toISOString(),
    };
    await writeFile(MANIFEST, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    process.stdout.write(JSON.stringify({
      ready: true,
      adminEmail: ADMIN_EMAIL,
      validAiFiles: files.slice(0, 2),
      invalidFile: files[2],
      manifest: MANIFEST,
      cleanup: "node ./printscope-batch-browser-seed.mjs --cleanup",
    }) + "\n");
  } catch (error) {
    await pool.query("DELETE FROM staff_users WHERE id=$1 AND email=$2 AND added_by_email=$3", [ADMIN_ID, ADMIN_EMAIL, OWNER_MARKER]);
    await Promise.all(files.map(p => unlink(p).catch(() => {})));
    throw error;
  }
}

async function cleanup() {
  if (process.env.NODE_ENV !== "development") throw new Error("Development only");
  const manifest = await loadManifest();
  const privateRoot = `${getPrivateObjectDir()}/printscope/development`;
  const prefixPattern = `${manifest.prefix}%`;
  const client = await pool.connect();
  let rows: any[] = [];
  try {
    await client.query("BEGIN");
    const discovered = (await client.query(
      `WITH RECURSIVE owned AS (
         SELECT * FROM printscope_jobs
          WHERE environment='development' AND pilot_id IS NULL
            AND submitted_by=$1 AND filename LIKE $2
         UNION
         SELECT child.* FROM printscope_jobs child JOIN owned parent ON child.parent_job_id=parent.id
          WHERE child.environment='development' AND child.pilot_id IS NULL
            AND child.submitted_by=$1 AND child.filename LIKE $2
       ) SELECT DISTINCT * FROM owned`,
      [ADMIN_ID, prefixPattern],
    )).rows;
    const ids = discovered.map(row => row.id);
    if (ids.length) {
      rows = (await client.query("SELECT * FROM printscope_jobs WHERE id=ANY($1::uuid[]) FOR UPDATE", [ids])).rows;
      if (rows.some(row => row.state === "processing")) {
        throw new Error("Cleanup refused: an owned batch-test job is processing; wait for it to finish and retry");
      }
      const unsafe = rows.find(row =>
        row.environment !== "development" || row.pilot_id !== null || row.submitted_by !== ADMIN_ID ||
        !String(row.filename).startsWith(manifest.prefix) ||
        !String(row.source_path).startsWith(`${privateRoot}/staging/`) &&
        !String(row.source_path).startsWith(`${privateRoot}/originals/`)
      );
      if (unsafe) throw new Error(`Cleanup refused: owned job ${unsafe.id} failed namespace checks`);
      await client.query(
        `UPDATE printscope_jobs SET state='failed',
           error='{"code":"TEST_CLEANUP","message":"Owned browser-test job fenced for cleanup."}'::jsonb,
           completed_at=COALESCE(completed_at,now()),lease_token=NULL,lease_until=NULL
         WHERE id=ANY($1::uuid[]) AND state IN ('uploading','queued')`,
        [ids],
      );
    }

    const exactObjects = new Map<string, string>();
    for (const row of rows) {
      if (row.source_path && row.generation) exactObjects.set(row.source_path, String(row.generation));
      for (const asset of Object.values(row.assets ?? {}) as any[]) {
        if (!asset?.path || !asset?.generation ||
            !String(asset.path).startsWith(`${privateRoot}/plates/${row.id}/`)) {
          throw new Error(`Cleanup refused: owned job ${row.id} has an invalid plate asset`);
        }
        exactObjects.set(String(asset.path), String(asset.generation));
      }
      const staging = `${privateRoot}/staging/${row.id}`;
      try {
        const [meta] = await objectFile(staging).getMetadata();
        if (meta.generation) exactObjects.set(staging, String(meta.generation));
      } catch (error: any) {
        if (Number(error?.code) !== 404) throw error;
      }
    }
    for (const [path, generation] of exactObjects) {
      if (!path.startsWith(`${privateRoot}/`)) throw new Error(`Cleanup refused object outside owned namespace: ${path}`);
      await objectFile(path, generation).delete({ ignoreNotFound: true });
    }
    if (rows.length) await client.query("DELETE FROM printscope_jobs WHERE id=ANY($1::uuid[])", [rows.map(row => row.id)]);
    const removed = await client.query(
      "DELETE FROM staff_users WHERE id=$1 AND email=$2 AND added_by_email=$3",
      [ADMIN_ID, ADMIN_EMAIL, OWNER_MARKER],
    );
    if (removed.rowCount !== 1) throw new Error("Cleanup refused: synthetic staff ownership no longer matches");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await Promise.all(manifest.files.map(p => unlink(p).catch((error: any) => {
    if (error?.code !== "ENOENT") throw error;
  })));
  await unlink(MANIFEST);
  process.stdout.write(JSON.stringify({ cleaned: true, jobs: rows.length, adminEmail: ADMIN_EMAIL }) + "\n");
}

try {
  if (process.argv.includes("--cleanup")) await cleanup();
  else await setup();
} finally {
  await pool.end();
}