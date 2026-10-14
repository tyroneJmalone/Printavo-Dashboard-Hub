import { randomUUID } from "node:crypto";
import { db, pool, pqPrintJobsTable as jobs, pqPrintRunsTable as runs, type PqPrintJob } from "@workspace/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { PvOrderDetailNode } from "@workspace/printavo";
import type { Logger } from "pino";
import type { AutoPrintFollowupInvoice, AutoPrintFollowupPreview } from "@workspace/api-zod";
import { getAutoPrintConfig } from "./config";
import { getPrintavoClient } from "../../printavoGateway";
import { workorderDetailQuery } from "./workorderDetailQuery";
import { fetchLiveOrderStatus } from "./liveDiscovery";
import { classifyAutoPrint, planMerchCategories } from "./decorationEvidence";
import { conditionalAutoPrintDestination } from "./routing";
import { destinationMappingForClassification } from "../../purchasing/decorationClassifier";
import { businessDaysUntilDue } from "../../purchasing/businessDays";
import { liveCategories, previewReview, commitReview } from "../../chipply/categoryReview";
import { startPqStatusJob, getPqStatusJob } from "../statusJobs";
import { followupEligibility, followupHash } from "./followupPolicy";

const PREFIX = "autoprint.followup.preview:";
const lockKey = (id: string) => `autoprint.followup.invoice:${id}`;
type Detail = PvOrderDetailNode & { nickname?: string | null; customerDueAt?: string | null };
type Entry = AutoPrintFollowupInvoice & {
  orderId: string; fingerprint?: string; expectedStatusId?: string;
  targetStatusId?: string; reviews?: string[];
};
type Preview = Omit<AutoPrintFollowupPreview, "invoices"> & {
  runId: string; configHash: string; invoices: Entry[];
};
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const dto = (p: Preview): AutoPrintFollowupPreview => ({
  previewId: p.previewId, state: p.state, expiresAt: p.expiresAt, actor: p.actor,
  invoices: p.invoices.map(({ orderId, fingerprint, expectedStatusId, targetStatusId, reviews, ...row }) => row),
});
async function save(p: Preview) {
  await pool.query("UPDATE app_settings SET value=$2::jsonb,updated_at=now() WHERE key=$1", [PREFIX + p.previewId, JSON.stringify(p)]);
}
async function candidates(runId: string) {
  return db.select({ job: jobs, dryRun: runs.dryRun }).from(jobs)
    .innerJoin(runs, eq(runs.id, jobs.runId))
    .where(and(eq(jobs.runId, runId), eq(jobs.docType, "workorder"), eq(jobs.status, "printed")));
}
function base(job: PqPrintJob): Entry {
  return { jobId: job.id, orderId: job.printavoOrderId, visualId: job.visualId ?? "",
    nickname: job.nickname ?? "", currentStatus: job.sourceStatusName ?? "Unknown",
    targetStatus: "", categories: [], eligible: true, message: "Preview will read the live invoice and current saved rules.", state: "candidate" };
}
async function livePlan(job: PqPrintJob, dryRun: boolean, config: Awaited<ReturnType<typeof getAutoPrintConfig>>) {
  const [latest] = await db.select().from(jobs).where(and(eq(jobs.printavoOrderId, job.printavoOrderId),
    eq(jobs.docType, "workorder"), eq(jobs.status, "printed"))).orderBy(desc(jobs.createdAt)).limit(1);
  if (latest?.id !== job.id) throw new Error("A newer accepted workorder exists. Use its run instead.");
  const active = await db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.printavoOrderId, job.printavoOrderId),
    inArray(jobs.status, ["pending", "retry_pending", "submission_unknown"]))).limit(1);
  if (active.length) throw new Error("Another print/retry or unknown submission is active. Review that first.");
  const live = await fetchLiveOrderStatus("invoice", job.printavoOrderId);
  const response = await getPrintavoClient().query<{ invoice?: Detail | null }>(workorderDetailQuery("invoice", job.printavoOrderId));
  const node = response.invoice;
  if (!live || !node || live.orderId !== job.printavoOrderId || node.id !== job.printavoOrderId ||
      String(live.visualId) !== job.visualId || String(node.visualId) !== job.visualId) throw new Error("Live invoice identity could not be verified.");
  const classification = classifyAutoPrint(node);
  const target = config.routingMode === "conditional" ? conditionalAutoPrintDestination(config.routingRules, {
    classification, nickname: node.nickname ?? null, sourceStatusId: job.sourceStatusId,
    businessDaysOut: node.customerDueAt ? businessDaysUntilDue(new Date(), new Date(node.customerDueAt)) : null,
  }) : destinationMappingForClassification(classification, config.categoryMappings);
  const rule = config.routingMode === "conditional" ? target as import("./configValidation").AutoPrintRoutingRule | null : null;
  const reason = followupEligibility({
    accepted: job.status === "printed" && !!job.printnodeJobId, dryRun,
    merch: /\bMERCH\b/i.test(job.sourceStatusName ?? "") && /\bMERCH\b/i.test(live.statusName ?? ""),
    recognized: /^\d{5,7}\s/.test(node.nickname ?? ""),
    currentStatusId: live.statusId, sourceStatusId: job.sourceStatusId, targetStatusId: target?.statusId ?? null,
    complete: !node.lineItemGroups.pageInfo.hasNextPage && node.lineItemGroups.nodes.every(g =>
      !g.lineItems.pageInfo.hasNextPage && !g.imprints.pageInfo.hasNextPage),
  });
  if (reason) throw new Error(reason);
  const assignments = planMerchCategories(node, rule, node.nickname ?? null, job.sourceStatusName);
  const fingerprint = followupHash({ node, live, assignments, target });
  return { node, live, target: target!, assignments, fingerprint };
}

