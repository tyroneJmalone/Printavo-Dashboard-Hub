import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AUTO_PRINT_CONFIG,
  normalizeAutoPrintConfig,
} from "../src/lib/printQueue/autoPrint/configValidation.ts";
import { applyAutoPrintAttachmentOption } from "../src/lib/printQueue/autoPrint/pdf.ts";
import { UpdateAutoPrintConfigBody } from "../../../lib/api-zod/src/generated/api.ts";

test("existing settings and malformed values always exclude attachments", () => {
  assert.equal(DEFAULT_AUTO_PRINT_CONFIG.excludeAttachments, true);
  assert.equal(normalizeAutoPrintConfig({ enabled: true, dryRun: false }).excludeAttachments, true);
  for (const invalid of ["true", 1, null, {}]) {
    assert.equal(normalizeAutoPrintConfig({ excludeAttachments: invalid }).excludeAttachments, true);
  }
});

test("legacy false settings normalize to mandatory exclusion after a JSON roundtrip", () => {
  for (const enabled of [true, false]) {
    const saved = normalizeAutoPrintConfig({ excludeAttachments: enabled });
    assert.equal(saved.excludeAttachments, true);
    assert.equal(normalizeAutoPrintConfig(JSON.parse(JSON.stringify(saved))).excludeAttachments, true);
  }
});

test("config request accepts booleans and rejects non-boolean attachment values", () => {
  const config = normalizeAutoPrintConfig({});
  assert.equal(UpdateAutoPrintConfigBody.safeParse(config).success, true);
  assert.equal(
    UpdateAutoPrintConfigBody.safeParse({ ...config, excludeAttachments: true }).success,
    true,
  );
  assert.equal(
    UpdateAutoPrintConfigBody.safeParse({ ...config, excludeAttachments: "true" }).success,
    false,
  );
});

test("renderer always hides attachment blocks even for legacy false callers", async () => {
  const styles: string[] = [];
  const page = {
    async addStyleTag({ content }: { content: string }) {
      styles.push(content);
    },
  };
  await applyAutoPrintAttachmentOption(page);
  await applyAutoPrintAttachmentOption(page, { excludeAttachments: false });
  assert.equal(styles.length, 2);
  await applyAutoPrintAttachmentOption(page, { excludeAttachments: true });
  assert.deepEqual(styles, Array(3).fill(".printing__keep-together { display: none !important; }"));
});