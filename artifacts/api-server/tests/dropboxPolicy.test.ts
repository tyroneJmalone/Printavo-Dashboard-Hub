import assert from "node:assert/strict";
import test from "node:test";
import {
  DROPBOX_READ_ENDPOINTS,
  isDropboxMetadataWithinRoot,
  isDropboxPathWithinRoot,
  normalizeDropboxPath,
} from "../src/lib/dropbox";

test("Dropbox path containment is segment-aware and rejects traversal", () => {
  assert.equal(isDropboxPathWithinRoot("/Clients/Acme/logo.ai", "/clients/acme"), true);
  assert.equal(isDropboxPathWithinRoot("/clients/acme", "/clients/acme"), true);
  assert.equal(isDropboxPathWithinRoot("/clients/acme-old/logo.ai", "/clients/acme"), false);
  assert.equal(isDropboxPathWithinRoot("/clients/acme/../other/logo.ai", "/clients/acme"), false);
  assert.equal(isDropboxPathWithinRoot("/clients/acme\\other", "/clients/acme"), false);
  assert.equal(normalizeDropboxPath("relative/path"), null);
});

test("moved Dropbox IDs are rejected by canonical metadata containment", () => {
  assert.equal(
    isDropboxMetadataWithinRoot({ path_lower: "/clients/acme/art/logo.ai" }, "/clients/acme"),
    true,
  );
  // A bookmark id remains valid at Dropbox after moving, but not for Acme.
  assert.equal(
    isDropboxMetadataWithinRoot({ path_lower: "/clients/other/logo.ai" }, "/clients/acme"),
    false,
  );
  assert.equal(isDropboxMetadataWithinRoot({}, "/clients/acme"), false);
});

test("provider policy exposes only approved read operations", () => {
  assert.deepEqual([...DROPBOX_READ_ENDPOINTS].sort(), [
    "/2/files/get_metadata",
    "/2/files/get_temporary_link",
    "/2/files/list_folder",
    "/2/files/list_folder/continue",
    "/2/files/search_v2",
  ]);
  for (const endpoint of DROPBOX_READ_ENDPOINTS) {
    assert.doesNotMatch(endpoint, /(upload|delete|move|copy|create|sharing)/i);
  }
});