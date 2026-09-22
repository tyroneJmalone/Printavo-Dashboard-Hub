import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseCsv, toCsv, validateRules, ruleDefinitions, pythonRoot, versionMatches } from "../src/lib/printscope/rules";
import { safeFilename, childEnvironment, scopedPath, validateProtocol, parseProcStat, verifyRuleSnapshot } from "../src/lib/printscope/worker";
import { MODULE_DEFS } from "../src/lib/auth/moduleAccess";
import printscopeRouter, { rerunValues, jobDto } from "../src/routes/printscope";
import { requireAdmin } from "../src/middlewares/requireStaff";

test("filename is display metadata, never a local path", () => {
  for (const name of ["../x.ai", "C:\\x.ai", "a.ai\n", "x.pdf", "/x.ai", ""]) assert.equal(safeFilename(name), false);
  assert.equal(safeFilename("#22251 F.ai"), true);
});
test("minimal worker environment excludes application secrets", () => {
  process.env.PRINTSCOPE_TEST_SECRET = "not-inherited";
  const env = childEnvironment("/tmp/test");
  assert.equal(env.PRINTSCOPE_TEST_SECRET, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.TMPDIR, "/tmp/test");
});
test("asset scope rejects traversal and escaped symlinks", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "ps-test-"));
  try {
    await writeFile(resolve(root, "ok.svg"), "<svg/>");
    assert.equal(await scopedPath(root, "ok.svg"), resolve(root, "ok.svg"));
    await assert.rejects(scopedPath(root, "../outside"));
    await symlink("/etc/passwd", resolve(root, "escape.svg"));
    await assert.rejects(scopedPath(root, "escape.svg"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("rules roundtrip and supported edits; unsupported, disabled and invalid sets rejected", async () => {
  const rows = parseCsv(await readFile(resolve(pythonRoot(), "printscope-engine/printscope-rules-v2.csv"), "utf8"));
  const implemented = await ruleDefinitions();
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
  validateRules(rows, rows, implemented);
  const edit = structuredClone(rows);
  edit.find(r => r.code === "STROKE_MIN_WIDTH")!.expected = '{"min_pt":0.5}';
  validateRules(edit, rows, implemented);
  edit.find(r => r.code === "STROKE_MIN_WIDTH")!.expected = '{"min_pt":"bad"}';
  assert.throws(() => validateRules(edit, rows, implemented));
  const choke = structuredClone(rows);
  choke.find(r => r.code === "CHOKE_SAFE_FOR_DETAIL")!.enabled = "true";
  assert.throws(() => validateRules(choke, rows, implemented));
  assert.throws(() => validateRules(rows.map(r => ({ ...r, enabled: "false" })), rows, implemented));
});
test("PrintScope API family is claimed by the readiness registry", () => {
  assert.deepEqual(MODULE_DEFS.find(m => m.key === "printscope")?.apiPrefixes, ["/printscope"]);
});
test("optimistic version conflict and immutable rerun identity", () => {
  assert.equal(versionMatches(2, 3), false);
  assert.equal(versionMatches(3, 3), true);
  const old = { id: "old", filename: "art.ai", byte_size: 5, content_type: "application/pdf", source_path: "/private/original", generation: "123", sha256: "a".repeat(64), rule_version_id: 1 };
  const before = structuredClone(old), values = rerunValues(old, 9, "new-staff");
  assert.notEqual(values[0], old.id);
  assert.equal(values[5], old.source_path);
  assert.equal(values[6], old.generation);
  assert.equal(values[7], old.sha256);
  assert.equal(values[8], 9);
  assert.deepEqual(old, before);
  assert.throws(() => rerunValues({ ...old, generation: null }, 9, "staff"));
  assert.equal("source_path" in jobDto(old), false);
});
test("worker protocol never trusts returned arbitrary paths", () => {
  validateProtocol({ resultPath: "/tmp/work/result.json", assetsRoot: "/tmp/work/site" }, "/tmp/work");
  assert.throws(() => validateProtocol({ resultPath: "/etc/passwd", assetsRoot: "/tmp/work/site" }, "/tmp/work"));
  assert.throws(() => validateProtocol(null, "/tmp/work"));
});
test("Linux RSS process-group parser handles spaces and parentheses in comm", () => {
  const fields = Array.from({ length: 30 }, () => "0");
  fields[0] = "S"; fields[2] = "4321"; fields[21] = "250";
  assert.deepEqual(parseProcStat(`123 (render worker (1)) ${fields.join(" ")}`), { pgrp: 4321, rssPages: 250 });
  assert.throws(() => parseProcStat("invalid"));
});
test("snapshot integrity pins original CSV bytes and parsed rows", () => {
  const csv = 'code,expected\nTEST,"{""min_pt"":0.25}"\n';
  const snapshot = { csv, rows: parseCsv(csv), hash: createHash("sha256").update(csv).digest("hex") };
  verifyRuleSnapshot(snapshot);
  assert.throws(() => verifyRuleSnapshot({ ...snapshot, csv: csv + "\n" }));
  assert.throws(() => verifyRuleSnapshot({ ...snapshot, rows: [{ code: "CHANGED", expected: "{}" }] }));
});
test("router explicitly rejects missing staff; rule mutation requires admin", () => {
  let status = 0, next = false;
  const res: any = { status(n: number) { status = n; return this; }, json() { return this; } };
  printscopeRouter.stack[0].handle({}, res, () => { next = true; });
  assert.equal(status, 401); assert.equal(next, false);
  requireAdmin({ staff: { role: "staff" } } as any, res, () => { next = true; });
  assert.equal(status, 403); assert.equal(next, false);
  requireAdmin({ staff: { role: "admin" } } as any, res, () => { next = true; });
  assert.equal(next, true);
  const put = printscopeRouter.stack.find((s: any) => s.route?.path === "/printscope/rules" && s.route.methods.put);
  assert.equal(put.route.stack[0].handle, requireAdmin);
});