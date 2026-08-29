import { Router, type IRouter, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
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
      (await pool.query(
        `SELECT 1 FROM customer_artwork_bookmarks
          WHERE printavo_customer_id = $1 AND dropbox_id = $2`,
        [id, locator],
      )).rowCount === 1;
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

router.get("/branding/colors", async (req, res): Promise<void> => {
  try {
    const result = await pool.query(
      `SELECT id, name, hex, active, pantone_code, cmyk, rgb, ink_references,
              thread_references, ink_stock_notes, thread_stock_notes,
              created_by_email, updated_by_email, created_at, updated_at
         FROM branding_colors ORDER BY active DESC, name ASC LIMIT 500`,
    );
    res.json({
      colors: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        hex: row.hex,
        active: row.active,
        pantoneCode: row.pantone_code,
        cmyk: row.cmyk,
        rgb: row.rgb,
        inkReferences: row.ink_references,
        threadReferences: row.thread_references,
        inkStockNotes: row.ink_stock_notes,
        threadStockNotes: row.thread_stock_notes,
        createdByEmail: row.created_by_email,
        updatedByEmail: row.updated_by_email,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    });
  } catch (err) {
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
    const [branding, colors] = await Promise.all([
      pool.query(
        `SELECT notes, fonts, created_by_email, updated_by_email, created_at, updated_at
           FROM customer_branding WHERE printavo_customer_id = $1`,
        [id],
      ),
      pool.query(
        `SELECT a.role, c.id, c.name, c.hex
           FROM customer_branding_colors a
           JOIN branding_colors c ON c.id = a.color_id
          WHERE a.printavo_customer_id = $1 ORDER BY a.role`,
        [id],
      ),
    ]);
    const row = branding.rows[0];
    res.json({
      configured: Boolean(row),
      notes: row?.notes ?? null,
      fonts: row?.fonts ?? [],
      colors: colors.rows,
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
  const notes = req.body?.notes;
  const fonts = req.body?.fonts;
  const colors = req.body?.colors;
  if (
    !(notes === null || (typeof notes === "string" && notes.length <= 10_000)) ||
    !Array.isArray(fonts) ||
    fonts.length > 20 ||
    !fonts.every((font) => typeof font === "string" && font.trim() && font.length <= 120) ||
    !Array.isArray(colors) ||
    colors.length > 20 ||
    !colors.every(
      (color) =>
        color &&
        typeof color.role === "string" &&
        color.role.trim().length > 0 &&
        color.role.length <= 80 &&
        typeof color.colorId === "string" &&
        UUID_RE.test(color.colorId),
    ) ||
    new Set(colors.map((color: { role: string }) => color.role.trim().toLowerCase())).size !== colors.length
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
    const colorIds = colors.map((color: { colorId: string }) => color.colorId);
    if (colorIds.length) {
      const valid = await client.query(
        `SELECT id FROM branding_colors WHERE id = ANY($1::uuid[]) AND active = true`,
        [colorIds],
      );
      if (valid.rowCount !== new Set(colorIds).size) {
        await client.query("ROLLBACK");
        res.status(400).json({ error: "Unknown or inactive branding color" });
        return;
      }
    }
    await client.query(
      `INSERT INTO customer_branding
         (printavo_customer_id, notes, fonts, created_by_email, updated_by_email)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (printavo_customer_id) DO UPDATE SET
         notes = excluded.notes, fonts = excluded.fonts,
         updated_by_email = excluded.updated_by_email, updated_at = now()`,
      [id, notes, fonts.map((font: string) => font.trim()), actor],
    );
    await client.query(
      "DELETE FROM customer_branding_colors WHERE printavo_customer_id = $1",
      [id],
    );
    for (const color of colors as Array<{ role: string; colorId: string }>) {
      await client.query(
        `INSERT INTO customer_branding_colors
          (printavo_customer_id, role, color_id, created_by_email, updated_by_email)
         VALUES ($1, $2, $3::uuid, $4, $4)`,
        [id, color.role.trim(), color.colorId, actor],
      );
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
      res.json({ linked: false, folder: null, bookmarks: [] });
      return;
    }
    const bookmarks = await pool.query(
      `SELECT id, dropbox_id, path_lower, path_display, name, label, notes,
              preferred, retired, created_by_email, updated_by_email, created_at, updated_at
         FROM customer_artwork_bookmarks
        WHERE printavo_customer_id = $1
        ORDER BY retired ASC, preferred DESC, label ASC LIMIT 250`,
      [id],
    );
    res.json({
      linked: true,
      folder: folderJson(root),
      bookmarks: bookmarks.rows.map((bookmark) => bookmarkJson(bookmark)),
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
      // after relinking. The folder FK would not otherwise distinguish roots.
      if (current.rows[0] && current.rows[0].dropbox_id !== metadata.id) {
        await client.query(
          "DELETE FROM customer_artwork_bookmarks WHERE printavo_customer_id = $1",
          [id],
        );
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
  try {
    await pool.query(
      "DELETE FROM customer_dropbox_folders WHERE printavo_customer_id = $1",
      [id],
    );
    res.status(204).end();
  } catch (err) {
    dropboxFailure(req, res, err);
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
      res.json({ link, expires: "temporary" });
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
  if (
    !path ||
    !label ||
    label.length > 160 ||
    !(notes === null || (typeof notes === "string" && notes.length <= 5000))
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
    const result = await pool.query(
      `INSERT INTO customer_artwork_bookmarks
         (printavo_customer_id, dropbox_id, path_lower, path_display, name,
          label, notes, preferred, retired, created_by_email, updated_by_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
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
        actor,
      ],
    );
    res.status(201).json(bookmarkJson(result.rows[0]));
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
    if (!sets.length) {
      res.status(400).json({ error: "Nothing valid to update" });
      return;
    }
    add("updated_by_email", req.staff!.email);
    params.push(id, bookmarkId);
    try {
      const result = await pool.query(
        `UPDATE customer_artwork_bookmarks SET ${sets.join(", ")}, updated_at = now()
          WHERE printavo_customer_id = $${params.length - 1} AND id = $${params.length}::uuid
          RETURNING *`,
        params,
      );
      if (!result.rows[0]) {
        res.status(404).json({ error: "Bookmark not found" });
        return;
      }
      res.json(bookmarkJson(result.rows[0]));
    } catch (err) {
      dropboxFailure(req, res, err);
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
    try {
      const result = await pool.query(
        `DELETE FROM customer_artwork_bookmarks
          WHERE printavo_customer_id = $1 AND id = $2::uuid`,
        [id, bookmarkId],
      );
      if (!result.rowCount) {
        res.status(404).json({ error: "Bookmark not found" });
        return;
      }
      res.status(204).end();
    } catch (err) {
      dropboxFailure(req, res, err);
    }
  },
);

export default router;