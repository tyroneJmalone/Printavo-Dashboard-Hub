import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import {
  CreateBrandingColorBody,
  UpdateBrandingColorBody,
  UpdateCustomerBrandingBody,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireStaff";
import {
  DropboxError,
  getDropboxMetadata,
  getDropboxTemporaryLink,
  isDropboxMetadataWithinRoot,
  isDropboxPathWithinRoot,
  listDropboxFolder,
  normalizeDropboxPath,
  searchDropbox,
  type DropboxMetadata,
} from "../lib/dropbox";

const router: IRouter = Router();
const PAGE_TOKEN_TTL_MS = 5 * 60_000;
const MAX_ARTWORK_PREVIEW_BYTES = 25 * 1024 * 1024;
const ARTWORK_PREVIEW_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".webp": "image/webp",
};
type PageContext = {
  customerId: string;
  rootDropboxId: string | null;
  path: string;
  staffEmail: string | null;
};
const pageTokens = new Map<
  string,
  PageContext & { dropboxCursor: string; expiresAt: number }
>();

function issuePageToken(cursor: string | undefined, context: PageContext): string | null {
  if (!cursor) return null;
  const token = randomUUID();
  pageTokens.set(token, {
    ...context,
    dropboxCursor: cursor,
    expiresAt: Date.now() + PAGE_TOKEN_TTL_MS,
  });
  return token;
}

function resolvePageToken(token: string, context: PageContext): string | null {
  const saved = pageTokens.get(token);
  if (!saved || saved.expiresAt < Date.now()) {
    pageTokens.delete(token);
    return null;
  }
  if (
    saved.customerId !== context.customerId ||
    saved.rootDropboxId !== context.rootDropboxId ||
    saved.path !== context.path ||
    saved.staffEmail !== context.staffEmail
  ) return null;
  return saved.dropboxCursor;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function customerId(req: Request, res: Response): string | null {
  const id = String(req.params.id);
  if (!/^\d+$/.test(id)) {
    res.status(404).json({ error: "Customer not found" });
    return null;
  }
  return id;
}

async function customerExists(id: string): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM pv_customers WHERE printavo_id = $1", [id]);
  return result.rowCount === 1;
}

function metadataJson(row: DropboxMetadata) {
  return {
    type: row[".tag"],
    id: row.id,
    name: row.name,
    pathLower: row.path_lower ?? null,
    pathDisplay: row.path_display ?? null,
    size: row.size ?? null,
    modifiedAt: row.server_modified ?? null,
  };
}

function folderJson(row: {
  dropbox_id: string;
  path_lower: string;
  path_display: string;
  name: string;
  created_by_email: string;
  updated_by_email: string;
  created_at: Date;
  updated_at: Date;
}) {
  return {
    dropboxId: row.dropbox_id,
    pathLower: row.path_lower,
    pathDisplay: row.path_display,
    name: row.name,
    createdByEmail: row.created_by_email,
    updatedByEmail: row.updated_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ARTWORK_USE_CASES = [
  "light_background",
  "dark_background",
  "print",
  "embroidery",
  "web",
  "restricted",
] as const;
const USE_CASE_LABELS: Record<string, string> = {
  light_background: "Light backgrounds",
  dark_background: "Dark backgrounds",
  print: "Print",
  embroidery: "Embroidery",
  web: "Web / digital",
  restricted: "Restricted — ask first",
};

/** Returns a validated, de-duplicated use-case list, or null when invalid. */
function parseUseCases(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ARTWORK_USE_CASES.length) return null;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !(ARTWORK_USE_CASES as readonly string[]).includes(item)) {
      return null;
    }
    seen.add(item);
  }
  return ARTWORK_USE_CASES.filter((useCase) => seen.has(useCase));
}

