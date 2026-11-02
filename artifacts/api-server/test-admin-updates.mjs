import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { adminDocumentsPlugin } from "./admin-documents-plugin.mjs";

const dir = await mkdtemp(join(tmpdir(), "admin-updates-"));
try {
  await build({
    stdin: { resolveDir: process.cwd(), contents: `
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import express from "express";
import router from "./src/routes/adminUpdates";
const app = express(); app.use(router);
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
try {
  const url = "http://127.0.0.1:" + server.address().port + "/auth/admin-updates";
  assert.equal((await fetch(url)).status, 403);
  const response = await fetch(url, { headers: { "x-test-admin": "1" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const data = await response.json();
  assert.equal(data.documents.length, 8);
  assert.equal(new Set(data.documents.map(d => d.id)).size, data.documents.length);
  for (const doc of data.documents) {
    assert.equal(doc.content, await readFile("../../docs/" + doc.filename, "utf8"));
    assert.ok(doc.content.length > 100);
  }
  assert.ok(data.releases.some(r => r.status === "prepared"));
  assert.ok(data.releases.filter(r => r.status === "historical").every(r => r.date === null));
  assert.equal((await fetch(url, { method: "POST", headers: { "x-test-admin": "1" } })).status, 404);
  assert.equal((await fetch(url + "/../../secret", { headers: { "x-test-admin": "1" } })).status, 404);
  console.log("PASS: admin guard wiring, read-only endpoint, no-store, curated documents match sources, honest release metadata");
} finally { server.close(); }
` },
    outfile: join(dir, "test.mjs"), platform: "node", format: "esm", bundle: true,
    external: ["express"],
    plugins: [
      adminDocumentsPlugin(),
      {
        name: "isolated-admin-guard",
        setup(build) {
          build.onResolve({ filter: /middlewares\/requireStaff$/ }, () => ({ path: "guard", namespace: "test-guard" }));
          build.onLoad({ filter: /.*/, namespace: "test-guard" }, () => ({
            contents: `export const requireAdmin = (req, res, next) => req.headers["x-test-admin"] === "1" ? next() : res.status(403).json({error:"Admin access required"});`,
            loader: "js",
          }));
        },
      },
    ],
  });
  // Packages resolve from the workspace, while the generated test remains temporary.
  const { symlink } = await import("node:fs/promises");
  await symlink(new URL("./node_modules", import.meta.url).pathname, join(dir, "node_modules"), "dir");
  await import(pathToFileURL(join(dir, "test.mjs")).href);
} finally {
  await rm(dir, { recursive: true, force: true });
}
