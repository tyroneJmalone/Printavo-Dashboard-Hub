import { pool } from "@workspace/db";
import type { PvOrderDetailNode } from "@workspace/printavo";
import type { ReviewLine, LineResult } from "../../chipply/categoryReview";
import { followupHash } from "./followupPolicy";

export type RecoveryCategory = {
  lineId: string; targetId: string; targetName: string; currentId: string | null;
  claimReview: string | null; claimState: string | null;
};
export type Recovery = { parentId: string; parentHash: string; reviewIds: string[]; categories: RecoveryCategory[] };
type PriorEntry = {
  jobId: string; orderId: string; state: string; targetStatusId?: string; statusJobId?: string;
  reviews?: string[]; recovery?: Recovery; message: string;
  statusDispatchState?: string;
};
const prefix = "autoprint.followup.preview:";
const lockKey = (id: string) => `autoprint.followup.invoice:${id}`;

export async function readRecoveryParent(parentId: string, jobId: string) {
  const rows = await pool.query("SELECT value FROM app_settings WHERE key=$1", [prefix + parentId]);
  const parent = rows.rows[0]?.value;
  const entry: PriorEntry | undefined = parent?.invoices?.find((e: PriorEntry) => e.jobId === jobId);
  if (!entry || parent.state !== "complete" || entry.state !== "review_required") {
    throw new Error("Only finished corrections needing review can be resolved. Active/interrupted attempts must first be verified.");
  }
  const held = await pool.query("SELECT value FROM app_settings WHERE key=$1", [lockKey(entry.orderId)]);
  if (held.rows[0]?.value?.previewId !== parentId) throw new Error("This hold was already resolved or belongs to another correction. Refresh history.");
  return { parent, entry };
}

export async function inspectRecovery(parentId: string, jobId: string, node: PvOrderDetailNode,
  currentStatusId: string, targetStatusId: string, assignments: { lineItemId: string; categoryName: string }[]): Promise<Recovery> {
  const { entry } = await readRecoveryParent(parentId, jobId);
  if (entry.targetStatusId !== targetStatusId) throw new Error("The destination rule changed. Resolve the old correction manually rather than changing its intended destination.");
  const reviewIds = [...new Set([...(entry.recovery?.reviewIds ?? []), ...(entry.reviews ?? [])])];
  const reviews = reviewIds.length ? (await pool.query(
    "SELECT id,state,snapshot,results FROM chipply_category_reviews WHERE id=ANY($1::text[])", [reviewIds])).rows : [];
  if (reviews.length !== reviewIds.length || reviews.some(r => !["complete", "preview"].includes(r.state))) {
    throw new Error("A category review is missing or interrupted. Its worker outcome must be verified before retry.");
  }
  if (entry.statusJobId) {
    const status = (await pool.query("SELECT state FROM pq_status_jobs WHERE id=$1", [entry.statusJobId])).rows[0]?.state;
    if (!status || status.status === "running") throw new Error("Previous status update is active or unconfirmed; no replay allowed.");
    if (currentStatusId !== targetStatusId) throw new Error("A previous status submission exists but is not confirmed at the destination. Manual status verification is required.");
  } else if (currentStatusId !== targetStatusId) {
    const categoryStoppedStatus = !entry.statusDispatchState && reviews.filter(r => (entry.reviews ?? []).includes(r.id)).some(r => (r.results as LineResult[] | null)?.some(l =>
      l.orderId === entry.orderId && !["updated", "skipped"].includes(l.outcome)));
    const definitelyNotQueued = ["not_started", "not_submitted"].includes(entry.statusDispatchState ?? "") ||
      (!entry.statusDispatchState && (entry.message === "Status worker could not accept the batch. Review completed categories before any further action." ||
      entry.message === "Rules changed during category processing; status batch withheld."));
    if (!categoryStoppedStatus && !definitelyNotQueued) throw new Error("Cannot prove the previous status change was not submitted. Manual verification is required.");
  }
  const requirements = new Map<string, ReviewLine>();
  for (const review of reviews) for (const line of review.snapshot.lines as ReviewLine[]) {
    if (line.orderId !== entry.orderId || !line.eligible) continue;
    if (!line.recommendedCategoryId || !line.recommendedCategoryName) throw new Error("Original category evidence is incomplete.");
    const earlier = requirements.get(line.lineItemId);
    if (earlier && earlier.recommendedCategoryId !== line.recommendedCategoryId) throw new Error("Conflicting historical category targets; manual review required.");
    requirements.set(line.lineItemId, line);
  }
  const lines = node.lineItemGroups.nodes.flatMap(g => g.lineItems.nodes);
  const claims = requirements.size ? (await pool.query(
    "SELECT line_item_id,review_id,state FROM chipply_category_claims WHERE line_item_id=ANY($1::text[])", [[...requirements.keys()]])).rows : [];
  const categories: RecoveryCategory[] = [];
  for (const [lineId, expected] of requirements) {
    const live = lines.find(l => l.id === lineId);
    if (!live || !Object.hasOwn(live, "category") || live.category === undefined ||
      (live.category !== null && !live.category.id)) throw new Error(`Line ${lineId}: missing or incomplete category evidence.`);
    const currentId = live.category?.id ?? null;
    if (currentId !== null && currentId !== expected.recommendedCategoryId) throw new Error(`Line ${lineId}: a different category is assigned; it will not be overwritten.`);
    const claim = claims.find(c => c.line_item_id === lineId);
    if (claim && !reviewIds.includes(claim.review_id)) throw new Error(`Line ${lineId}: a different review owns its category claim.`);
    if (currentId === null && reviews.some(r => (r.results as LineResult[] | null)?.some(l => l.lineItemId === lineId && l.outcome === "updated"))) {
      throw new Error(`Line ${lineId}: a previously confirmed category was removed. Review that change manually.`);
    }
    categories.push({ lineId, targetId: expected.recommendedCategoryId!, targetName: expected.recommendedCategoryName!,
      currentId, claimReview: claim?.review_id ?? null, claimState: claim?.state ?? null });
  }
  const missing = categories.filter(c => c.currentId === null);
  if (missing.length !== assignments.length || assignments.some(a =>
    !missing.some(c => c.lineId === a.lineItemId && c.targetName === a.categoryName))) {
    throw new Error("Current category rules or invoice lines differ from the original correction. Only its remaining assignments may be recovered.");
  }
  return { parentId, parentHash: followupHash(entry), reviewIds, categories };
}