export async function previewFollowup(runId: string, jobIds: string[], actor: string): Promise<AutoPrintFollowupPreview> {
  const config = await getAutoPrintConfig();
  const available = await candidates(runId);
  const p: Preview = { previewId: randomUUID(), state: "preview", actor, runId, configHash: followupHash(config),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), invoices: [] };
  for (const id of jobIds) {
    const selected = available.find(c => c.job.id === id);
    if (!selected) throw new Error("A selected workorder is not an accepted print in this run.");
    const { job, dryRun } = selected;
    const entry = base(job);
    try {
      const locked = await pool.query("SELECT 1 FROM app_settings WHERE key=$1", [lockKey(job.printavoOrderId)]);
      if (locked.rowCount) throw new Error("A previous correction is active or needs manual verification. Do not resend.");
      const plan = await livePlan(job, dryRun, config);
      entry.nickname = plan.node.nickname ?? entry.nickname;
      entry.currentStatus = plan.live.statusName ?? "";
      entry.expectedStatusId = plan.live.statusId!;
      entry.targetStatusId = plan.target.statusId;
      entry.targetStatus = plan.target.statusName;
      entry.fingerprint = plan.fingerprint;
      entry.reviews = [];
      const categories = plan.assignments.length ? await liveCategories() : [];
      for (const name of new Set(plan.assignments.map(a => a.categoryName))) {
        const matches = categories.filter(c => c.name.trim().toLowerCase() === name.toLowerCase());
        if (matches.length !== 1) throw new Error(`Missing or ambiguous live category: ${name}`);
        const selectedLines = plan.assignments.filter(a => a.categoryName === name);
        for (let i = 0; i < selectedLines.length; i += 100) {
          const review = await previewReview(actor, selectedLines.slice(i, i + 100).map(a => ({
            orderId: job.printavoOrderId, lineItemId: a.lineItemId,
          })), false, matches[0].id);
          if (review.lines.some(l => !l.eligible || l.statusId !== entry.expectedStatusId)) throw new Error("Category or status changed while previewing. Preview again.");
          entry.reviews.push(review.previewId);
        }
      }
      entry.categories = plan.assignments.map(a => {
        const line = plan.node.lineItemGroups.nodes.flatMap(g => g.lineItems.nodes).find(l => l.id === a.lineItemId);
        return `Line ${a.lineItemId} · ${line?.itemNumber ?? ""} ${line?.color ?? ""} · ${line?.items ?? 0} units → ${a.categoryName}`;
      });
      entry.state = entry.categories.length || entry.expectedStatusId !== entry.targetStatusId ? "ready" : "noop";
      entry.eligible = entry.state === "ready";
      entry.message = entry.eligible ? "Only the listed changes will be applied. Existing nonblank categories are preserved." : "Already matches the rules; no changes needed.";
    } catch (e) { entry.eligible = false; entry.state = "blocked"; entry.message = message(e); }
    p.invoices.push(entry);
  }
  await pool.query("INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb)", [PREFIX + p.previewId, JSON.stringify(p)]);
  return dto(p);
}

