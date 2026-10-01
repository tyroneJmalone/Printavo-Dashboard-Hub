import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseCsv, toCsv, validateRules, ruleDefinitions, pythonRoot, versionMatches, consultantGuidance, ruleMetadata, ruleDto } from "../src/lib/printscope/rules";
import { safeFilename, childEnvironment, scopedPath, validateProtocol, parseProcStat, verifyRuleSnapshot, classifyEngineFailure } from "../src/lib/printscope/worker";
import { MODULE_DEFS } from "../src/lib/auth/moduleAccess";
import printscopeRouter, { rerunValues, jobDto, revisionToken, sourceBindingMatches, sourceEligibilityReasons, sourceMetadataReasons } from "../src/routes/printscope";
import { requireAdmin } from "../src/middlewares/requireStaff";
import { ObjectStorageSigningError, signObjectUploadURL } from "../src/lib/objectStorage";

test("filename is display metadata, never a local path", () => {
  for (const name of ["../x.ai", "C:\\x.ai", "a.ai\n", "x.pdf", "/x.ai", ""]) assert.equal(safeFilename(name), false);
  assert.equal(safeFilename("#22251 F.ai"), true);
});
test("object upload signing accepts only a successful HTTPS URL and classifies safe failures", async () => {
  const okFetch = async () => new Response(JSON.stringify({ signed_url: "https://storage.googleapis.com/private/signed" }), { status: 200 });
  assert.equal(await signObjectUploadURL("/bucket/.private/object", 900, okFetch as typeof fetch), "https://storage.googleapis.com/private/signed");
  const httpFetch = async () => new Response("credential detail must not escape", { status: 403 });
  await assert.rejects(
    signObjectUploadURL("/bucket/.private/object", 900, httpFetch as typeof fetch),
    (error: any) => error instanceof ObjectStorageSigningError && error.kind === "http" && error.status === 403 && !error.message.includes("credential detail"),
  );
  const malformedFetch = async () => new Response(JSON.stringify({ signed_url: "http://unsafe.invalid" }), { status: 200 });
  await assert.rejects(
    signObjectUploadURL("/bucket/.private/object", 900, malformedFetch as typeof fetch),
    (error: any) => error instanceof ObjectStorageSigningError && error.kind === "invalid_response",
  );
});
test("minimal worker environment excludes application secrets", () => {
  process.env.PRINTSCOPE_TEST_SECRET = "not-inherited";
  const env = childEnvironment("/tmp/test");
  assert.equal(env.PRINTSCOPE_TEST_SECRET, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.TMPDIR, "/tmp/test");
});
test("worker probe failures expose bounded dependency codes, not stderr", () => {
  assert.equal(classifyEngineFailure("ModuleNotFoundError: No module named 'pikepdf'"), "ENGINE_PYTHON_DEPENDENCY");
  assert.equal(classifyEngineFailure("printscope worker: gs is unavailable: [Errno 2]"), "ENGINE_RENDERER_DEPENDENCY");
  assert.equal(classifyEngineFailure("renderer capability check failed: exit 1"), "ENGINE_RENDERER_PROBE");
  assert.equal(classifyEngineFailure("arbitrary internal detail"), "ENGINE_FAILED");
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
test("consultant guidance preserves all 13 filled worksheet rows verbatim, with explicit decision counts", async () => {
  const worksheet = parseCsv(await readFile(resolve(pythonRoot(), "../../..", consultantGuidance.source), "utf8"));
  const filled = worksheet.filter(row => row.consultant_definition);
  assert.equal(filled.length, 13);
  assert.equal(consultantGuidance.rules.length, 13);
  assert.equal(new Set(consultantGuidance.rules.map(row => row.code)).size, 13);
  for (const row of filled) {
    const guidance = consultantGuidance.rules.find(g => g.code === row.code)!;
    assert.ok(guidance, row.code);
    assert.equal(guidance.definition, row.consultant_definition);
    assert.equal(guidance.exceptions, row.consultant_exceptions);
    assert.equal(guidance.validationSamples, row.consultant_validation_samples);
  }
  const counts = consultantGuidance.rules.reduce<Record<string, number>>((all, g) => {
    all[g.decision] = (all[g.decision] ?? 0) + 1;
    return all;
  }, {});
  assert.deepEqual(counts, { build_now: 5, disabled_recalibration: 1, held: 4, validation_pending: 3 });
  assert.deepEqual(consultantGuidance.rules.filter(g => g.decision === "validation_pending").map(g => g.code),
    ["IMAGE_MIN_DPI", "IMAGE_HARD_MIN_DPI", "IMAGE_NOT_RGB"]);
});
test("current guidance is additive metadata, never a rewrite of historical snapshot rows or hash", async () => {
  const csv = await readFile(resolve(pythonRoot(), "printscope-engine/printscope-rules-v2.csv"), "utf8");
  const snapshot = { id: 1, csv, rows: parseCsv(csv), hash: createHash("sha256").update(csv).digest("hex"), created_by: "original", created_at: "2026-09-01" };
  const before = structuredClone(snapshot);
  const dto = await ruleDto(snapshot);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(dto.rows, before.rows);
  assert.equal(dto.hash, before.hash);
  assert.equal(dto.createdAt, before.created_at);
  assert.equal(Object.values(dto.editable).filter(meta => meta.guidance).length, 13);
  const overlap = dto.editable.INK_OVERLAP_NOT_TRAP;
  assert.equal(overlap.guidance?.scope, "current_guidance");
  assert.equal(overlap.guidance?.asOf, "2026-10-01");
  assert.equal(overlap.severityPolicy, "info");
  verifyRuleSnapshot(snapshot);
});
test("held rules and disabled CHOKE cannot become editable merely by registering a detector", () => {
  for (const g of consultantGuidance.rules.filter(g => ["held", "disabled_recalibration"].includes(g.decision))) {
    const meta = ruleMetadata(g.code, new Set([g.code]));
    assert.equal(meta.implemented, false);
    assert.deepEqual(meta.fields, []);
    assert.deepEqual(meta.thresholds, []);
  }
});
test("info-only policy permits unchanged legacy settings but rejects new promotions and excludes them from judged-check minimum", async () => {
  const rows = parseCsv(await readFile(resolve(pythonRoot(), "printscope-engine/printscope-rules-v2.csv"), "utf8"));
  const implemented = await ruleDefinitions();
  implemented.add("INK_OVERLAP_NOT_TRAP");
  implemented.add("INK_CHANGE_DECLARED");
  // Simulate an immutable pre-guidance snapshot, even if new seed defaults change.
  rows.find(r => r.code === "INK_OVERLAP_NOT_TRAP")!.severity = "flag";
  const before = structuredClone(rows);
  validateRules(rows, rows, implemented);
  assert.deepEqual(rows, before);
  const edits = structuredClone(rows);
  edits.find(r => r.code === "INK_OVERLAP_NOT_TRAP")!.severity = "fail";
  assert.throws(() => validateRules(edits, rows, implemented), /informational only/);
  edits.find(r => r.code === "INK_OVERLAP_NOT_TRAP")!.severity = "info";
  validateRules(edits, rows, implemented);
  const promoted = structuredClone(edits);
  promoted.find(r => r.code === "INK_OVERLAP_NOT_TRAP")!.severity = "flag";
  assert.throws(() => validateRules(promoted, edits, implemented), /informational only/);
  const inkChange = structuredClone(rows);
  inkChange.find(r => r.code === "INK_CHANGE_DECLARED")!.severity = "flag";
  assert.throws(() => validateRules(inkChange, rows, implemented), /informational only/);
  const onlyInfo = rows.map(r => ruleMetadata(r.code, implemented).implemented && r.code !== "INK_OVERLAP_NOT_TRAP"
    ? { ...r, enabled: "false" } : { ...r });
  assert.throws(() => validateRules(onlyInfo, rows, implemented), /At least one judged check/);
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
test("pilot source eligibility excludes public PDFs, stale mirrors, unsupported names and oversize files", () => {
  const base = { id: "source", source_kind: "production_file", status: "mirrored", object_path: "/bucket/source", file_name: "separations.ai", byte_size: 123 };
  assert.deepEqual(sourceEligibilityReasons(base), []);
  assert.deepEqual(sourceEligibilityReasons({ ...base, source_kind: "public_pdf" }), ["not_production_file"]);
  assert.deepEqual(sourceEligibilityReasons({ ...base, status: "pending" }), ["not_mirrored"]);
  assert.deepEqual(sourceEligibilityReasons({ ...base, file_name: "invoice.pdf" }), ["unsupported_filename"]);
  assert.deepEqual(sourceEligibilityReasons({ ...base, byte_size: 50 * 1024 * 1024 + 1 }), ["unsupported_size"]);
});
test("pilot revision binds metadata and exact mirrored generation", () => {
  const row = { id: "source", order_printavo_id: "order", order_visual_id: 42, file_name: "art.ai", byte_size: 100, mirrored_at: "2026-01-01", object_path: "/private/source" };
  const token = revisionToken(row, "7");
  const input = { expectedGeneration: "7", expectedFilename: "art.ai", expectedBytes: 100, revisionToken: token };
  assert.equal(sourceBindingMatches(row, "7", input, 100), true);
  assert.equal(sourceBindingMatches(row, "8", input, 100), false);
  assert.equal(sourceBindingMatches({ ...row, file_name: "changed.ai" }, "7", input, 100), false);
  assert.equal(sourceBindingMatches(row, "7", input, 99), false);
});
test("pilot source metadata failures remain visible and explicitly ineligible", () => {
  const row = { byte_size: 100 };
  assert.deepEqual(sourceMetadataReasons(row), ["mirror_object_unavailable"]);
  assert.deepEqual(sourceMetadataReasons(row, { size: 100 }), ["mirror_generation_unavailable"]);
  assert.deepEqual(sourceMetadataReasons(row, { generation: "7", size: 99 }), ["mirror_size_mismatch"]);
  assert.deepEqual(sourceMetadataReasons(row, { generation: "7", size: 100 }), []);
});