/** Transfer holds atomically; no upstream writes here. Same lock family as the category writer. */
export async function claimRecovery(recovery: Recovery, jobId: string, orderId: string, nextId: string, actor: string) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const source = (await client.query("SELECT value FROM app_settings WHERE key=$1 FOR UPDATE", [prefix + recovery.parentId])).rows[0]?.value;
    const index = source?.invoices?.findIndex((e: PriorEntry) => e.jobId === jobId) ?? -1;
    if (index < 0 || source.state !== "complete" || followupHash(source.invoices[index]) !== recovery.parentHash) throw new Error("Recovery history changed. Refresh and review again.");
    const moved = await client.query(`UPDATE app_settings SET value=$3::jsonb,updated_at=now()
      WHERE key=$1 AND value->>'previewId'=$2 RETURNING key`,
      [lockKey(orderId), recovery.parentId, JSON.stringify({ previewId: nextId, actor, recoveredFrom: recovery.parentId })]);
    if (!moved.rowCount) throw new Error("Another administrator already claimed this recovery.");
    for (const c of [...recovery.categories].sort((a,b)=>a.lineId.localeCompare(b.lineId))) {
      if (!(await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended($1,719204)) AS acquired", [c.lineId])).rows[0]?.acquired) throw new Error("A category update is active. Review again later.");
      const claim = (await client.query("SELECT review_id,state FROM chipply_category_claims WHERE line_item_id=$1 FOR UPDATE", [c.lineId])).rows[0];
      if ((claim?.review_id ?? null) !== c.claimReview || (claim?.state ?? null) !== c.claimState) throw new Error("Category claim changed since preview.");
      if (claim) await client.query("UPDATE chipply_category_claims SET state=$2,updated_at=now() WHERE line_item_id=$1",
        [c.lineId, c.currentId === c.targetId ? "updated" : "reconciled"]);
    }
    const previous = source.invoices[index];
    previous.state = "recovery_started"; previous.eligible = false;
    previous.message = `Reviewed and transferred to correction ${nextId}. See that correction for the remaining result.`;
    await client.query("UPDATE app_settings SET value=$2::jsonb,updated_at=now() WHERE key=$1", [prefix + recovery.parentId, JSON.stringify(source)]);
    await client.query("COMMIT");
  } catch(e) { await client.query("ROLLBACK"); throw e; }
  finally { client.release(); }
}
