import assert from "node:assert/strict";
import express from "express";
import { pool } from "@workspace/db";
import printscopeRouter from "../src/routes/printscope";
import { environment } from "../src/lib/printscope/worker";

if (environment !== "development" || process.env.REPLIT_DEPLOYMENT === "1") throw new Error("Development only");
const jobId = "dc5b8f9c-0e59-4907-8f21-1e63567a690b";
const staff = (await pool.query("SELECT * FROM staff_users WHERE email='printscope-pilot-staff@example.com'")).rows[0];
assert.ok(staff, "Synthetic PrintScope staff seed is missing");
const foreign = (await pool.query("SELECT id FROM printscope_jobs WHERE environment='development' AND pilot_id IS NULL ORDER BY created_at DESC LIMIT 1")).rows[0];
assert.ok(foreign, "A nonpilot PrintScope job is required for the scope check");

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (req.headers["x-printscope-test-staff"] === "1") req.staff = staff;
  next();
});
app.use("/api", printscopeRouter);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>(resolve => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api/printscope/pilot/jobs`;
async function get(path: string, authenticated = true) {
  return fetch(base + path, { headers: authenticated ? { "x-printscope-test-staff": "1" } : {} });
}

try {
  const fullResponse = await get(`/${jobId}/reviews?limit=25&offset=0`);
  assert.equal(fullResponse.status, 200);
  const full = await fullResponse.json() as any;
  assert.equal(full.total, 2);
  assert.equal(full.reviews.length, 2);
  assert.equal(full.reviews[0].outcome, "pass");
  assert.equal(full.reviews[0].reason, "Synthetic review correction");
  assert.equal(full.reviews[1].outcome, "flag");
  assert.equal(full.reviews[1].reason, "Synthetic browser pilot validation");
  for (const review of full.reviews) {
    assert.equal(review.jobId, jobId);
    assert.match(review.reviewerId, /^[0-9a-f-]{36}$/i);
    assert.ok(!Number.isNaN(Date.parse(review.createdAt)));
    assert.ok(Object.hasOwn(review, "note"));
  }

  const pageResponse = await get(`/${jobId}/reviews?limit=1&offset=1`);
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.json() as any;
  assert.equal(page.total, 2);
  assert.equal(page.reviews.length, 1);
  assert.equal(page.reviews[0].outcome, "flag");
  assert.equal(page.reviews[0].reason, "Synthetic browser pilot validation");

  assert.equal((await get(`/${foreign.id}/reviews`)).status, 404);
  assert.equal((await get(`/${jobId}/reviews`, false)).status, 401);
  process.stdout.write(JSON.stringify({ passed: true, total: full.total, newest: full.reviews[0].outcome, second: full.reviews[1].outcome, pagination: "limit=1 offset=1", foreignNonpilot: 404, unauthenticated: 401, mutations: 0 }) + "\n");
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await pool.end();
}