/** Claim before side effects. Restart/timeout ambiguity is durable and cannot replay. */
export async function confirmFollowup(id: string, actor: string, log: Logger) {
  const config = await getAutoPrintConfig();
  const claim = await pool.query(`UPDATE app_settings SET value=jsonb_set(value,'{state}','"applying"'::jsonb),updated_at=now()
    WHERE key=$1 AND value->>'actor'=$2 AND value->>'state'='preview'
      AND (value->>'expiresAt')::timestamptz > now() AND value->>'configHash'=$3 RETURNING value`,
    [PREFIX + id, actor, followupHash(config)]);
  if (!claim.rowCount) throw new Error("Preview expired, rules changed, or confirmation already claimed. Refresh history; do not resend.");
  const p = claim.rows[0].value as Preview;
  const available = await candidates(p.runId);
  const statusEntries: Entry[] = [];
  for (const entry of p.invoices) {
    if (!entry.eligible) continue;
    let locked = false, attempted = false;
    try {
      const selected = available.find(c => c.job.id === entry.jobId);
      if (!selected) throw new Error("Accepted print is no longer available.");
      locked = !!(await pool.query("INSERT INTO app_settings(key,value) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING RETURNING key",
        [lockKey(entry.orderId), JSON.stringify({ previewId: id, actor })])).rowCount;
      if (!locked) throw new Error("Another correction is active or unresolved; manual review required.");
      const freshConfig = await getAutoPrintConfig();
      if (followupHash(freshConfig) !== p.configHash) throw new Error("Rules changed after preview.");
      const plan = await livePlan(selected.job, selected.dryRun, freshConfig);
      if (plan.fingerprint !== entry.fingerprint) throw new Error("Invoice details, status, or destination changed since preview. No changes made.");
      entry.state = "applying"; await save(p);
      for (const reviewId of entry.reviews ?? []) {
        attempted = true;
        const result = await commitReview(actor, reviewId, log);
        if (result.results.some(r => r.outcome !== "updated" && r.outcome !== "skipped")) throw new Error("Category changes were not fully confirmed. Review the invoice before any further action.");
      }
      if (entry.expectedStatusId !== entry.targetStatusId) {
        const live = await fetchLiveOrderStatus("invoice", entry.orderId);
        if (!live || live.statusId !== entry.expectedStatusId || String(live.visualId) !== entry.visualId) throw new Error("Status changed during category updates; destination was not applied.");
        entry.state = "applying";
        entry.message = "Category steps completed; preparing the guarded status batch.";
        statusEntries.push(entry);
      } else {
        entry.state = "updated"; entry.message = "Category changes confirmed; invoice was already at the destination status.";
      }
      await save(p);
      if (entry.state === "updated") await pool.query("DELETE FROM app_settings WHERE key=$1 AND value->>'previewId'=$2", [lockKey(entry.orderId), id]);
    } catch (e) {
      const waiting = statusEntries.indexOf(entry);
      if (waiting >= 0) statusEntries.splice(waiting, 1);
      entry.state = attempted ? "review_required" : "blocked"; entry.message = message(e);
      await save(p);
      if (locked && !attempted) await pool.query("DELETE FROM app_settings WHERE key=$1 AND value->>'previewId'=$2", [lockKey(entry.orderId), id]);
    }
  }
  if (statusEntries.length) {
    try {
      if (followupHash(await getAutoPrintConfig()) !== p.configHash) throw new Error("Rules changed during category processing; status batch withheld.");
      const result = await startPqStatusJob("autoprint", statusEntries.map(entry => ({
        orderId: entry.orderId, expectedStatusId: entry.expectedStatusId!, targetStatusId: entry.targetStatusId!,
      })), log);
      if (result.status !== "started") throw new Error("Status worker could not accept the batch. Review completed categories before any further action.");
      for (const entry of statusEntries) {
        entry.statusJobId = result.job.id; entry.state = "status_queued";
        entry.message = "Category steps completed; status update queued with a live-status guard. Watch this result before any further action.";
      }
    } catch (e) {
      for (const entry of statusEntries) { entry.state = "review_required"; entry.message = message(e); }
    }
  }
  p.state = "complete"; await save(p);
  return dto(p);
}

export async function listFollowup(runId: string) {
  const available = await candidates(runId);
  const saved = await pool.query("SELECT value FROM app_settings WHERE key LIKE $1 AND value->>'runId'=$2 ORDER BY updated_at DESC LIMIT 20", [PREFIX + "%", runId]);
  const history: AutoPrintFollowupPreview[] = [];
  for (const row of saved.rows) {
    const p = row.value as Preview;
    for (const entry of p.invoices.filter(e => e.state === "status_queued" && e.statusJobId)) {
      const statusJob = await getPqStatusJob(entry.statusJobId!);
      if (!statusJob || statusJob.status === "running") continue;
      const line = statusJob.lines.find(l => l.orderId === entry.orderId);
      const live = await fetchLiveOrderStatus("invoice", entry.orderId).catch(() => null);
      if (!live && statusJob.status === "success") continue; // Read outage is not proof of a failed write.
      const confirmed = line && ["done", "skipped"].includes(line.status) && live?.statusId === entry.targetStatusId;
      entry.state = confirmed ? "updated" : "review_required";
      entry.message = confirmed ? "Status and category steps completed. No documents printed." : "Status update needs manual review; do not repeat blindly.";
      // This save is restricted to completed previews; never overwrite an applying worker.
      if (p.state === "complete") {
        await save(p);
        if (confirmed) await pool.query("DELETE FROM app_settings WHERE key=$1 AND value->>'previewId'=$2", [lockKey(entry.orderId), p.previewId]);
      }
    }
    history.push(dto(p));
  }
  return { invoices: available.filter(c => !c.dryRun && c.job.printnodeJobId && /\bMERCH\b/i.test(c.job.sourceStatusName ?? ""))
    .map(c => { const { orderId, ...entry } = base(c.job); return entry; }), history };
}
