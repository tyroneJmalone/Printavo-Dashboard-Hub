import { Router } from "express";
import { pool } from "@workspace/db";
import { z } from "zod";
import { PreviewChipplyCategoriesBody, CommitChipplyCategoriesBody } from "@workspace/api-zod";
import { PREFIX_SQL_PATTERN } from "../lib/chipply/matching";
import { commitReview, liveCategories, previewReview, recommendation, SELECTION_CAP } from "../lib/chipply/categoryReview";

const router = Router();
const base = "/chipply/category-review";
const paging = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const filters = paging.extend({
  search: z.string().max(200).default(""),
  status: z.string().max(300).default(""),
  categoryId: z.string().max(200).default(""),
  missingOnly: z.enum(["true", "false"]).default("true"),
});
const invoiceSelect = `o.printavo_id AS "orderId", o.visual_id AS "visualId",
  o.nickname, o.status_name AS "statusName", o.status_id AS "statusId",
  o.production_due_at AS "productionDueAt",
  coalesce(nullif(trim(o.customer_company), ''), nullif(trim(o.contact_name), '')) AS "customerName",
  o.invoice_at::text AS "invoiceAt", o.detail_sync_state AS "detailSyncState",
  o.detail_synced_at AS "detailSyncedAt",
  (SELECT count(*)::int FROM pv_line_items li WHERE li.order_id=o.printavo_id) AS "lineItemCount",
  (SELECT count(*)::int FROM pv_line_items li WHERE li.order_id=o.printavo_id AND li.category_id IS NULL) AS "missingCategoryCount",
  (SELECT coalesce(sum(li.items),0)::int FROM pv_line_items li WHERE li.order_id=o.printavo_id) AS quantity`;
const coverage = "All recognized invoices currently in the local Printavo mirror, across all dates and statuses; not limited to imported Chipply stores. This is not a guarantee of complete Printavo history. Line counts reflect mirrored details; incomplete or unsynced details may undercount. Preview validates selections live. Avoid concurrent edits in Printavo: its API has no atomic compare-and-set.";

router.get(`${base}/invoices`, async (req, res) => {
  const parsed = filters.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid filters or pagination" }); return; }
  const f = parsed.data;
  try {
    const values = [PREFIX_SQL_PATTERN, f.search, f.status, f.categoryId, f.missingOnly === "true"];
    const where = `o.order_type='invoice' AND o.nickname ~ $1
      AND ($2='' OR o.nickname ILIKE '%' || $2 || '%' OR o.visual_id::text ILIKE '%' || $2 || '%')
      AND ($3='' OR o.status_name=$3)
      AND ($4='' OR EXISTS(SELECT 1 FROM pv_line_items li WHERE li.order_id=o.printavo_id AND li.category_id=$4))
      AND (NOT $5::boolean OR EXISTS(SELECT 1 FROM pv_line_items li WHERE li.order_id=o.printavo_id AND li.category_id IS NULL))`;
    const [rows, count, statuses, categories] = await Promise.all([
      pool.query(`SELECT ${invoiceSelect} FROM pv_orders o WHERE ${where} ORDER BY o.visual_id DESC,o.printavo_id LIMIT $6 OFFSET $7`, [...values, f.pageSize, (f.page - 1) * f.pageSize]),
      pool.query(`SELECT count(*)::int AS total FROM pv_orders o WHERE ${where}`, values),
      pool.query(`SELECT DISTINCT status_name FROM pv_orders WHERE order_type='invoice' AND nickname ~ $1 AND status_name IS NOT NULL ORDER BY status_name`, [PREFIX_SQL_PATTERN]),
      liveCategories(),
    ]);
    res.json({ invoices: rows.rows.map(row => ({ ...row, recommendation: recommendation(row.statusName ?? "", categories) })), total: count.rows[0].total,
      page: f.page, pageSize: f.pageSize, statuses: statuses.rows.map(r => r.status_name), categories, coverage, selectionCap: SELECTION_CAP });
  } catch (err) { req.log.error({ err }, "Chipply category listing failed"); res.status(502).json({ error: "Unable to load invoice review or live official categories" }); }
});
router.get(`${base}/invoices/:orderId`, async (req, res) => {
  const parsed = paging.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Invalid pagination" }); return; }
  try {
    const found = await pool.query(`SELECT ${invoiceSelect} FROM pv_orders o WHERE o.printavo_id=$1 AND o.order_type='invoice' AND o.nickname ~ $2`, [req.params.orderId, PREFIX_SQL_PATTERN]);
    if (!found.rowCount) { res.status(404).json({ error: "Recognized invoice not found" }); return; }
    const { page, pageSize } = parsed.data;
    const [items, categories] = await Promise.all([
      pool.query(`SELECT printavo_id AS "lineItemId",order_id AS "orderId",item_number AS "itemNumber",description,color,brand,items AS quantity,
        category_id AS "currentCategoryId",category_name AS "currentCategoryName"
        FROM pv_line_items WHERE order_id=$1 ORDER BY printavo_id LIMIT $2 OFFSET $3`, [req.params.orderId, pageSize, (page - 1) * pageSize]),
      liveCategories(),
    ]);
    const invoice = found.rows[0];
    const rec = recommendation(invoice.statusName ?? "", categories);
    const detailCoverage = `Invoice #${invoice.visualId}: ${invoice.detailSyncState === "complete" ? "last mirrored detail fetch was complete" : "mirrored details are incomplete or not yet synced"}. Showing mirrored line page ${page}; total ${invoice.lineItemCount} is a MIRRORED count, not a verified live total. Selecting this page selects only the displayed line IDs. ${coverage}`;
    res.json({ invoice: { ...invoice, recommendation: rec }, lineItems: items.rows, categories, recommendation: rec, total: invoice.lineItemCount, page, pageSize, coverage: detailCoverage, selectionCap: SELECTION_CAP });
  } catch (err) { req.log.error({ err }, "Chipply category detail failed"); res.status(502).json({ error: "Unable to load invoice details or live categories" }); }
});
export const previewRequest = PreviewChipplyCategoriesBody.extend({
  selections: z.array(z.object({ orderId: z.string().trim().min(1).max(200), lineItemId: z.string().trim().min(1).max(200) }).strict()).min(1).max(SELECTION_CAP),
  targetCategoryId: z.string().trim().min(1).max(200).optional(),
}).strict().refine(v => new Set(v.selections.map(s => s.lineItemId)).size === v.selections.length, "Duplicate line selections are not allowed");
router.post(`${base}/preview`, async (req, res) => {
  if (!req.staff) { res.status(401).json({ error: "Staff session required" }); return; }
  const parsed = previewRequest.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: `Choose 1–${SELECTION_CAP} unique line items and valid options` }); return; }
  try {
    const { selections, overwrite, targetCategoryId } = parsed.data;
    res.json(await previewReview(req.staff.email, selections, overwrite, targetCategoryId));
  } catch (err) { req.log.warn({ err }, "Chipply category preview rejected"); res.status(409).json({ error: (err as Error).message }); }
});
router.post(`${base}/commit`, async (req, res) => {
  if (!req.staff) { res.status(401).json({ error: "Staff session required" }); return; }
  const parsed = CommitChipplyCategoriesBody.strict().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "A valid previewId is required" }); return; }
  try { res.json(await commitReview(req.staff.email, parsed.data.previewId, req.log.child({ actor: req.staff.email }))); }
  catch (err) { req.log.error({ err }, "Chipply category commit failed"); res.status(409).json({ error: (err as Error).message }); }
});
export default router;