function bookmarkJson(row: Record<string, unknown>) {
  return {
    id: row.id,
    dropboxId: row.dropbox_id,
    pathLower: row.path_lower,
    pathDisplay: row.path_display,
    name: row.name,
    label: row.label,
    notes: row.notes ?? null,
    preferred: row.preferred,
    retired: row.retired,
    useCases: row.use_cases ?? [],
    printavoOrderId: row.printavo_order_id ?? null,
    createdByEmail: row.created_by_email,
    updatedByEmail: row.updated_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function linkedRoot(id: string) {
  const result = await pool.query(
    `SELECT dropbox_id, path_lower, path_display, name, created_by_email,
            updated_by_email, created_at, updated_at
       FROM customer_dropbox_folders WHERE printavo_customer_id = $1`,
    [id],
  );
  return result.rows[0] as
    | {
        dropbox_id: string;
        path_lower: string;
        path_display: string;
        name: string;
        created_by_email: string;
        updated_by_email: string;
        created_at: Date;
        updated_at: Date;
      }
    | undefined;
}

/**
 * Paths must be segment-contained by the linked root. IDs must be a known
 * root/bookmark and resolve to currently-contained canonical metadata.
 */
async function authorizeLocator(
  id: string,
  locator: string,
): Promise<{
  root: NonNullable<Awaited<ReturnType<typeof linkedRoot>>>;
  locator: string;
  metadata?: DropboxMetadata;
} | null> {
  const root = await linkedRoot(id);
  if (!root) return null;
  if (locator.startsWith("id:")) {
    const known =
      locator === root.dropbox_id ||
      // Retired duplicates may exist for a file; any row keeps the ID known.
      // Containment below still revalidates against the CURRENT root, so a
      // bookmark retired by a folder relink cannot expose an outside file.
      ((await pool.query(
        `SELECT 1 FROM customer_artwork_bookmarks
          WHERE printavo_customer_id = $1 AND dropbox_id = $2
          LIMIT 1`,
        [id, locator],
      )).rowCount ?? 0) > 0;
    if (!known) return null;
    const metadata = await getDropboxMetadata(locator);
    return isDropboxMetadataWithinRoot(metadata, root.path_lower)
      ? { root, locator, metadata }
      : null;
  }
  const normalized = normalizeDropboxPath(locator);
  return normalized !== null && isDropboxPathWithinRoot(normalized, root.path_lower)
    ? { root, locator: normalized }
    : null;
}

function dropboxFailure(req: Request, res: Response, err: unknown): void {
  if (err instanceof DropboxError) {
    req.log.warn({ status: err.status, err }, "Dropbox read failed");
    res.status(err.status === 404 ? 404 : 503).json({
      error: err.status === 404 ? "Dropbox item not found" : "Dropbox is unavailable or unsupported",
      code: err.status === 404 ? "dropbox_not_found" : "dropbox_unavailable",
    });
    return;
  }
  req.log.error({ err }, "customer branding/artwork request failed");
  res.status(500).json({ error: "Request failed" });
}

function catalogColorJson(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    hex: row.hex,
    active: row.active,
    pantoneCode: row.pantone_code ?? null,
    cmyk: row.cmyk ?? null,
    inkReferences: row.ink_references ?? null,
    threadReferences: row.thread_references ?? null,
    inkStockNotes: row.ink_stock_notes ?? null,
    threadStockNotes: row.thread_stock_notes ?? null,
    createdByEmail: row.created_by_email,
    updatedByEmail: row.updated_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CATALOG_COLOR_SELECT = `id, name, hex, active, pantone_code, cmyk, ink_references,
  thread_references, ink_stock_notes, thread_stock_notes,
  created_by_email, updated_by_email, created_at, updated_at`;

/**
 * Concise, human-readable brand-standards change history. Callers pass their
 * transaction client so the event commits (or rolls back) with the mutation.
 */
async function recordBrandingEvent(
  q: { query: (text: string, params?: unknown[]) => Promise<unknown> },
  customerIdValue: string,
  area: "colors" | "typography" | "notes" | "logos",
  summary: string,
  actor: string,
): Promise<void> {
  await q.query(
    `INSERT INTO customer_branding_events (printavo_customer_id, area, summary, actor_email)
     VALUES ($1, $2, $3, $4)`,
    [customerIdValue, area, summary.slice(0, 500), actor],
  );
}

router.get("/branding/colors", async (req, res): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT ${CATALOG_COLOR_SELECT} FROM branding_colors ORDER BY active DESC, name ASC LIMIT 500`,
    );
    res.json({ colors: result.rows.map(catalogColorJson) });
  } catch (err) {
    dropboxFailure(req, res, err);
  }
});

router.post("/branding/colors", requireAdmin, async (req, res): Promise<void> => {
  const parsed = CreateBrandingColorBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid catalog color" });
    return;
  }
  const body = parsed.data;
  const clean = (value: string | null | undefined) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed ? trimmed : null;
  };
  try {
    const result = await pool.query(
      `INSERT INTO branding_colors
         (name, hex, pantone_code, cmyk, ink_references, thread_references,
          ink_stock_notes, thread_stock_notes, created_by_email, updated_by_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       RETURNING ${CATALOG_COLOR_SELECT}`,
      [
        body.name.trim(),
        body.hex.toUpperCase(),
        clean(body.pantoneCode),
        clean(body.cmyk),
        clean(body.inkReferences),
        clean(body.threadReferences),
        clean(body.inkStockNotes),
        clean(body.threadStockNotes),
        req.staff!.email,
      ],
    );
    res.status(201).json(catalogColorJson(result.rows[0]));
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "A color with this name already exists" });
      return;
    }
    dropboxFailure(req, res, err);
  }
});

router.patch("/branding/colors/:colorId", requireAdmin, async (req, res): Promise<void> => {
  const colorIdParam = String(req.params.colorId);
  if (!UUID_RE.test(colorIdParam)) {
    res.status(404).json({ error: "Color not found" });
    return;
  }
  const parsed = UpdateBrandingColorBody.safeParse(req.body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    res.status(400).json({ error: "Nothing valid to update" });
    return;
  }
  const body = parsed.data;
  const sets: string[] = [];
  const params: unknown[] = [];
  const add = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  const clean = (value: string | null | undefined) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed ? trimmed : null;
  };
  if (body.name !== undefined) add("name", body.name.trim());
  if (body.hex !== undefined) add("hex", body.hex.toUpperCase());
  if (body.active !== undefined) add("active", body.active);
  if (body.pantoneCode !== undefined) add("pantone_code", clean(body.pantoneCode));
  if (body.cmyk !== undefined) add("cmyk", clean(body.cmyk));
  if (body.inkReferences !== undefined) add("ink_references", clean(body.inkReferences));
  if (body.threadReferences !== undefined) add("thread_references", clean(body.threadReferences));
  if (body.inkStockNotes !== undefined) add("ink_stock_notes", clean(body.inkStockNotes));
  if (body.threadStockNotes !== undefined) add("thread_stock_notes", clean(body.threadStockNotes));
  if (!sets.length) {
    res.status(400).json({ error: "Nothing valid to update" });
    return;
  }
  add("updated_by_email", req.staff!.email);
  params.push(colorIdParam);
  try {
    const result = await pool.query(
      `UPDATE branding_colors SET ${sets.join(", ")}, updated_at = now()
        WHERE id = $${params.length}::uuid
        RETURNING ${CATALOG_COLOR_SELECT}`,
      params,
    );
    if (!result.rows[0]) {
      res.status(404).json({ error: "Color not found" });
      return;
    }
    res.json(catalogColorJson(result.rows[0]));
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "A color with this name already exists" });
      return;
    }
    dropboxFailure(req, res, err);
  }
});

router.get("/customers/:id/branding", async (req, res): Promise<void> => {
  const id = customerId(req, res);
  if (!id) return;
  try {
    if (!(await customerExists(id))) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const [branding, colors, typography, events] = await Promise.all([
      pool.query(
        `SELECT notes, created_by_email, updated_by_email, created_at, updated_at
           FROM customer_branding WHERE printavo_customer_id = $1`,
        [id],
      ),
      pool.query(
        `SELECT a.id AS assignment_id, a.role, a.status, a.updated_by_email,
                a.updated_at, a.retired_at, a.retired_by_email,
                c.id AS color_id, c.name, c.hex, c.active AS color_active,
                c.pantone_code, c.cmyk, c.ink_references, c.thread_references,
                c.ink_stock_notes, c.thread_stock_notes
           FROM customer_branding_colors a
           JOIN branding_colors c ON c.id = a.color_id
          WHERE a.printavo_customer_id = $1
          ORDER BY (a.status = 'current') DESC, a.role ASC, a.updated_at DESC
          LIMIT 200`,
        [id],
      ),
      pool.query(
        `SELECT id, role, font_name, capitalization, usage_notes, status,
                updated_by_email, updated_at, retired_at, retired_by_email
           FROM customer_branding_typography
          WHERE printavo_customer_id = $1
          ORDER BY (status = 'current') DESC, sort_order ASC, updated_at DESC
          LIMIT 200`,
        [id],
      ),
      pool.query(
        `SELECT id, area, summary, actor_email, created_at
           FROM customer_branding_events
          WHERE printavo_customer_id = $1
          ORDER BY created_at DESC LIMIT 50`,
        [id],
      ),
    ]);
    const row = branding.rows[0];
    res.json({
      configured: Boolean(row),
      notes: row?.notes ?? null,
      colors: colors.rows.map((assignment) => ({
        assignmentId: assignment.assignment_id,
        role: assignment.role,
        status: assignment.status,
        colorId: assignment.color_id,
        name: assignment.name,
        hex: assignment.hex,
        pantoneCode: assignment.pantone_code ?? null,
        cmyk: assignment.cmyk ?? null,
        inkReferences: assignment.ink_references ?? null,
        threadReferences: assignment.thread_references ?? null,
        inkStockNotes: assignment.ink_stock_notes ?? null,
        threadStockNotes: assignment.thread_stock_notes ?? null,
        colorActive: assignment.color_active,
        updatedByEmail: assignment.updated_by_email,
        updatedAt: assignment.updated_at,
        retiredAt: assignment.retired_at ?? null,
        retiredByEmail: assignment.retired_by_email ?? null,
      })),
      typography: typography.rows.map((entry) => ({
        id: entry.id,
        role: entry.role,
        fontName: entry.font_name,
        capitalization: entry.capitalization ?? null,
        usageNotes: entry.usage_notes ?? null,
        status: entry.status,
        updatedByEmail: entry.updated_by_email,
        updatedAt: entry.updated_at,
        retiredAt: entry.retired_at ?? null,
        retiredByEmail: entry.retired_by_email ?? null,
      })),
      events: events.rows.map((event) => ({
        id: event.id,
        area: event.area,
        summary: event.summary,
        actorEmail: event.actor_email,
        createdAt: event.created_at,
      })),
      audit: row
        ? {
            createdByEmail: row.created_by_email,
            updatedByEmail: row.updated_by_email,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }
        : null,
    });
  } catch (err) {
    dropboxFailure(req, res, err);
  }
});

router.put("/customers/:id/branding", requireAdmin, async (req, res): Promise<void> => {
  const id = customerId(req, res);
  if (!id) return;
  const parsed = UpdateCustomerBrandingBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid branding selection" });
    return;
  }
  const notes = parsed.data.notes;
  const colors = parsed.data.colors.map((color) => ({
    role: color.role.trim(),
    colorId: color.colorId,
  }));
  const typography = parsed.data.typography.map((entry) => ({
    role: entry.role.trim(),
    fontName: entry.fontName.trim(),
    capitalization: entry.capitalization?.trim() || null,
    usageNotes: entry.usageNotes?.trim() || null,
  }));
  if (
    colors.some((color) => !color.role) ||
    new Set(colors.map((color) => color.role.toLowerCase())).size !== colors.length ||
    typography.some((entry) => !entry.role || !entry.fontName)
  ) {
    res.status(400).json({ error: "Invalid branding selection" });
    return;
  }
  const actor = req.staff!.email;
  const client = await pool.connect();
  try {
    if (!(await customerExists(id))) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    await client.query("BEGIN");
    const colorIds = [...new Set(colors.map((color) => color.colorId))];
    const colorNameById = new Map<string, string>();
    if (colorIds.length) {
      const valid = await client.query(
        `SELECT id, name FROM branding_colors WHERE id = ANY($1::uuid[]) AND active = true`,
        [colorIds],
      );
      if (valid.rowCount !== colorIds.length) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Unknown or inactive branding color" });
        return;
      }
      for (const colorRow of valid.rows) colorNameById.set(colorRow.id, colorRow.name);
    }

    const existing = await client.query(
      `SELECT notes FROM customer_branding WHERE printavo_customer_id = $1 FOR UPDATE`,
      [id],
    );
    const previousNotes: string | null | undefined = existing.rows[0]?.notes;
    await client.query(
      `INSERT INTO customer_branding
         (printavo_customer_id, notes, created_by_email, updated_by_email)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (printavo_customer_id) DO UPDATE SET
         notes = excluded.notes,
         updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [id, notes, actor],
    );

    const summaries: Array<{ area: "colors" | "typography" | "notes"; summary: string }> = [];

    // Colors: retire assignments that changed or were removed; add new ones.
    const currentColors = await client.query(
      `SELECT a.id, a.role, a.color_id, c.name
         FROM customer_branding_colors a JOIN branding_colors c ON c.id = a.color_id
        WHERE a.printavo_customer_id = $1 AND a.status = 'current' FOR UPDATE OF a`,
      [id],
    );
    const requestedByKey = new Map(
      colors.map((color) => [`${color.role.toLowerCase()}\u0000${color.colorId}`, color]),
    );
    const keptKeys = new Set<string>();
    for (const current of currentColors.rows) {
      const key = `${String(current.role).toLowerCase()}\u0000${current.color_id}`;
      if (requestedByKey.has(key)) {
        keptKeys.add(key);
        continue;
      }
      await client.query(
        `UPDATE customer_branding_colors
            SET status = 'retired', retired_at = now(), retired_by_email = $2,
                updated_by_email = $2, updated_at = now()
          WHERE id = $1::uuid`,
        [current.id, actor],
      );
      summaries.push({
        area: "colors",
        summary: `Retired ${current.role} color ${current.name}`,
      });
    }
    for (const color of colors) {
      const key = `${color.role.toLowerCase()}\u0000${color.colorId}`;
      if (keptKeys.has(key)) continue;
      await client.query(
        `INSERT INTO customer_branding_colors
          (printavo_customer_id, role, color_id, created_by_email, updated_by_email)
         VALUES ($1, $2, $3::uuid, $4, $4)`,
        [id, color.role, color.colorId, actor],
      );
      summaries.push({
        area: "colors",
        summary: `Set ${color.role} color to ${colorNameById.get(color.colorId) ?? "?"}`,
      });
    }

    // Typography: same retire-instead-of-delete approach, matched on the full tuple.
    const currentTypography = await client.query(
      `SELECT id, role, font_name, capitalization, usage_notes
         FROM customer_branding_typography
        WHERE printavo_customer_id = $1 AND status = 'current' FOR UPDATE`,
      [id],
    );
    const typographyKey = (entry: {
      role: string;
      fontName: string;
      capitalization: string | null;
      usageNotes: string | null;
    }) =>
      [entry.role.toLowerCase(), entry.fontName, entry.capitalization ?? "", entry.usageNotes ?? ""].join("\u0000");
    const requestedTypographyKeys = new Map(
      typography.map((entry, index) => [typographyKey(entry), { entry, index }]),
    );
    const keptTypographyKeys = new Set<string>();
    for (const current of currentTypography.rows) {
      const key = typographyKey({
        role: String(current.role),
        fontName: String(current.font_name),
        capitalization: current.capitalization ?? null,
        usageNotes: current.usage_notes ?? null,
      });
      const requested = requestedTypographyKeys.get(key);
      if (requested && !keptTypographyKeys.has(key)) {
        keptTypographyKeys.add(key);
        await client.query(
          `UPDATE customer_branding_typography SET sort_order = $2 WHERE id = $1::uuid`,
          [current.id, requested.index],
        );
        continue;
      }
      await client.query(
        `UPDATE customer_branding_typography
            SET status = 'retired', retired_at = now(), retired_by_email = $2,
                updated_by_email = $2, updated_at = now()
          WHERE id = $1::uuid`,
        [current.id, actor],
      );
      summaries.push({
        area: "typography",
        summary: `Retired ${current.role} font ${current.font_name}`,
      });
    }
    for (const [key, { entry, index }] of requestedTypographyKeys) {
      if (keptTypographyKeys.has(key)) continue;
      await client.query(
        `INSERT INTO customer_branding_typography
          (printavo_customer_id, role, font_name, capitalization, usage_notes,
           sort_order, created_by_email, updated_by_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [id, entry.role, entry.fontName, entry.capitalization, entry.usageNotes, index, actor],
      );
      summaries.push({
        area: "typography",
        summary: `Added ${entry.role} font ${entry.fontName}`,
      });
    }

    if ((previousNotes ?? null) !== (notes ?? null) && existing.rows.length > 0) {
      summaries.push({
        area: "notes",
        summary: notes ? "Updated brand notes" : "Cleared brand notes",
      });
    } else if (existing.rows.length === 0 && notes) {
      summaries.push({ area: "notes", summary: "Added brand notes" });
    }

    for (const item of summaries) {
      await recordBrandingEvent(client, id, item.area, item.summary, actor);
    }
    await client.query("COMMIT");
    res.json({ updated: true });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    dropboxFailure(req, res, err);
  } finally {
    client.release();
  }
});

router.get("/customers/:id/artwork", async (req, res): Promise<void> => {
  const id = customerId(req, res);
  if (!id) return;
  try {
    if (!(await customerExists(id))) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const root = await linkedRoot(id);
    if (!root) {
      // No folder linked, but retired bookmarks are brand-standard history:
      // their labels, approved-use rules, and notes stay readable. File
      // access stays blocked (authorizeLocator requires a linked root).
      const history = await pool.query(
        `SELECT id, dropbox_id, path_lower, path_display, name, label, notes,
                preferred, retired, use_cases, created_by_email, updated_by_email, created_at, updated_at
           FROM customer_artwork_bookmarks
          WHERE printavo_customer_id = $1 AND retired = true
          ORDER BY updated_at DESC, label ASC LIMIT 250`,
        [id],
      );
      res.json({
        linked: false,
        folder: null,
        bookmarks: history.rows.map((bookmark) => bookmarkJson(bookmark)),
      });
      return;
    }
    const bookmarks = await pool.query(
      `SELECT id, dropbox_id, path_lower, path_display, name, label, notes,
              preferred, retired, use_cases, created_by_email, updated_by_email, created_at, updated_at
         FROM customer_artwork_bookmarks
        WHERE printavo_customer_id = $1
        ORDER BY retired ASC, preferred DESC, label ASC LIMIT 250`,
      [id],
    );
    const invoiceVisualIds = [
      ...new Set(
        bookmarks.rows
          .map((bookmark) => {
            const match = String(bookmark.name).match(/(?:inv|invoice)?[ -_]?#?(\d{4,6})/i);
            return match ? Number(match[1]) : null;
          })
          .filter((visualId): visualId is number => visualId !== null),
      ),
    ];
    const matchingOrders = invoiceVisualIds.length
      ? await pool.query(
          `SELECT DISTINCT ON (visual_id) visual_id, printavo_id
             FROM pv_orders
            WHERE customer_id = $1
              AND visual_id = ANY($2::int[])
            ORDER BY visual_id, (order_type = 'invoice') DESC,
                     printavo_updated_at DESC NULLS LAST`,
          [id, invoiceVisualIds],
        )
      : { rows: [] };
    const orderIdByVisualId = new Map<number, string>(
      matchingOrders.rows.map((order) => [Number(order.visual_id), String(order.printavo_id)]),
    );
    res.json({
      linked: true,
      folder: folderJson(root),
      bookmarks: bookmarks.rows.map((bookmark) => {
        const match = String(bookmark.name).match(/(?:inv|invoice)?[ -_]?#?(\d{4,6})/i);
        return bookmarkJson({
          ...bookmark,
          printavo_order_id: match ? orderIdByVisualId.get(Number(match[1])) ?? null : null,
        });
      }),
    });
  } catch (err) {
    dropboxFailure(req, res, err);
  }
});

router.put("/customers/:id/artwork/folder", requireAdmin, async (req, res): Promise<void> => {
  const id = customerId(req, res);
  if (!id) return;
  const locator = typeof req.body?.path === "string" ? req.body.path.trim() : "";
  if (!locator || (!locator.startsWith("id:") && normalizeDropboxPath(locator) === null)) {
    res.status(400).json({ error: "A valid Dropbox folder path or id is required" });
    return;
  }
  try {
    if (!(await customerExists(id))) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    const metadata = await getDropboxMetadata(locator);
    if (
      metadata[".tag"] !== "folder" ||
      metadata.path_lower === undefined ||
      metadata.path_display === undefined
    ) {
      res.status(400).json({ error: "Dropbox locator must identify a folder" });
      return;
    }
    const actor = req.staff!.email;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        "SELECT dropbox_id FROM customer_dropbox_folders WHERE printavo_customer_id = $1 FOR UPDATE",
        [id],
      );
      // IDs previously bookmarked under another root cannot remain authorized
      // after relinking, but they are brand-standard history: retire them
      // (never delete) so labels, approved-use rules, and notes survive.
      if (current.rows[0] && current.rows[0].dropbox_id !== metadata.id) {
        const retiredRows = await client.query(
          `UPDATE customer_artwork_bookmarks
              SET retired = true, updated_by_email = $2, updated_at = now()
            WHERE printavo_customer_id = $1 AND retired = false
            RETURNING label`,
          [id, actor],
        );
        if (retiredRows.rowCount) {
          const labels = retiredRows.rows.map((row) => `"${row.label}"`).join(", ");
          await recordBrandingEvent(
            client,
            id,
            "logos",
            `Artwork folder changed to "${metadata.name}"; retired ${retiredRows.rowCount} logo bookmark${retiredRows.rowCount === 1 ? "" : "s"}: ${labels}`,
            actor,
          );
        }
      }
      await client.query(
        `INSERT INTO customer_dropbox_folders
           (printavo_customer_id, dropbox_id, path_lower, path_display, name,
            created_by_email, updated_by_email)
         VALUES ($1, $2, $3, $4, $5, $6, $6)
         ON CONFLICT (printavo_customer_id) DO UPDATE SET
           dropbox_id = excluded.dropbox_id, path_lower = excluded.path_lower,
           path_display = excluded.path_display, name = excluded.name,
           updated_by_email = excluded.updated_by_email, updated_at = now()`,
        [id, metadata.id, metadata.path_lower, metadata.path_display, metadata.name, actor],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    res.json({ linked: true, folder: metadataJson(metadata) });
  } catch (err) {
    dropboxFailure(req, res, err);
  }
});

router.delete("/customers/:id/artwork/folder", requireAdmin, async (req, res): Promise<void> => {
  const id = customerId(req, res);
  if (!id) return;
  const actor = req.staff!.email;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Unlinking removes folder access, but bookmarks are brand-standard
    // history: retire them (never delete) so their record survives.
    const retiredRows = await client.query(
      `UPDATE customer_artwork_bookmarks
          SET retired = true, updated_by_email = $2, updated_at = now()
        WHERE printavo_customer_id = $1 AND retired = false
        RETURNING label`,
      [id, actor],
    );
    const unlinked = await client.query(
      "DELETE FROM customer_dropbox_folders WHERE printavo_customer_id = $1 RETURNING name",
      [id],
    );
    if (unlinked.rowCount && retiredRows.rowCount) {
      const labels = retiredRows.rows.map((row) => `"${row.label}"`).join(", ");
      await recordBrandingEvent(
        client,
        id,
        "logos",
        `Artwork folder unlinked; retired ${retiredRows.rowCount} logo bookmark${retiredRows.rowCount === 1 ? "" : "s"}: ${labels}`,
        actor,
      );
    }
    await client.query("COMMIT");
    res.status(204).end();
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    dropboxFailure(req, res, err);
  } finally {
    client.release();
  }
});

/** Admin-only folder picker. It intentionally never returns files or mutates Dropbox. */
router.get(
  "/customers/:id/artwork/folder-picker",
  requireAdmin,
  async (req, res): Promise<void> => {
    const id = customerId(req, res);
    if (!id) return;
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length > 200) {
      res.status(400).json({ error: "q must be 200 characters or fewer" });
      return;
    }
    const path = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (normalizeDropboxPath(path) === null) {
      res.status(400).json({ error: "path must be an absolute Dropbox path or empty" });
      return;
    }
    try {
      if (!(await customerExists(id))) {
        res.status(404).json({ error: "Customer not found" });
        return;
      }
      if (query) {
        const result = await searchDropbox("", query, 50);
        const folders = result.matches
          .map((match) => match.metadata?.metadata)
          .filter((entry): entry is DropboxMetadata => Boolean(entry))
          .filter((entry) => entry[".tag"] === "folder");
        res.json({
          folders: folders.map(metadataJson),
          truncated: result.has_more,
          cursor: null,
        });
        return;
      }
      const context: PageContext = {
        customerId: id,
        rootDropboxId: null,
        path: normalizeDropboxPath(path)!,
        staffEmail: req.staff!.email,
      };
      const token = typeof req.query.cursor === "string" ? req.query.cursor : "";
      const cursor = token ? resolvePageToken(token, context) : undefined;
      if (token && !cursor) {
        res.status(400).json({ error: "Invalid or expired folder-picker cursor" });
        return;
      }
      const result = await listDropboxFolder({ path, cursor: cursor ?? undefined, limit: 100 });
      res.json({
        folders: result.entries
          .filter((entry) => entry[".tag"] === "folder")
          .map(metadataJson),
        truncated: result.has_more,
        cursor: issuePageToken(result.cursor, context),
      });
    } catch (err) {
      dropboxFailure(req, res, err);
    }
  },
);

router.get("/customers/:id/artwork/browse", async (req, res): Promise<void> => {
  const id = customerId(req, res);
  if (!id) return;
  try {
    const root = await linkedRoot(id);
    if (!root) {
      res.json({ linked: false, entries: [], truncated: false, cursor: null });
      return;
    }
    const requested = typeof req.query.path === "string" ? req.query.path : root.path_lower;
    const normalizedPath = requested.startsWith("id:")
      ? requested
      : normalizeDropboxPath(requested);
    if (normalizedPath === null) {
      res.status(400).json({ error: "Invalid Dropbox path" });
      return;
    }
    const context: PageContext = {
      customerId: id,
      rootDropboxId: root.dropbox_id,
      path: normalizedPath,
      staffEmail: null,
    };
    const token = typeof req.query.cursor === "string" ? req.query.cursor : "";
    const cursor = token ? resolvePageToken(token, context) : undefined;
    if (token && !cursor) {
      res.status(400).json({ error: "Invalid or expired artwork cursor" });
      return;
    }
    const allowed = await authorizeLocator(id, requested);
    if (!allowed) {
      res.status(400).json({ error: "Dropbox path is outside the linked customer folder" });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 100);
    const result = await listDropboxFolder({
      path: allowed.locator,
      cursor: cursor ?? undefined,
      limit,
    });
    res.json({
      linked: true,
      entries: result.entries.map(metadataJson),
      truncated: result.has_more,
      cursor: issuePageToken(result.cursor, context),
    });
  } catch (err) {
    dropboxFailure(req, res, err);
  }
});

router.get("/customers/:id/artwork/search", async (req, res): Promise<void> => {
  const id = customerId(req, res);
  if (!id) return;
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query || query.length > 200) {
    res.status(400).json({ error: "q is required (max 200 chars)" });
    return;
  }
  try {
    const root = await linkedRoot(id);
    if (!root) {
      res.json({ linked: false, entries: [], truncated: false, cursor: null });
      return;
    }
    const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
    const result = await searchDropbox(root.path_lower, query, limit);
    const entries = result.matches
      .map((match) => match.metadata?.metadata)
      .filter((item): item is DropboxMetadata => Boolean(item))
      .filter((item) => !item.path_lower || isDropboxPathWithinRoot(item.path_lower, root.path_lower));
    res.json({
      linked: true,
      entries: entries.map(metadataJson),
      truncated: result.has_more,
      cursor: null,
    });
  } catch (err) {
    dropboxFailure(req, res, err);
  }
});

async function metadataOrLink(req: Request, res: Response, temporaryLink: boolean): Promise<void> {
  const id = customerId(req, res);
  if (!id) return;
  const locator = typeof req.query.locator === "string" ? req.query.locator.trim() : "";
  if (!locator) {
    res.status(400).json({ error: "locator is required" });
    return;
  }
  try {
    const allowed = await authorizeLocator(id, locator);
    if (!allowed) {
      res.status(400).json({ error: "Dropbox locator is not authorized for this customer" });
      return;
    }
    if (temporaryLink) {
      const metadata = allowed.metadata ?? (await getDropboxMetadata(allowed.locator));
      if (metadata[".tag"] !== "file") {
        res.status(400).json({ error: "Only files can be downloaded" });
        return;
      }
      const link = await getDropboxTemporaryLink(allowed.locator);
      if (req.query.inline === "true") {
        const extension = metadata.name.slice(metadata.name.lastIndexOf(".")).toLowerCase();
        const contentType = ARTWORK_PREVIEW_TYPES[extension];
        if (!contentType) {
          res.status(415).json({ error: "In-app preview is available for PDF, PNG, JPG, GIF, and WebP files" });
          return;
        }
        if (metadata.size && metadata.size > MAX_ARTWORK_PREVIEW_BYTES) {
          res.status(413).json({ error: "This file is too large to preview in Hub" });
          return;
        }
        const temporaryUrl = new URL(link);
        if (
          temporaryUrl.protocol !== "https:" ||
          !(temporaryUrl.hostname === "dropbox.com" ||
            temporaryUrl.hostname.endsWith(".dropbox.com") ||
            temporaryUrl.hostname.endsWith(".dropboxusercontent.com"))
        ) {
          throw new DropboxError(502, "Dropbox returned an invalid temporary link");
        }
        const upstream = await fetch(temporaryUrl, {
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });
        if (!upstream.ok) {
          throw new DropboxError(upstream.status, `Dropbox preview returned ${upstream.status}`);
        }
        const declaredSize = Number(upstream.headers.get("content-length"));
        if (Number.isFinite(declaredSize) && declaredSize > MAX_ARTWORK_PREVIEW_BYTES) {
          res.status(413).json({ error: "This file is too large to preview in Hub" });
          return;
        }
        const body = Buffer.from(await upstream.arrayBuffer());
        if (body.byteLength > MAX_ARTWORK_PREVIEW_BYTES) {
          res.status(413).json({ error: "This file is too large to preview in Hub" });
          return;
        }
        res.setHeader("Content-Type", contentType);
        res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(metadata.name)}`);
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.send(body);
      } else if (req.query.redirect === "true") {
        res.redirect(302, link);
      } else {
        res.json({ link, expires: "temporary" });
      }
    } else {
      res.json(metadataJson(allowed.metadata ?? (await getDropboxMetadata(allowed.locator))));
    }
  } catch (err) {
    dropboxFailure(req, res, err);
  }
}

router.get("/customers/:id/artwork/metadata", (req, res) => metadataOrLink(req, res, false));
router.get("/customers/:id/artwork/temporary-link", (req, res) =>
  metadataOrLink(req, res, true),
);

router.post("/customers/:id/artwork/bookmarks", requireAdmin, async (req, res): Promise<void> => {
  const id = customerId(req, res);
  if (!id) return;
  const path = typeof req.body?.path === "string" ? req.body.path.trim() : "";
  const label = typeof req.body?.label === "string" ? req.body.label.trim() : "";
  const notes = req.body?.notes ?? null;
  const useCases = parseUseCases(req.body?.useCases);
  if (
    !path ||
    !label ||
    label.length > 160 ||
    !(notes === null || (typeof notes === "string" && notes.length <= 5000)) ||
    useCases === null
  ) {
    res.status(400).json({ error: "Valid path, label, and notes are required" });
    return;
  }
  try {
    const allowed = await authorizeLocator(id, path);
    if (!allowed || path.startsWith("id:")) {
      res.status(400).json({ error: "Bookmark path must be within the linked folder" });
      return;
    }
    const metadata = allowed.metadata ?? (await getDropboxMetadata(allowed.locator));
    if (!metadata.path_lower || !metadata.path_display) {
      res.status(400).json({ error: "Dropbox item has no usable path" });
      return;
    }
    const actor = req.staff!.email;
    // Bookmark + history event commit together: a standard change without its
    // audit trail must not be possible.
    const client = await pool.connect();
    let created;
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `INSERT INTO customer_artwork_bookmarks
           (printavo_customer_id, dropbox_id, path_lower, path_display, name,
            label, notes, preferred, retired, use_cases, created_by_email, updated_by_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
         RETURNING *`,
        [
          id,
          metadata.id,
          metadata.path_lower,
          metadata.path_display,
          metadata.name,
          label,
          notes,
          req.body?.preferred === true,
          req.body?.retired === true,
          useCases,
          actor,
        ],
      );
      await recordBrandingEvent(client, id, "logos", `Bookmarked logo "${label}"`, actor);
      await client.query("COMMIT");
      created = result.rows[0];
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    res.status(201).json(bookmarkJson(created));
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "23505") {
      res.status(409).json({ error: "This Dropbox item is already bookmarked" });
      return;
    }
    dropboxFailure(req, res, err);
  }
});

