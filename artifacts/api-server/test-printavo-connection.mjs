import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dir = await mkdtemp(join(tmpdir(), "hub-connection-test-"));
try {
  await build({
    stdin: { resolveDir: process.cwd(), contents: `
import assert from "node:assert/strict";
import express from "express";
process.env.SESSION_SECRET = "test-only-encryption-secret";
process.env.PRINTAVO_API_EMAIL = "test@example.com";
process.env.PRINTAVO_API_TOKEN = "old-test-token";
process.env.REPLIT_DEPLOYMENT = "0";
const realFetch = globalThis.fetch;
let upstreamCalls = 0;
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("https://www.printavo.com/")) {
    upstreamCalls++;
    return new Response(JSON.stringify(options.headers.token === "bad-token" ? { errors: [{ message: "invalid" }] } : { data: { statuses: { nodes: [] } } }), { status: 200 });
  }
  return realFetch(url, options);
};
const { default: router } = await import("./src/routes/printavoConnection");
const store = await import("@workspace/db");
const { connectionCredentials, initializePrintavoConnection } = await import("./src/lib/printavoConnection");
const app = express(); app.use(express.json()); app.use(router);
const server = app.listen(0, "127.0.0.1");
await new Promise(resolve => server.once("listening", resolve));
const url = "http://127.0.0.1:" + server.address().port + "/auth/printavo-connection";
const request = (method = "GET", body, admin = true) => realFetch(url, { method, headers: { "content-type": "application/json", ...(admin ? { "x-test-admin": "1" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
try {
  assert.equal((await request("GET", undefined, false)).status, 403);
  assert.equal((await request("PUT", {email:"test@example.com",token:"new-token",expiresOn:null}, false)).status, 403);
  const first = await (await request()).json();
  assert.equal(first.configured, true); assert.equal(first.token, undefined);
  assert.equal((await request("PUT", {email:"test@example.com",expiresOn:"2026-02-30"})).status, 400);
  assert.equal((await request("PUT", {email:"test@example.com",token:"bad-token",expiresOn:null})).status, 502);
  assert.equal(store.rows.size, 0);
  assert.equal((await connectionCredentials()).token, "old-test-token");
  const saved = await request("PUT", {email:"test@example.com",token:"new-test-token",expiresOn:"2027-10-31"});
  assert.equal(saved.status, 200);
  const text = await saved.text(); assert.ok(!text.includes("new-test-token"));
  const row = [...store.rows.values()][0];
  assert.ok(!JSON.stringify(row).includes("new-test-token"));
  assert.equal((await connectionCredentials()).token, "new-test-token");
  assert.equal((await request("PUT", {email:"test@example.com",expiresOn:null})).status, 200);
  assert.equal((await (await request()).json()).expiresOn, null);
  assert.equal((await connectionCredentials()).token, "new-test-token");
  await initializePrintavoConnection();
  assert.equal((await connectionCredentials()).token, "new-test-token");
  assert.ok(upstreamCalls >= 3);
  console.log("PASS: admin gating, metadata secrecy, invalid date, failed verification preserves credentials, encrypted storage, rotation, retain token, clear date, reload");
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); globalThis.fetch = realFetch; }
` },
    outfile: join(dir, "test.mjs"), bundle: true, platform: "node", format: "esm",
    packages: "external",
    plugins: [{
      name: "isolated-settings",
      setup(b) {
        b.onResolve({ filter: /^@workspace\/db$/ }, () => ({ path: "db", namespace: "mock" }));
        b.onResolve({ filter: /middlewares\/requireStaff$/ }, () => ({ path: "auth", namespace: "mock" }));
        b.onResolve({ filter: /^@workspace\/(printavo|api-zod)$/ }, args => ({ path: join(process.cwd(), "../../lib", args.path.split("/")[1], "src/index.ts") }));
        b.onLoad({ filter: /.*/, namespace: "mock" }, args => ({ contents: args.path === "auth" ?
          'export function requireAdmin(req,res,next){if(req.headers["x-test-admin"]!=="1"){res.status(403).json({error:"Admin access required"});return;}req.staff={id:1};next();}' :
          'export const rows=new Map(); export const appSettingsTable={key:"key"}; export const db={select:()=>({from:()=>({where:async()=>[...rows.values()]})}),insert:()=>({values:(row)=>({onConflictDoUpdate:async()=>{rows.set(row.key,row)}})})};'
        }));
      },
    }],
  });
  // Resolve workspace packages from the API server's node_modules, not /tmp.
  const { symlink } = await import("node:fs/promises");
  await symlink(join(process.cwd(), "node_modules"), join(dir, "node_modules"), "dir");
  await import(pathToFileURL(join(dir, "test.mjs")).href);
} finally { await rm(dir, { recursive: true, force: true }); }
