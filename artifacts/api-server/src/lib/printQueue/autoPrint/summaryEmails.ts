import { createHash } from "node:crypto";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { pool } from "@workspace/db";
import type { Logger } from "pino";
import { currentInvoiceStatuses } from "./currentStatus";
import { emailRetryWindowOpen } from "./emailPolicy";
import { SUMMARY_RECIPIENT, SUMMARY_SCHEDULE, summarySlotDue } from "./summaryEmailPolicy";

const PREFIX = "autoprint.summary-email:";
const ACTIVATION = "autoprint.summary-email-started";
const easternTime = (d: Date | string) => new Date(d).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" });

export async function buildAutoPrintSummary(start: Date, end: Date) {
  const candidates = await pool.query<{ invoice: string; inWindow: boolean }>(`
    WITH activity AS (
      SELECT j.visual_id AS invoice,
        (j.created_at >= $1 AND j.created_at < $2
          OR j.printed_at >= $1 AND j.printed_at < $2
          OR EXISTS (SELECT 1 FROM pq_print_attempts a WHERE a.job_id=j.id
             AND coalesce(a.finished_at,a.started_at) >= $1 AND coalesce(a.finished_at,a.started_at) < $2)
          OR j.snapshot_metadata->'printNodeMonitor'->>'observedAt' >= $3
             AND j.snapshot_metadata->'printNodeMonitor'->>'observedAt' < $4
        ) AS active
      FROM pq_print_jobs j JOIN pq_print_runs r ON r.id=j.run_id
      WHERE NOT r.dry_run AND j.visual_id IS NOT NULL
        AND (j.created_at >= $1::timestamptz - interval '14 days' OR j.printed_at >= $1)
    ) SELECT invoice, bool_or(active) AS "inWindow" FROM activity GROUP BY invoice`,
    [start, end, start.toISOString(), end.toISOString()]);
  const statuses = await currentInvoiceStatuses(candidates.rows.map(r => r.invoice));
  const rows = candidates.rows.filter(r => r.inWindow || ["FAILED", "NEEDS REVIEW", "PENDING"].includes(statuses.get(r.invoice)!.status));
  const runs = await pool.query<{ status: string; count: string }>(`
    SELECT status,count(*) FROM pq_print_runs WHERE NOT dry_run
      AND started_at >= $1 AND started_at < $2 GROUP BY status`, [start, end]);
  const discovery = await pool.query<{ started_at: Date; error: string }>(`
    SELECT started_at,summary->>'error' AS error FROM pq_print_runs
    WHERE NOT dry_run AND started_at >= $1 AND started_at < $2
      AND summary->>'discoveryState'='failed' ORDER BY started_at`, [start, end]);
  const counts = new Map<string, number>();
  rows.forEach(r => { const s = statuses.get(r.invoice)!.status; counts.set(s, (counts.get(s) ?? 0) + 1); });
  const lines = rows.sort((a, b) => Number(a.invoice) - Number(b.invoice)).map(r => {
    const current = statuses.get(r.invoice)!;
    return [
      `#${r.invoice}: ${current.status}${r.inWindow ? "" : " (unresolved carryover)"}`,
      `  Outcome date: ${current.occurredAt ? easternTime(current.occurredAt) : "not recorded"}`,
      ...current.details.map(d => `  ${d.label}: ${d.status} — ${d.message}`),
    ].join("\n");
  });
  return {
    subject: `[Hub AutoPrint] ${easternTime(end)} summary — ${counts.get("FAILED") ?? 0} failed, ${counts.get("NEEDS REVIEW") ?? 0} need review`,
    text: [
      "AutoPrint scheduled summary",
      `Activity window: ${easternTime(start)} to ${easternTime(end)} (end exclusive).`,
      "Current outcomes are evaluated when this summary is prepared; they may include retries completed just after the window.",
      "",
      `Runs: ${runs.rows.map(r => `${r.count} ${r.status}`).join(", ") || "none"}`,
      `Distinct invoices: ${rows.length}. ${[...counts].map(([s, n]) => `${s}: ${n}`).join(" · ") || "No invoice activity or unresolved carryover."}`,
      "Invoice totals are not document counts. PO copies and workorders are shown separately below.",
      "",
      ...discovery.rows.map(r => `Discovery failed at ${easternTime(r.started_at)}: ${r.error || "Invoice list unavailable"}. Candidate count is unknown; there are no individual jobs to retry from that discovery failure.`),
      "",
      ...lines,
      "",
      "SUCCESS means accepted submission or delivery to the computer’s print queue—not confirmed physical paper output.",
      "PENDING and NEEDS REVIEW are not successes. Unresolved carryover covers recent recorded activity, up to 14 days before this window.",
      "Open Hub → Settings → Rules/Automations → AutoPrint; search the invoice number for full history.",
      "This summary does not retry, reprint, or change Printavo. Immediate failure alerts remain separate.",
    ].join("\n"),
  };
}