router.patch(
  "/customers/:id/artwork/bookmarks/:bookmarkId",
  requireAdmin,
  async (req, res): Promise<void> => {
    const id = customerId(req, res);
    if (!id) return;
    const bookmarkId = String(req.params.bookmarkId);
    if (!UUID_RE.test(bookmarkId)) {
      res.status(404).json({ error: "Bookmark not found" });
      return;
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const add = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (typeof req.body?.label === "string" && req.body.label.trim() && req.body.label.length <= 160)
      add("label", req.body.label.trim());
    if (req.body?.notes === null || (typeof req.body?.notes === "string" && req.body.notes.length <= 5000))
      add("notes", req.body.notes);
    if (typeof req.body?.preferred === "boolean") add("preferred", req.body.preferred);
    if (typeof req.body?.retired === "boolean") add("retired", req.body.retired);
    if (req.body?.useCases !== undefined) {
      const useCases = parseUseCases(req.body.useCases);
      if (useCases === null) {
        res.status(400).json({ error: "Invalid use cases" });
        return;
      }
      add("use_cases", useCases);
    }
    if (!sets.length) {
      res.status(400).json({ error: "Nothing valid to update" });
      return;
    }
    add("updated_by_email", req.staff!.email);
    params.push(id, bookmarkId);
    // Update + history event commit together (row locked so the recorded
    // "before" state cannot race a concurrent edit).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const before = await client.query(
        `SELECT label, notes, preferred, retired, use_cases FROM customer_artwork_bookmarks
          WHERE printavo_customer_id = $1 AND id = $2::uuid
          FOR UPDATE`,
        [id, bookmarkId],
      );
      if (!before.rows[0]) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Bookmark not found" });
        return;
      }
      const result = await client.query(
        `UPDATE customer_artwork_bookmarks SET ${sets.join(", ")}, updated_at = now()
          WHERE printavo_customer_id = $${params.length - 1} AND id = $${params.length}::uuid
          RETURNING *`,
        params,
      );
      const previous = before.rows[0];
      const updated = result.rows[0];
      const actor = req.staff!.email;
      const changes: string[] = [];
      if (previous.retired !== updated.retired) {
        changes.push(updated.retired ? "marked retired" : "restored to current");
      }
      if (previous.preferred !== updated.preferred) {
        changes.push(updated.preferred ? "pinned as staple" : "unpinned as staple");
      }
      const previousUseCases = Array.isArray(previous.use_cases) ? previous.use_cases : [];
      const updatedUseCases = Array.isArray(updated.use_cases) ? updated.use_cases : [];
      if (previousUseCases.join(",") !== updatedUseCases.join(",")) {
        const labels = updatedUseCases.map(
          (useCase: string) => USE_CASE_LABELS[useCase] ?? useCase,
        );
        changes.push(labels.length ? `use cases set to ${labels.join(", ")}` : "use cases cleared");
      }
      if (previous.label !== updated.label) {
        changes.push(`renamed to "${updated.label}"`);
      }
      if ((previous.notes ?? null) !== (updated.notes ?? null)) {
        changes.push(updated.notes ? "usage notes updated" : "usage notes cleared");
      }
      if (changes.length) {
        await recordBrandingEvent(
          client,
          id,
          "logos",
          `Logo "${previous.label}": ${changes.join("; ")}`,
          actor,
        );
      }
      await client.query("COMMIT");
      res.json(bookmarkJson(updated));
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      dropboxFailure(req, res, err);
    } finally {
      client.release();
    }
  },
);

