#!/usr/bin/env node
/**
 * Upload generated Cap America JPEGs to App Storage's public search prefix.
 * Uses the same Replit sidecar credentials as the API server; no credentials
 * or signed URLs are written to the repository.
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Storage } = require("../../api-server/node_modules/@google-cloud/storage");

const root = process.argv[2];
if (!root) throw new Error("Usage: uploadCapAmericaSamples.mjs <asset-root>");

const searchPaths = (process.env.PUBLIC_OBJECT_SEARCH_PATHS || "")
  .split(",")
  .map((path) => path.trim())
  .filter(Boolean);
if (!searchPaths.length) throw new Error("PUBLIC_OBJECT_SEARCH_PATHS is not configured");

const [bucketName, ...prefixParts] = searchPaths[0].replace(/^\/+/, "").split("/");
const prefix = prefixParts.join("/");
if (!bucketName || !prefix) throw new Error("PUBLIC_OBJECT_SEARCH_PATHS must contain /bucket/prefix");

const storage = new Storage({
  credentials: {
    audience: "replit",
    subject_token_type: "access_token",
    token_url: "http://127.0.0.1:1106/token",
    type: "external_account",
    credential_source: {
      url: "http://127.0.0.1:1106/credential",
      format: { type: "json", subject_token_field_name: "access_token" },
    },
    universe_domain: "googleapis.com",
  },
  projectId: "",
});

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile() && entry.name.endsWith(".jpg")) files.push(path);
  }
  return files;
}

const files = await filesUnder(root);
const bucket = storage.bucket(bucketName);
for (const filePath of files) {
  const objectName = `${prefix}/cap-america-2026/${relative(root, filePath).replaceAll("\\", "/")}`;
  await bucket.upload(filePath, {
    destination: objectName,
    metadata: {
      contentType: "image/jpeg",
      cacheControl: "public,max-age=31536000,immutable",
    },
  });
}
console.log(`Uploaded ${files.length} images to gs://${bucketName}/${prefix}/cap-america-2026/`);