export async function summaryEmailStatus() {
  const { rows } = await pool.query(`SELECT value->>'slot' AS slot,value->>'state' AS state,value->>'sentAt' AS "sentAt"
    FROM app_settings WHERE key LIKE $1 ORDER BY key DESC LIMIT 6`, [`${PREFIX}%`]);
  return { recipient: SUMMARY_RECIPIENT, schedule: SUMMARY_SCHEDULE, deliveries: rows };
}

/** Frozen payloads and a durable per-slot ledger prevent duplicate summaries.
 * Never enqueue historical slots on activation/restart. Retry a pending send
 * with its original body/idempotency key, only within the provider's safe window. */
export async function sendAutoPrintSummaries(log: Logger) {
  if (process.env.REPLIT_DEPLOYMENT !== "1" || process.env.NODE_ENV !== "production") return;
  const now = new Date();
  await pool.query("INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING",
    [ACTIVATION, JSON.stringify({ since: now.toISOString() })]);
  const activation = await pool.query("SELECT value FROM app_settings WHERE key=$1", [ACTIVATION]);
  const since = new Date(activation.rows[0].value.since);
  if (!Number.isFinite(since.getTime())) throw new Error("Invalid summary-email activation date");
  const slot = summarySlotDue(now, since);
  if (slot) {
    const key = PREFIX + slot.key;
    const existing = await pool.query("SELECT 1 FROM app_settings WHERE key=$1", [key]);
    if (!existing.rowCount) {
      const content = await buildAutoPrintSummary(slot.start, slot.end);
      const body = { from: `Mint Printworks Hub <${process.env.FROM_EMAIL ?? "noreply@mintprintworks.com"}>`, to: SUMMARY_RECIPIENT, ...content };
      await pool.query("INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING",
        [key, JSON.stringify({ slot: slot.end.toISOString(), state: "pending", firstAttempt: now.toISOString(), body })]);
    }
  }
  const pending = await pool.query(`SELECT key FROM app_settings WHERE key LIKE $1
    AND value->>'state'='pending' ORDER BY key LIMIT 4`, [`${PREFIX}%`]);
  for (const { key } of pending.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query("SELECT value FROM app_settings WHERE key=$1 FOR UPDATE SKIP LOCKED", [key]);
      const state = locked.rows[0]?.value;
      if (!state || state.state !== "pending" || Date.parse(state.nextAt ?? "") > Date.now()) {
        await client.query("ROLLBACK"); continue;
      }
      if (!emailRetryWindowOpen(state.firstAttempt)) {
        state.state = "review_required";
        log.error({ slot: state.slot }, "AutoPrint summary delivery unconfirmed; verify Resend before resending");
      } else {
        try {
          const response = await withTimeout(new ReplitConnectors().proxy("resend", "/emails", {
            method: "POST", headers: { "Content-Type": "application/json",
              "Idempotency-Key": `autoprint-summary-${createHash("sha256").update(key).digest("hex")}` },
            body: JSON.stringify(state.body),
          }));
          if (!response.ok) throw new Error(`Summary provider returned ${response.status}`);
          const result = await response.json() as { id?: string };
          if (!result.id) throw new Error("Summary provider did not confirm acceptance");
          state.state = "sent"; state.sentAt = new Date().toISOString(); state.providerId = result.id;
          log.info({ slot: state.slot }, "AutoPrint summary email accepted");
        } catch (err) {
          state.nextAt = new Date(Date.now() + 5 * 60_000).toISOString();
          log.error({ err, slot: state.slot }, "AutoPrint summary email unconfirmed; retrying same payload");
        }
      }
      await client.query("UPDATE app_settings SET value=$2::jsonb,updated_at=now() WHERE key=$1", [key, JSON.stringify(state)]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      log.error({ err }, "AutoPrint summary delivery ledger failed");
    } finally { client.release(); }
  }
}

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Summary send timed out; acceptance uncertain")), 20_000);
  })]); } finally { if (timer) clearTimeout(timer); }
}

let started = false;
export function startAutoPrintSummaries(log: Logger) {
  if (started || process.env.REPLIT_DEPLOYMENT !== "1" || process.env.NODE_ENV !== "production") return;
  started = true;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await sendAutoPrintSummaries(log); }
    catch (err) { log.error({ err }, "AutoPrint summary scan failed"); }
    finally { busy = false; }
  };
  void tick();
  setInterval(() => void tick(), 30_000).unref();
}
