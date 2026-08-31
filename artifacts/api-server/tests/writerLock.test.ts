import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  claimEmailSyncWriterAs,
  releaseEmailSyncWriter,
} from "../src/lib/emailActivity/writerLock";

async function leaseOwner(): Promise<string | null> {
  const r = await db.execute(
    sql`select value->>'environment' as owner from app_settings where key = 'email_sync_writer'`,
  );
  return (r.rows[0]?.owner as string | undefined) ?? null;
}

test("lease election: dev claims a free lease, prod takes over, dev then stands down", async () => {
  await releaseEmailSyncWriter();

  assert.equal(await claimEmailSyncWriterAs("development"), true, "dev claims a free lease");
  assert.equal(await leaseOwner(), "development");
  assert.equal(await claimEmailSyncWriterAs("development"), true, "owner renews its own lease");

  assert.equal(await claimEmailSyncWriterAs("production"), true, "production always takes over");
  assert.equal(await leaseOwner(), "production");

  // The critical race the old read-then-upsert version lost: production has
  // a FRESH lease, so a development claim must fail atomically — the WHERE
  // clause decides under the row lock, dev never overwrites.
  assert.equal(await claimEmailSyncWriterAs("development"), false, "dev must not steal a fresh prod lease");
  assert.equal(await leaseOwner(), "production", "prod lease survives the dev attempt");
});

test("an expired lease is claimable by anyone", async () => {
  await db.execute(sql`
    update app_settings
    set value = jsonb_build_object(
      'environment', 'production',
      'at', to_char(now() - interval '31 minutes', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
    where key = 'email_sync_writer'
  `);
  assert.equal(await claimEmailSyncWriterAs("development"), true, "expired prod lease is claimable");
  assert.equal(await leaseOwner(), "development");
});

test("concurrent claims elect exactly one writer", async () => {
  await releaseEmailSyncWriter();
  const results = await Promise.all([
    claimEmailSyncWriterAs("development"),
    claimEmailSyncWriterAs("development"),
    claimEmailSyncWriterAs("production"),
  ]);
  // production always wins its own claim; dev claims may win only while the
  // row is unclaimed/dev-owned. Whatever the interleaving, the final owner
  // must be production and at least one claim succeeded.
  assert.ok(results.some(Boolean));
  assert.equal(await leaseOwner(), "production");
});

test.after(async () => {
  // Leave the dev environment able to reclaim on its next scheduler tick.
  await releaseEmailSyncWriter();
});
