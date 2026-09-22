import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pool } from "@workspace/db";

export type Rule = Record<string, string>;
export function versionMatches(expected: number, active: number) { return expected === active; }
export const thresholds: Record<string, string[]> = {
  STROKE_MIN_WIDTH: ["min_pt"], TRIM_ARTIFACT_RESIDUE: ["min_pt", "min_count"],
  UNDERBASE_CHOKE_PER_OBJECT: ["choke_plus_spread_pt", "abs"],
  TRAP_AT_NEGATIVE_SPACE: ["trap_required_below_pct", "trap_not_required_above_pct"],
  ARTWORK_IN_REGISTER: ["abs"], UNDERBASE_COVERAGE: ["partial_below_pct", "partial_above_pct"],
};
export function pythonRoot() {
  return resolve(process.cwd(), process.cwd().endsWith("api-server") ? "python" : "artifacts/api-server/python");
}
export function parseCsv(text: string): Rule[] {
  const records: string[][] = []; let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (!quoted && (c === "," || c === "\n")) {
      row.push(cell.replace(/\r$/, "")); cell = "";
      if (c === "\n") { records.push(row); row = []; }
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); records.push(row); }
  const headers = records.shift()!;
  return records.filter(r => r.length === headers.length).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
}
export function toCsv(rows: Rule[]) {
  const keys = Object.keys(rows[0]);
  const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
  return [keys, ...rows.map(r => keys.map(k => r[k]))].map(r => r.map(quote).join(",")).join("\n") + "\n";
}
export async function ruleDefinitions() {
  const source = await readFile(resolve(pythonRoot(), "printscope-engine/detect.py"), "utf8");
  return new Set([...source.matchAll(/@rule\("([^"]+)"\)/g)].map(m => m[1]).filter(c => c !== "CHOKE_SAFE_FOR_DETAIL"));
}
export function validateRules(rows: Rule[], base: Rule[], implemented: Set<string>) {
  if (rows.length !== base.length || new Set(rows.map(r => r.code)).size !== base.length) throw new Error("Full unique rule snapshot required");
  for (const old of base) {
    const r = rows.find(r => r.code === old.code);
    if (!r || Object.keys(r).length !== Object.keys(old).length) throw new Error("Rule columns cannot change");
    const fields = implemented.has(r.code) ? ["enabled", "severity", "remediation_text", ...(thresholds[r.code] ? ["expected", "tolerance"] : [])] : [];
    for (const k of Object.keys(old)) if (typeof r[k] !== "string" || (!fields.includes(k) && r[k] !== old[k])) throw new Error(`${old.code}: ${k} is read-only`);
    if (!["true", "false"].includes(r.enabled) || !["fail", "flag", "info"].includes(r.severity)) throw new Error("Invalid enabled or severity");
    if (r.code === "CHOKE_SAFE_FOR_DETAIL" && r.enabled !== "false") throw new Error("CHOKE_SAFE_FOR_DETAIL must remain disabled");
    for (const field of ["expected", "tolerance"]) {
      const val = JSON.parse(r[field]), prev = JSON.parse(old[field]);
      if (!val || Array.isArray(val) || typeof val !== "object") throw new Error("Threshold must be a JSON object");
      for (const key of new Set([...Object.keys(val), ...Object.keys(prev)])) {
        if (JSON.stringify(val[key]) === JSON.stringify(prev[key])) continue;
        if (!thresholds[r.code]?.includes(key) || typeof val[key] !== "number" || !Number.isFinite(val[key]) || val[key] < 0 || val[key] > (key.includes("pct") ? 100 : 10000)) throw new Error(`${r.code}: unsupported or invalid threshold ${key}`);
      }
      const p = { ...JSON.parse(r.expected), ...JSON.parse(r.tolerance) };
      if (p.trap_required_below_pct > p.trap_not_required_above_pct || p.partial_below_pct > p.partial_above_pct) throw new Error("Threshold bands are inverted");
      if (p.min_count !== undefined && !Number.isInteger(p.min_count)) throw new Error("Count must be integer");
    }
  }
  if (!rows.some(r => implemented.has(r.code) && r.enabled === "true" && r.severity !== "info")) throw new Error("At least one judged check must remain enabled");
}
export async function activeRules() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN"); await c.query("SELECT pg_advisory_xact_lock(728419)");
    let row = (await c.query("SELECT * FROM printscope_rule_versions ORDER BY id DESC LIMIT 1")).rows[0];
    if (!row) {
      const csv = await readFile(resolve(pythonRoot(), "printscope-engine/printscope-rules-v2.csv"), "utf8");
      row = (await c.query("INSERT INTO printscope_rule_versions(rows,csv,hash) VALUES($1,$2,$3) RETURNING *", [JSON.stringify(parseCsv(csv)), csv, createHash("sha256").update(csv).digest("hex")])).rows[0];
    }
    await c.query("COMMIT"); return row;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
export async function ruleDto(row: any) {
  const implemented = await ruleDefinitions();
  return { id: row.id, rows: row.rows, hash: row.hash, createdBy: row.created_by, createdAt: row.created_at,
    editable: Object.fromEntries(row.rows.map((r: Rule) => [r.code, { implemented: implemented.has(r.code), fields: implemented.has(r.code) ? ["enabled", "severity", "remediation_text"] : [], thresholds: thresholds[r.code] ?? [] }])) };
}