router.delete(
  "/customers/:id/artwork/bookmarks/:bookmarkId",
  requireAdmin,
  async (req, res): Promise<void> => {
    const id = customerId(req, res);
    if (!id) return;
    const bookmarkId = String(req.params.bookmarkId);
    if (!UUID_RE.test(bookmarkId)) {
      res.status(404).json({ error: "Bookmark not found" });
      return;
    }
    // Retire, never delete: brand-standard history must survive removal.
    const actor = req.staff!.email;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        `SELECT label, retired FROM customer_artwork_bookmarks
          WHERE printavo_customer_id = $1 AND id = $2::uuid
          FOR UPDATE`,
        [id, bookmarkId],
      );
      if (!existing.rows[0]) {
        await client.query("ROLLBACK");
        res.status(404).json({ error: "Bookmark not found" });
        return;
      }
      if (!existing.rows[0].retired) {
        await client.query(
          `UPDATE customer_artwork_bookmarks
              SET retired = true, updated_by_email = $3, updated_at = now()
            WHERE printavo_customer_id = $1 AND id = $2::uuid`,
          [id, bookmarkId, actor],
        );
        await recordBrandingEvent(
          client,
          id,
          "logos",
          `Retired logo bookmark "${existing.rows[0].label}"`,
          actor,
        );
      }
      await client.query("COMMIT");
      res.status(204).end();
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      dropboxFailure(req, res, err);
    } finally {
      client.release();
    }
  },
);

export default router;