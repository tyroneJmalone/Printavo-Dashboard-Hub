import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { accountReferencePageQuery } from "@workspace/printavo";
import { getPrintavoClient } from "../printavoGateway";
import type { Logger } from "pino";
import { newDetailAgg, refreshOrderDetail } from "../sync/detail";
import { postCheckCategory } from "./categoryPostCheck";

export const SELECTION_CAP = 100;
export type Category = { id: string; name: string };
export type Selection = { orderId: string; lineItemId: string };
export function validateSelections(selections: Selection[]) {
  if (!selections.length || selections.length > SELECTION_CAP ||
      selections.some(s => !s.orderId.trim() || !s.lineItemId.trim()) ||
      new Set(selections.map(s => s.lineItemId.trim())).size !== selections.length) {
    throw new Error(`Choose 1–${SELECTION_CAP} unique line items`);
  }
}
export const normalizeStatus = (s: string) => s.replace(/\s+/g, " ").trim().toUpperCase();
export function recommendation(status: string, categories: Category[]) {
  // Live read-only account verification found "MERCH - PRINT/EMB/HEAT"
  // at each production stage. Accept that observed separator as well as the
  // requested literal "MERCH PRINT/EMB/HEAT"; don't strip other punctuation.
  const normalized = normalizeStatus(status).replace(/\bMERCH\s*-\s*/g, "MERCH ");
  const names = [["MERCH PRINT", "Screen Printing"], ["MERCH EMB", "Embroidery"], ["MERCH HEAT", "HEAT APPLIED GRAPHICS"], ["MERCH MIXED", "Mixed Decoration"]]
    .filter(([token]) => normalized.includes(token!)).map(([, name]) => name!);
  if (names.length !== 1) return { category: null, message: names.length ? "Ambiguous decoration methods in status." : "No category recommendation for this status." };
  const matches = categories.filter(c => normalizeStatus(c.name) === normalizeStatus(names[0]!));
  return matches.length === 1 ? { category: matches[0]!, message: "Category resolved from current status." } :
    { category: null, message: matches.length ? "Multiple official categories match this recommendation." : `Official category ${names[0]} is missing.` };
}
export function categoryMutation(lineItemId: string, position: number, categoryId: string) {
  if (!Number.isInteger(position)) throw new Error("Required live position is missing");
  return `mutation { lineItemUpdate(id:${JSON.stringify(lineItemId)}, input:{position:${position}, category:{id:${JSON.stringify(categoryId)}}}) { id category { id name } } }`;
}
export async function liveCategories(): Promise<Category[]> {
  const categories: Category[] = [];
  let after: string | null = null;
  do {
    const data: { account: { categories: { nodes: Category[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } } =
      await getPrintavoClient().query(accountReferencePageQuery("category", after));
    const page = data.account.categories;
    categories.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    if (!page.pageInfo.endCursor || page.pageInfo.endCursor === after) throw new Error("Category pagination incomplete");
    after = page.pageInfo.endCursor;
  } while (true);
  return categories;
}
type Live = { id: string; position: number; category: Category | null; lineItemGroup: { order: { __typename: string; id: string; nickname: string | null; status: { id: string; name: string } } } };
async function liveLine(id: string): Promise<Live> {
  const data = await getPrintavoClient().query<{ lineItem: Live | null }>(`query { lineItem(id:${JSON.stringify(id)}) { id position category {id name} lineItemGroup { order { __typename ... on Invoice { id nickname status {id name} } } } } }`);
  if (!data.lineItem || !Object.hasOwn(data.lineItem, "category")) throw new Error("Current line item could not be read safely");
  if (data.lineItem.category !== null &&
      (typeof data.lineItem.category?.id !== "string" || !data.lineItem.category.id.trim())) {
    throw new Error("Current category is incomplete; it must not be treated as unassigned");
  }
  return data.lineItem;
}
export function validSelection(live: Live, selection: Selection) {
  const order = live.lineItemGroup.order;
  return live.id === selection.lineItemId && order.__typename === "Invoice" && order.id === selection.orderId && /^\d{5,7}\s/.test(order.nickname ?? "");
}
export type ReviewLine = Selection & { currentCategoryId: string | null; currentCategoryName: string | null; recommendedCategoryId: string | null; recommendedCategoryName: string | null; statusName: string; statusId: string; eligible: boolean; message: string };
type Snapshot = { lines: ReviewLine[]; overwrite: boolean; targetCategoryId?: string };
export async function previewReview(actor: string, selections: Selection[], overwrite: boolean, targetCategoryId?: string) {
  validateSelections(selections);
  const categories = await liveCategories();
  if (targetCategoryId && !categories.some(c => c.id === targetCategoryId)) throw new Error("Target category is not an official live category");
  const lines: ReviewLine[] = [];
  for (const selection of selections) {
    const mirror = await pool.query("SELECT 1 FROM pv_line_items li JOIN pv_orders o ON o.printavo_id=li.order_id WHERE li.printavo_id=$1 AND o.printavo_id=$2 AND o.order_type='invoice'", [selection.lineItemId, selection.orderId]);
    if (!mirror.rowCount) throw new Error("Selected line item is not a member of the selected mirrored invoice");
    const live = await liveLine(selection.lineItemId);
    if (!validSelection(live, selection)) throw new Error("Selection is not a live recognized Chipply invoice line item");
    const status = live.lineItemGroup.order.status;
    const rec = recommendation(status.name, categories);
    const target = targetCategoryId ? categories.find(c => c.id === targetCategoryId)! : rec.category;
    const eligible = !!target && (overwrite || live.category === null) && live.category?.id !== target.id;
    lines.push({ ...selection, currentCategoryId: live.category?.id ?? null, currentCategoryName: live.category?.name ?? null,
      recommendedCategoryId: target?.id ?? null, recommendedCategoryName: target?.name ?? null, statusName: status.name, statusId: status.id, eligible,
      message: !target ? rec.message : live.category?.id === target.id ? "Already assigned." : live.category && !overwrite ? "Existing category preserved (missing-only)." : "Ready to assign." });
  }
  const previewId = randomUUID();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  await pool.query("INSERT INTO chipply_category_reviews(id,actor,snapshot,expires_at) VALUES($1,$2,$3,$4)", [previewId, actor, JSON.stringify({ lines, overwrite, targetCategoryId }), expiresAt]);
  return { previewId, lines, expiresAt, selectionCap: SELECTION_CAP };
}
export type LineResult = Selection & { outcome: string; message: string };
export function staleLine(live: Live, line: ReviewLine, snapshot: Snapshot, categories: Category[]) {
  if (!validSelection(live, line)) return "Invoice recognition or line membership changed.";
  const status = live.lineItemGroup.order.status;
  if (status.id !== line.statusId || status.name !== line.statusName) return "Invoice status changed; preview again.";
  if ((live.category?.id ?? null) !== line.currentCategoryId) return "Current category changed; it was not overwritten.";
  const target = snapshot.targetCategoryId ? categories.find(c => c.id === snapshot.targetCategoryId) : recommendation(status.name, categories).category;
  if (!target || target.id !== line.recommendedCategoryId || target.name !== line.recommendedCategoryName) return "Official category or recommendation changed.";
  if (!snapshot.overwrite && live.category) return "Existing category preserved.";
  return null;
}
export async function commitReview(actor: string, previewId: string, logger?: Logger, options?: { postCheckMissing?: boolean }) {
  const claimed = await pool.query("UPDATE chipply_category_reviews SET state='committing' WHERE id=$1 AND actor=$2 AND state='preview' AND expires_at>now() RETURNING snapshot", [previewId, actor]);
  if (!claimed.rowCount) throw new Error("Preview expired, already committed, or belongs to another user");
  const snapshot = claimed.rows[0].snapshot as Snapshot;
  const results: LineResult[] = [];
  for (const line of snapshot.lines) {
    let result: LineResult = { orderId: line.orderId, lineItemId: line.lineItemId, outcome: "skipped", message: line.message };
    if (line.eligible) {
      const connection = await pool.connect();
      let locked = false;
      let attempted = false;
      let original: Live | undefined;
      try {
        locked = (await connection.query("SELECT pg_try_advisory_lock(hashtextextended($1,719204)) AS acquired", [line.lineItemId])).rows[0].acquired;
        if (!locked) throw new Error("Another update is in progress");
        const held = await connection.query("SELECT state FROM chipply_category_claims WHERE line_item_id=$1", [line.lineItemId]);
        if (held.rows.some(r => r.state === "unknown" || r.state === "in_flight")) throw new Error("Previous outcome is unresolved; manual verification in Printavo is required. Do not resend.");
        const categories = await liveCategories();
        const live = await liveLine(line.lineItemId);
        const stale = staleLine(live, line, snapshot, categories);
        if (stale) throw new Error(stale);
        original = live;
        const document = categoryMutation(line.lineItemId, live.position, line.recommendedCategoryId!);
        // Durable claim commits BEFORE the sole upstream attempt; crashes remain held.
        await connection.query("INSERT INTO chipply_category_claims(line_item_id,review_id,state) VALUES($1,$2,'in_flight') ON CONFLICT(line_item_id) DO UPDATE SET review_id=$2,state='in_flight',updated_at=now()", [line.lineItemId, previewId]);
        attempted = true;
        const data = await getPrintavoClient().mutate<{lineItemUpdate: {id: string; category: Category | null} | null}>(document);
        if (data.lineItemUpdate?.id !== line.lineItemId || data.lineItemUpdate.category?.id !== line.recommendedCategoryId) throw new Error("Printavo did not confirm the category");
        result = { ...result, outcome: "updated", message: "Category updated." };
        // Persist upstream confirmation before secondary audit/mirror work.
        // If this write itself fails, retain the conservative in-flight hold.
        await connection.query("UPDATE chipply_category_claims SET state='updated',updated_at=now() WHERE line_item_id=$1", [line.lineItemId]);
        await connection.query(`INSERT INTO change_events(entity_type,entity_id,order_id,visual_id,event_type,field,old_value,new_value)
          SELECT 'line_item',$1,$2,visual_id,'field_change','category',$3::jsonb,$4::jsonb FROM pv_orders WHERE printavo_id=$2`,
          [line.lineItemId, line.orderId, JSON.stringify(line.currentCategoryId), JSON.stringify(line.recommendedCategoryId)]);
        await connection.query("UPDATE pv_line_items SET category_id=$2,category_name=$3,synced_at=now() WHERE printavo_id=$1 AND order_id=$4", [line.lineItemId, line.recommendedCategoryId, line.recommendedCategoryName, line.orderId]);
      } catch (err) {
        if (result.outcome === "updated") {
          result.message = "Printavo confirmed the category; local audit/mirror refresh is pending.";
          if (logger) setImmediate(() => {
            void refreshOrderDetail(line.orderId, "invoices", newDetailAgg(), logger, { force: true })
              .catch(err => logger.warn({ err, orderId: line.orderId, previewId }, "Confirmed category needs local detail refresh"));
          });
        }
        if (result.outcome !== "updated") result = { ...result, outcome: attempted ? "unknown" : "conflict", message: attempted ? "Outcome unconfirmed; held for manual verification in Printavo. Do not resend." : (err as Error).message };
        if (attempted && result.outcome === "unknown") await connection.query("UPDATE chipply_category_claims SET state='unknown',updated_at=now() WHERE line_item_id=$1", [line.lineItemId]).catch(() => {});
        if (locked && attempted && result.outcome === "unknown" && original &&
            options?.postCheckMissing && !snapshot.overwrite && line.currentCategoryId === null) {
          // Only recover this invocation's own uncertain write, never a prior hold.
          const before = original;
          const recovered = await postCheckCategory({
            read: () => liveLine(line.lineItemId),
            categoryId: live => live.category?.id ?? null,
            targetId: line.recommendedCategoryId!,
            validate: live => {
              if (!validSelection(live, line)) return "Invoice recognition or line membership changed.";
              if (live.position !== before.position || live.lineItemGroup.order.nickname !== before.lineItemGroup.order.nickname)
                return "Line position or invoice nickname changed; retry withheld.";
              const status = live.lineItemGroup.order.status;
              return status.id !== line.statusId || status.name !== line.statusName ? "Invoice status changed; retry withheld." : null;
            },
            claimRetry: async () => {
              const categories = await liveCategories();
              if (!categories.some(c => c.id === line.recommendedCategoryId && c.name === line.recommendedCategoryName)) return false;
              return !!(await connection.query(`UPDATE chipply_category_claims SET state='in_flight',updated_at=now()
                WHERE line_item_id=$1 AND review_id=$2 AND state='unknown' RETURNING line_item_id`, [line.lineItemId, previewId])).rowCount;
            },
            retry: async live => {
              await getPrintavoClient().mutate(categoryMutation(line.lineItemId, live.position, line.recommendedCategoryId!));
            },
          });
          result = { ...result, ...recovered };
          if (recovered.outcome === "updated") {
            try {
              await connection.query("UPDATE chipply_category_claims SET state='updated',updated_at=now() WHERE line_item_id=$1 AND review_id=$2", [line.lineItemId, previewId]);
              await connection.query(`INSERT INTO change_events(entity_type,entity_id,order_id,visual_id,event_type,field,old_value,new_value)
                SELECT 'line_item',$1,$2,visual_id,'field_change','category',$3::jsonb,$4::jsonb FROM pv_orders WHERE printavo_id=$2`,
                [line.lineItemId, line.orderId, JSON.stringify(null), JSON.stringify(line.recommendedCategoryId)]);
              await connection.query("UPDATE pv_line_items SET category_id=$2,category_name=$3,synced_at=now() WHERE printavo_id=$1 AND order_id=$4",
                [line.lineItemId, line.recommendedCategoryId, line.recommendedCategoryName, line.orderId]);
            } catch {
              result = { ...result, outcome: "unknown", message: "Live category verified but recovery audit could not be saved; manual review required." };
            }
          }
          if (result.outcome !== "updated") await connection.query("UPDATE chipply_category_claims SET state='unknown',updated_at=now() WHERE line_item_id=$1 AND review_id=$2", [line.lineItemId, previewId]).catch(() => {});
        }
      } finally {
        let destroy = false;
        try {
          if (locked) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,719204))", [line.lineItemId]);
        } catch { destroy = true; }
        connection.release(destroy);
      }
    }
    results.push(result);
    await pool.query("UPDATE chipply_category_reviews SET results=$2 WHERE id=$1", [previewId, JSON.stringify(results)]);
  }
  await pool.query("UPDATE chipply_category_reviews SET state='complete' WHERE id=$1", [previewId]);
  return { results, updated: results.filter(r => r.outcome === "updated").length, failed: results.filter(r => ["unknown", "conflict", "failed"].includes(r.outcome)).length };
}