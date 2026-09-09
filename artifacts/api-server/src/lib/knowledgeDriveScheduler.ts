import type { Logger } from "pino";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db, knowledgeSourcesTable } from "@workspace/db";
import { runDriveSourceSync } from "../routes/knowledgeSources";

let started = false;
let running = false;
const INTERVAL_MS = 15 * 60 * 1000;

export function startKnowledgeDriveScheduler(log: Logger): void {
  if (started || process.env.KB_DRIVE_SYNC_ENABLED !== "true") return;
  started = true;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const lock = await db.execute<{ locked: boolean }>(sql`select pg_try_advisory_lock(83429177) as locked`);
      if (!lock.rows[0]?.locked) return;
      try {
        const sources = await db.select().from(knowledgeSourcesTable)
          .where(and(eq(knowledgeSourcesTable.kind, "google_drive"), eq(knowledgeSourcesTable.status, "active")));
        for (const source of sources) {
          try {
            await runDriveSourceSync(source.id, "scheduler");
          } catch (error) {
            log.warn({ sourceId: source.id, error }, "knowledge Drive sync failed");
          }
        }
      } finally {
        await db.execute(sql`select pg_advisory_unlock(83429177)`);
      }
    } catch (error) { log.warn({ error }, "knowledge Drive scheduler tick failed"); }
    finally { running = false; }
  };
  void tick();
  const timer = setInterval(() => void tick(), INTERVAL_MS);
  timer.unref();
}