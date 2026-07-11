import type { DecorationMatrixData } from "@workspace/api-client-react";
import { UUID_RE } from "./matrixGrid";

export interface ImportItem {
  id?: string;
  data: DecorationMatrixData;
}

function isDataShape(v: unknown): v is DecorationMatrixData {
  return (
    !!v &&
    typeof v === "object" &&
    Array.isArray((v as { xValues?: unknown }).xValues)
  );
}

/** Old exports can have a blank name/xAxisLabel — fill sane defaults so the API accepts them. */
function withDefaults(
  data: DecorationMatrixData,
  fallbackName?: string,
): DecorationMatrixData {
  const name = (data.name ?? "").trim() || (fallbackName ?? "").trim();
  const xAxisLabel = (data.xAxisLabel ?? "").trim() || "Options";
  return { ...data, name, xAxisLabel };
}

/** Accept an array, a {matrices:[…]} envelope, a single matrix, or a raw data shape. */
export function normalizeImport(parsed: unknown): ImportItem[] {
  let list: unknown[];
  if (Array.isArray(parsed)) list = parsed;
  else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { matrices?: unknown }).matrices)
  )
    list = (parsed as { matrices: unknown[] }).matrices;
  else list = [parsed];

  const items: ImportItem[] = [];
  for (const el of list) {
    if (!el || typeof el !== "object") continue;
    const rec = el as { id?: unknown; name?: unknown; data?: unknown };
    const validId =
      typeof rec.id === "string" && UUID_RE.test(rec.id) ? rec.id : undefined;
    const fallbackName =
      typeof rec.name === "string" ? rec.name : undefined;
    if (isDataShape(rec.data)) {
      items.push({ id: validId, data: withDefaults(rec.data, fallbackName) });
    } else if (isDataShape(el)) {
      items.push({ data: withDefaults(el) });
    }
  }
  return items;
}

/** Minimal RFC 4180 CSV parser: quoted fields, "" escapes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length > 0) endRow();
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Parse a CSV export from the old app: header row with id,name,data columns. */
export function matricesFromCsv(text: string): ImportItem[] {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const dataIdx = header.indexOf("data");
  if (dataIdx === -1) return [];
  const idIdx = header.indexOf("id");
  const nameIdx = header.indexOf("name");

  const items: ImportItem[] = [];
  for (const row of rows.slice(1)) {
    const raw = row[dataIdx];
    if (!raw || !raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isDataShape(parsed)) continue;
    const idRaw = idIdx >= 0 ? (row[idIdx] ?? "").trim() : "";
    const id = UUID_RE.test(idRaw) ? idRaw : undefined;
    const fallbackName = nameIdx >= 0 ? row[nameIdx] : undefined;
    items.push({ id, data: withDefaults(parsed, fallbackName) });
  }
  return items;
}

/** De-dupe by id (last occurrence wins); items without an id are always kept. */
function dedupe(items: ImportItem[]): ImportItem[] {
  const seen = new Map<string, number>();
  const out: ImportItem[] = [];
  for (const it of items) {
    if (it.id && seen.has(it.id)) {
      out[seen.get(it.id)!] = it;
      continue;
    }
    if (it.id) seen.set(it.id, out.length);
    out.push(it);
  }
  return out;
}

export interface ParsedImport {
  items: ImportItem[];
  format: "json" | "csv" | null;
}

/** Auto-detect: JSON first, then CSV. */
export function parseImportText(text: string): ParsedImport {
  const t = text.trim();
  if (!t) return { items: [], format: null };
  try {
    const parsed = JSON.parse(t);
    return { items: dedupe(normalizeImport(parsed)), format: "json" };
  } catch {
    // not JSON — try CSV
  }
  const items = dedupe(matricesFromCsv(t));
  return { items, format: items.length > 0 ? "csv" : null };
}
