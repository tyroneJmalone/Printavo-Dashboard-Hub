import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_AUTO_PRINT_CONFIG,
  normalizeAutoPrintConfig,
} from "../src/lib/printQueue/autoPrint/configValidation.ts";
import { applyAutoPrintAttachmentOption } from "../src/lib/printQueue/autoPrint/pdf.ts";
import { UpdateAutoPrintConfigBody } from "../../../lib/api-zod/src/generated/api.ts";

test("existing settings and malformed values keep attachments by default", () => {
  assert.equal(DEFAULT_AUTO_PRINT_CONFIG.excludeAttachments, false);
  assert.equal(normalizeAutoPrintConfig({ enabled: true, dryRun: false }).excludeAttachments, false);
  for (const invalid of ["true", 1, null, {}]) {
    assert.equal(normalizeAutoPrintConfig({ excludeAttachments: invalid }).excludeAttachments, false);
  }
});

test("explicit boolean survives config normalization and persisted JSON roundtrip", () => {
  for (const enabled of [true, false]) {
    const saved = normalizeAutoPrintConfig({ excludeAttachments: enabled });
    assert.equal(saved.excludeAttachments, enabled);
    assert.equal(normalizeAutoPrintConfig(JSON.parse(JSON.stringify(saved))).excludeAttachments, enabled);
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

test("renderer hides only attachment blocks when requested", async () => {
  const styles: string[] = [];
  const page = {
    async addStyleTag({ content }: { content: string }) {
      styles.push(content);
    },
  };
  await applyAutoPrintAttachmentOption(page);
  await applyAutoPrintAttachmentOption(page, { excludeAttachments: false });
  assert.deepEqual(styles, []);
  await applyAutoPrintAttachmentOption(page, { excludeAttachments: true });
  assert.deepEqual(styles, [".printing__keep-together { display: none !important; }"]);
});