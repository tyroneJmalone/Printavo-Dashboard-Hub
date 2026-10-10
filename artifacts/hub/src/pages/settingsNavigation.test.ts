import test from "node:test";
import assert from "node:assert/strict";
import {
  canOpenSettingsSection,
  legacySettingsHref,
  resolveSettingsSection,
  settingsHref,
  settingsSections,
} from "./settingsNavigation.ts";

const section = (id: string) => {
  const match = settingsSections.find((item) => item.id === id);
  assert.ok(match, `Missing settings section: ${id}`);
  return match;
};

test("all old tool bookmarks redirect to their exact section and retain tool queries", () => {
  const paths = {
    "/knowledge": "knowledge-base",
    "/ai-connections": "ai-connections",
    "/voice-profiles": "voice-profiles",
    "/email-activity/access": "email-access",
    "/email-activity/settings": "email-tracker",
    "/print-queue-rules": "print-queue-rules",
    "/auto-print": "auto-print",
    "/status-rules": "purchasing-status-rules",
  };
  for (const [path, id] of Object.entries(paths)) {
    const href = legacySettingsHref(path, "?tab=history&group=access&section=admin-pin");
    assert.ok(href);
    assert.equal(resolveSettingsSection(new URL(href, "https://hub.example").search)?.id, id);
    assert.equal(new URL(href, "https://hub.example").searchParams.get("tab"), "history");
  }
  assert.equal(legacySettingsHref("/mintbucks/settings"), undefined);
});

test("section links preserve unrelated query fields while selecting one group/tool", () => {
  const url = new URL(settingsHref("auto-print", "?filter=recent&tab=rules&section=email-tracker"), "https://hub.example");
  assert.equal(url.searchParams.get("group"), "rules");
  assert.equal(url.searchParams.get("section"), "auto-print");
  assert.equal(url.searchParams.get("filter"), "recent");
  assert.equal(url.searchParams.get("tab"), "rules");
});

test("AutoPrint notification redirects retain run/job and all inbox/review anchors", () => {
  for (const hash of ["#autoprint-notifications", "#autoprint-retry-review", "#autoprint-run-history"]) {
    const href = legacySettingsHref("/auto-print", "?run=run-id&job=job-id", hash)!;
    const url = new URL(href, "https://hub.example");
    assert.equal(url.hash, hash);
    assert.equal(url.searchParams.get("run"), "run-id");
    assert.equal(url.searchParams.get("job"), "job-id");
    assert.equal(url.searchParams.get("section"), "auto-print");
  }
});

test("module readiness and original admin restrictions apply before mounting tools", () => {
  assert.equal(canOpenSettingsSection(section("knowledge-base"), "staff", []), false);
  assert.equal(canOpenSettingsSection(section("knowledge-base"), "manager", ["knowledge"]), true);
  assert.equal(canOpenSettingsSection(section("auto-print"), "staff", ["purchasing"]), false);
  assert.equal(canOpenSettingsSection(section("print-queue-rules"), "manager", ["production"]), true);
  assert.equal(canOpenSettingsSection(section("purchasing-status-rules"), "staff", ["production"]), false);
  assert.equal(canOpenSettingsSection(section("shipping-address"), "staff", ["purchasing"]), true);
  for (const id of ["staff-access", "module-access", "admin-pin", "ai-connections", "email-access", "email-tracker"]) {
    assert.equal(canOpenSettingsSection(section(id), "manager", ["production", "knowledge"]), false, id);
    assert.equal(canOpenSettingsSection(section(id), "admin", []), true, id);
  }
  assert.equal(canOpenSettingsSection(section("voice-profiles"), "staff", []), true);
});