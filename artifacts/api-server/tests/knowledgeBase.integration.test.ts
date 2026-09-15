import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  db,
  knowledgeEntriesTable,
  knowledgeEntrySourcesTable,
  knowledgeSourceDocumentsTable,
  knowledgeSourcesTable,
} from "@workspace/db";
import { openai } from "@workspace/integrations-openai-ai-server";
import knowledgeBaseRouter from "../src/routes/knowledgeBase";

type ApiResult = {
  status: number;
  body: any;
};

const marker = `kb-route-test-${randomUUID()}`;
let requestActor = randomUUID();
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.header("x-test-role") ?? "admin";
  const actor = req.header("x-test-actor") ?? "default";
  req.staff = {
    id: `route-test-${role}-${actor}`,
    clerkUserId: `route-test-${role}-${actor}`,
    email: `${role}-${actor}@route-test.invalid`,
    role,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
  req.log = {
    info: () => undefined,
    error: () => undefined,
  } as any;
  next();
});
app.use(knowledgeBaseRouter);

let baseUrl = "";
let server: ReturnType<typeof app.listen>;

test.before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Integration test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.after(async () => {
  const leftoverEntries = await db
    .select({ id: knowledgeEntriesTable.id })
    .from(knowledgeEntriesTable)
    .where(like(knowledgeEntriesTable.title, `${marker}%`));
  const leftoverSources = await db
    .select({ id: knowledgeSourcesTable.id })
    .from(knowledgeSourcesTable)
    .where(like(knowledgeSourcesTable.name, `${marker}%`));
  assert.equal(leftoverEntries.length, 0, "integration test left knowledge entries behind");
  assert.equal(leftoverSources.length, 0, "integration test left knowledge sources behind");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await db.$client.end();
});

async function request(
  method: string,
  path: string,
  body?: unknown,
  role = "admin",
): Promise<ApiResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-role": role,
      "x-test-actor": requestActor,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
  };
}

type TestRows = {
  sourceId?: string;
  documentId?: string;
  entryIds: string[];
  mergedEntryIds: string[];
};

async function cleanup(rows: TestRows): Promise<void> {
  const entryIds = [...new Set([...rows.entryIds, ...rows.mergedEntryIds])];
  if (entryIds.length) {
    await db.delete(knowledgeEntriesTable).where(inArray(knowledgeEntriesTable.id, entryIds));
  }
  if (rows.sourceId) {
    await db.delete(knowledgeSourcesTable).where(eq(knowledgeSourcesTable.id, rows.sourceId));
  }
}

async function createTestEntries(
  rows: TestRows,
  statuses: string[] = ["draft", "draft"],
  withSourceLinks = false,
): Promise<{ entries: Array<typeof knowledgeEntriesTable.$inferSelect>; sourceId?: string; documentId?: string }> {
  const now = new Date();
  const source = withSourceLinks
    ? (
        await db
          .insert(knowledgeSourcesTable)
          .values({
            kind: "upload",
            name: `${marker}-source`,
            sourceUrl: `https://example.invalid/${marker}`,
            status: "active",
            createdByEmail: "route-test@route-test.invalid",
            updatedByEmail: "route-test@route-test.invalid",
          })
          .returning()
      )[0]
    : undefined;
  if (source) rows.sourceId = source.id;

  const document = source
    ? (
        await db
          .insert(knowledgeSourceDocumentsTable)
          .values({
            sourceId: source.id,
            name: `${marker}.txt`,
            mimeType: "text/plain",
            status: "active",
            draftCount: statuses.filter((status) => status === "draft").length,
            checksum: `${marker}-${randomUUID()}`,
            extractedText: "Temporary route integration source text.",
            createdByEmail: "route-test@route-test.invalid",
            updatedByEmail: "route-test@route-test.invalid",
          })
          .returning()
      )[0]
    : undefined;
  if (document) rows.documentId = document.id;

  const entries = await db
    .insert(knowledgeEntriesTable)
    .values(
      statuses.map((reviewStatus, index) => ({
        title: `${marker}-entry-${index}`,
        body: `${marker} body ${index}; preserve this fact and exception.`,
        category: "policy",
        tags: [marker],
        sourceName: source?.name ?? marker,
        sourceUrl: source?.sourceUrl ?? "",
        reviewStatus,
        createdByEmail: "route-test@route-test.invalid",
        updatedByEmail: "route-test@route-test.invalid",
        createdAt: now,
        updatedAt: now,
      })),
    )
    .returning();
  rows.entryIds.push(...entries.map((entry) => entry.id));

  if (document) {
    await db.insert(knowledgeEntrySourcesTable).values(
      entries.map((entry, index) => ({
        entryId: entry.id,
        documentId: document.id,
        sectionKey: `${marker}-section-${index}`,
      })),
    );
  }
  return { entries, sourceId: source?.id, documentId: document?.id };
}

async function withRows<T>(fn: (rows: TestRows) => Promise<T>): Promise<T> {
  const rows: TestRows = { entryIds: [], mergedEntryIds: [] };
  const previousActor = requestActor;
  requestActor = randomUUID();
  try {
    return await fn(rows);
  } finally {
    await cleanup(rows);
    requestActor = previousActor;
  }
}

test("bulk delete is admin-only and explicit confirmation never writes on denial", async () => {
  await withRows(async (rows) => {
    const { entries } = await createTestEntries(rows, ["draft", "approved"]);
    const snapshots = entries.map((entry) => ({
      id: entry.id,
      updatedAt: entry.updatedAt.toISOString(),
      reviewStatus: entry.reviewStatus,
    }));

    const forbidden = await request(
      "POST",
      "/knowledge/entries/bulk-delete",
      { entryIds: rows.entryIds, snapshots, confirm: true },
      "staff",
    );
    assert.equal(forbidden.status, 403);

    const noConfirmation = await request(
      "POST",
      "/knowledge/entries/bulk-delete",
      { entryIds: rows.entryIds, snapshots, confirm: false },
    );
    assert.equal(noConfirmation.status, 400);
    assert.equal(noConfirmation.body.approvedCount, 1);

    const untouched = await db
      .select({ id: knowledgeEntriesTable.id })
      .from(knowledgeEntriesTable)
      .where(inArray(knowledgeEntriesTable.id, rows.entryIds));
    assert.equal(untouched.length, 2);
  });
});

test("bulk delete rejects a stale/missing selection all-or-nothing", async () => {
  await withRows(async (rows) => {
    const { entries } = await createTestEntries(rows, ["draft", "approved"]);
    const stale = await request("POST", "/knowledge/entries/bulk-delete", {
      entryIds: [...rows.entryIds, "00000000-0000-4000-8000-000000000099"],
      snapshots: [
        ...entries.map((entry) => ({
          id: entry.id,
          updatedAt: entry.updatedAt.toISOString(),
          reviewStatus: entry.reviewStatus,
        })),
        {
          id: "00000000-0000-4000-8000-000000000099",
          updatedAt: "2026-01-01T00:00:00.000Z",
          reviewStatus: "draft",
        },
      ],
      confirm: true,
    });
    assert.equal(stale.status, 409);

    const untouched = await db
      .select({ id: knowledgeEntriesTable.id })
      .from(knowledgeEntriesTable)
      .where(inArray(knowledgeEntriesTable.id, rows.entryIds));
    assert.deepEqual(new Set(untouched.map((entry) => entry.id)), new Set(rows.entryIds));
  });
});

test("bulk delete rejects same-status edits and approval changes, then refreshes document draft counts", async () => {
  await withRows(async (rows) => {
    const { entries, documentId } = await createTestEntries(rows, ["draft", "draft"], true);
    assert.ok(documentId);
    const snapshots = entries.map((entry) => ({
      id: entry.id,
      updatedAt: entry.updatedAt.toISOString(),
      reviewStatus: entry.reviewStatus,
    }));
    await db
      .update(knowledgeEntriesTable)
      .set({ body: `${marker} same-status edit`, updatedAt: new Date(Date.now() + 1000) })
      .where(eq(knowledgeEntriesTable.id, entries[0]!.id));
    const sameStatus = await request("POST", "/knowledge/entries/bulk-delete", {
      entryIds: rows.entryIds,
      snapshots,
      confirm: true,
    });
    assert.equal(sameStatus.status, 409);

    const current = await db
      .select()
      .from(knowledgeEntriesTable)
      .where(inArray(knowledgeEntriesTable.id, rows.entryIds));
    const approvalSnapshots = current.map((entry) => ({
      id: entry.id,
      updatedAt: entry.updatedAt.toISOString(),
      reviewStatus: entry.reviewStatus,
    }));
    await db
      .update(knowledgeEntriesTable)
      .set({
        reviewStatus: "approved",
        approvedByEmail: "route-test@route-test.invalid",
        approvedAt: new Date(),
        updatedAt: new Date(Date.now() + 2000),
      })
      .where(eq(knowledgeEntriesTable.id, entries[1]!.id));
    const changedStatus = await request("POST", "/knowledge/entries/bulk-delete", {
      entryIds: rows.entryIds,
      snapshots: approvalSnapshots,
      confirm: true,
    });
    assert.equal(changedStatus.status, 409);

    const latest = await db
      .select()
      .from(knowledgeEntriesTable)
      .where(inArray(knowledgeEntriesTable.id, rows.entryIds));
    const deleted = await request("POST", "/knowledge/entries/bulk-delete", {
      entryIds: rows.entryIds,
      snapshots: latest.map((entry) => ({
        id: entry.id,
        updatedAt: entry.updatedAt.toISOString(),
        reviewStatus: entry.reviewStatus,
      })),
      confirm: true,
    });
    assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
    const [document] = await db
      .select({ draftCount: knowledgeSourceDocumentsTable.draftCount })
      .from(knowledgeSourceDocumentsTable)
      .where(eq(knowledgeSourceDocumentsTable.id, documentId));
    assert.equal(document?.draftCount, 0);
  });
});

test("approval and visible PATCH serialize so an approval cannot erase demotion", async () => {
  await withRows(async (rows) => {
    const { entries } = await createTestEntries(rows, ["draft"]);
    const entryId = entries[0]!.id;

    let releaseLock!: () => void;
    let signalLockAcquired!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockAcquired = new Promise<void>((resolve) => {
      signalLockAcquired = resolve;
    });
    const holder = db.transaction(async (tx) => {
      await tx
        .select({ id: knowledgeEntriesTable.id })
        .from(knowledgeEntriesTable)
        .where(eq(knowledgeEntriesTable.id, entryId))
        .for("update");
      signalLockAcquired();
      await lockHeld;
    });
    await lockAcquired;

    // Queue approval first while the row is held. The legacy PATCH path could
    // read "draft" without a lock, then overwrite the approval after release.
    const approval = request("POST", `/knowledge/entries/${entryId}/review`, {
      action: "approve",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const patch = request("PATCH", `/knowledge/entries/${entryId}`, {
      body: `${marker} concurrent visible edit`,
      knowledgeGroup: "customer_shareable",
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseLock();

    const [approvalResult, patchResult] = await Promise.all([approval, patch, holder]);
    assert.equal(approvalResult.status, 200, JSON.stringify(approvalResult.body));
    assert.equal(patchResult.status, 200, JSON.stringify(patchResult.body));

    const [final] = await db
      .select({
        body: knowledgeEntriesTable.body,
        knowledgeGroup: knowledgeEntriesTable.knowledgeGroup,
        reviewStatus: knowledgeEntriesTable.reviewStatus,
      })
      .from(knowledgeEntriesTable)
      .where(eq(knowledgeEntriesTable.id, entryId));
    assert.equal(final?.body, `${marker} concurrent visible edit`);
    assert.equal(final?.knowledgeGroup, "customer_shareable");
    assert.equal(final?.reviewStatus, "draft");
  });
});

test("merge preview reads full entries and commit transfers links into one draft", async () => {
  await withRows(async (rows) => {
    const { entries, documentId } = await createTestEntries(rows, ["approved", "draft"], true);
    assert.ok(documentId);
    await db
      .update(knowledgeEntriesTable)
      .set({
        sourceName: "Manual source",
        sourceUrl: "https://example.invalid/manual",
      })
      .where(eq(knowledgeEntriesTable.id, entries[1]!.id));
    await db
      .update(knowledgeEntriesTable)
      .set({
        sourceName: "Document source",
        sourceUrl: "https://example.invalid/document",
      })
      .where(eq(knowledgeEntriesTable.id, entries[0]!.id));
    await db
      .delete(knowledgeEntrySourcesTable)
      .where(
        and(
          eq(knowledgeEntrySourcesTable.entryId, entries[1]!.id),
          eq(knowledgeEntrySourcesTable.documentId, documentId),
        ),
      );
    const originalCreate = openai.chat.completions.create;
    let prompt = "";
    (openai.chat.completions as any).create = async (requestBody: any) => {
      prompt = String(requestBody.messages?.[1]?.content ?? "");
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                candidate: {
                  title: `${marker} merged draft`,
                  body: `${marker} merged facts and exceptions.`,
                  category: "policy",
                  tags: [marker, "merged"],
                  effectiveDate: null,
                  expiresDate: null,
                },
                conflicts: ["The selected entries have different review statuses."],
              }),
            },
          },
        ],
      };
    };
    try {
      const preview = await request("POST", "/knowledge/entries/merge/preview", {
        entryIds: rows.entryIds,
      });
      assert.equal(preview.status, 200);
      assert.equal(preview.body.entries.length, 2);
      assert.match(prompt, new RegExp(marker));
      assert.match(prompt, new RegExp(entries[0]!.body));
      assert.doesNotMatch(prompt, /route-test@route-test\.invalid/);
      assert.doesNotMatch(
        prompt,
        /approvedByEmail|approvedAt|lastReviewedAt|createdByEmail|updatedByEmail|createdAt|updatedAt|sourceName|sourceUrl|sourceStale/,
      );
      assert.equal(preview.body.conflicts.length, 1);

      const commit = await request("POST", "/knowledge/entries/merge/commit", {
        token: preview.body.token,
        entryIds: rows.entryIds,
        candidate: preview.body.candidate,
      });
      assert.equal(commit.status, 200);
      const mergedId = commit.body.entry.id as string;
      rows.mergedEntryIds.push(mergedId);
      assert.equal(commit.body.entry.reviewStatus, "draft");
      assert.equal(commit.body.entry.approvedAt, null);
      assert.equal(commit.body.sourceLinkCount, 1);
      assert.match(commit.body.entry.sourceName, /Manual source/);
      assert.match(commit.body.entry.sourceName, /URLs:/);
      assert.equal(commit.body.entry.sourceUrl, "");

      const originals = await db
        .select({ id: knowledgeEntriesTable.id })
        .from(knowledgeEntriesTable)
        .where(inArray(knowledgeEntriesTable.id, rows.entryIds));
      assert.equal(originals.length, 0);
      const links = await db
        .select()
        .from(knowledgeEntrySourcesTable)
        .where(eq(knowledgeEntrySourcesTable.entryId, mergedId));
      assert.equal(links.length, 1);
      assert.deepEqual(new Set(links.map((link) => link.documentId)), new Set([documentId]));
      const [document] = await db
        .select({ draftCount: knowledgeSourceDocumentsTable.draftCount })
        .from(knowledgeSourceDocumentsTable)
        .where(eq(knowledgeSourceDocumentsTable.id, documentId));
      assert.equal(document?.draftCount, 1);
    } finally {
      (openai.chat.completions as any).create = originalCreate;
    }
  });
});

test("merge stale token and replay are rejected without partial replacement", async () => {
  await withRows(async (rows) => {
    await createTestEntries(rows, ["draft", "draft"], true);
    const originalCreate = openai.chat.completions.create;
    (openai.chat.completions as any).create = async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidate: {
                title: `${marker} stale candidate`,
                body: `${marker} stale body`,
                category: "policy",
                tags: [marker],
                effectiveDate: null,
                expiresDate: null,
              },
              conflicts: [],
            }),
          },
        },
      ],
    });
    try {
      const preview = await request("POST", "/knowledge/entries/merge/preview", {
        entryIds: rows.entryIds,
      });
      assert.equal(preview.status, 200);
      await db
        .update(knowledgeEntrySourcesTable)
        .set({ stale: "true" })
        .where(eq(knowledgeEntrySourcesTable.entryId, rows.entryIds[0]!));
      const linksBeforeStaleCommit = await db
        .select({ entryId: knowledgeEntrySourcesTable.entryId, stale: knowledgeEntrySourcesTable.stale })
        .from(knowledgeEntrySourcesTable)
        .where(inArray(knowledgeEntrySourcesTable.entryId, rows.entryIds));

      const staleLinkCommit = await request("POST", "/knowledge/entries/merge/commit", {
        token: preview.body.token,
        entryIds: rows.entryIds,
        candidate: preview.body.candidate,
      });
      assert.equal(staleLinkCommit.status, 409);
      const stillThere = await db
        .select({ id: knowledgeEntriesTable.id })
        .from(knowledgeEntriesTable)
        .where(inArray(knowledgeEntriesTable.id, rows.entryIds));
      assert.equal(stillThere.length, 2);
      const linksAfterStaleCommit = await db
        .select({ entryId: knowledgeEntrySourcesTable.entryId, stale: knowledgeEntrySourcesTable.stale })
        .from(knowledgeEntrySourcesTable)
        .where(inArray(knowledgeEntrySourcesTable.entryId, rows.entryIds));
      assert.deepEqual(linksAfterStaleCommit, linksBeforeStaleCommit);

      const freshPreview = await request("POST", "/knowledge/entries/merge/preview", {
        entryIds: rows.entryIds,
      });
      assert.equal(freshPreview.status, 200);
      await db
        .update(knowledgeEntriesTable)
        .set({ body: `${marker} concurrent edit`, updatedAt: new Date(Date.now() + 1000) })
        .where(eq(knowledgeEntriesTable.id, rows.entryIds[0]!));
      const staleEntryCommit = await request("POST", "/knowledge/entries/merge/commit", {
        token: freshPreview.body.token,
        entryIds: rows.entryIds,
        candidate: freshPreview.body.candidate,
      });
      assert.equal(staleEntryCommit.status, 409);
      const freshPreviewAfterEdit = await request("POST", "/knowledge/entries/merge/preview", {
        entryIds: rows.entryIds,
      });
      assert.equal(freshPreviewAfterEdit.status, 200);
      const committed = await request("POST", "/knowledge/entries/merge/commit", {
        token: freshPreviewAfterEdit.body.token,
        entryIds: rows.entryIds,
        candidate: freshPreviewAfterEdit.body.candidate,
      });
      assert.equal(committed.status, 200);
      rows.mergedEntryIds.push(committed.body.entry.id);

      const replay = await request("POST", "/knowledge/entries/merge/commit", {
        token: freshPreviewAfterEdit.body.token,
        entryIds: rows.entryIds,
        candidate: freshPreviewAfterEdit.body.candidate,
      });
      assert.equal(replay.status, 409);
      const merged = await db
        .select({ id: knowledgeEntriesTable.id })
        .from(knowledgeEntriesTable)
        .where(eq(knowledgeEntriesTable.id, committed.body.entry.id));
      assert.equal(merged.length, 1);
    } finally {
      (openai.chat.completions as any).create = originalCreate;
    }
  });
});

test("merge rejects overlong staff-only provenance, then produces an editable bounded draft", async () => {
  await withRows(async (rows) => {
    const { entries } = await createTestEntries(rows, ["draft", "draft"]);
    const originalCreate = openai.chat.completions.create;
    (openai.chat.completions as any).create = async () => ({
      choices: [
        {
          message: {
            content: JSON.stringify({
              candidate: {
                title: `${marker} provenance draft`,
                body: `${marker} body remains AI-visible without staff breadcrumbs.`,
                category: "policy",
                tags: [marker],
                effectiveDate: null,
                expiresDate: null,
              },
              conflicts: [],
            }),
          },
        },
      ],
    });
    try {
      await db
        .update(knowledgeEntriesTable)
        .set({
          sourceName: "Name-".repeat(40),
          sourceUrl: `https://example.invalid/${"url-".repeat(120)}`,
        })
        .where(eq(knowledgeEntriesTable.id, entries[0]!.id));
      await db
        .update(knowledgeEntriesTable)
        .set({
          sourceName: "Other-".repeat(40),
          sourceUrl: `https://other.invalid/${"url-".repeat(120)}`,
        })
        .where(eq(knowledgeEntriesTable.id, entries[1]!.id));

      const preview = await request("POST", "/knowledge/entries/merge/preview", {
        entryIds: rows.entryIds,
      });
      assert.equal(preview.status, 200);
      const rejected = await request("POST", "/knowledge/entries/merge/commit", {
        token: preview.body.token,
        entryIds: rows.entryIds,
        candidate: preview.body.candidate,
      });
      assert.equal(rejected.status, 422);
      assert.equal(rejected.body.code, "merge_provenance_too_large");
      const originalsAfterReject = await db
        .select({ id: knowledgeEntriesTable.id })
        .from(knowledgeEntriesTable)
        .where(inArray(knowledgeEntriesTable.id, rows.entryIds));
      assert.equal(originalsAfterReject.length, 2);

      await db
        .update(knowledgeEntriesTable)
        .set({
          sourceName: "Source A",
          sourceUrl: "https://example.invalid/a",
        })
        .where(eq(knowledgeEntriesTable.id, entries[0]!.id));
      await db
        .update(knowledgeEntriesTable)
        .set({
          sourceName: "Source B",
          sourceUrl: "https://example.invalid/b",
        })
        .where(eq(knowledgeEntriesTable.id, entries[1]!.id));
      const boundedPreview = await request("POST", "/knowledge/entries/merge/preview", {
        entryIds: rows.entryIds,
      });
      assert.equal(boundedPreview.status, 200);
      const committed = await request("POST", "/knowledge/entries/merge/commit", {
        token: boundedPreview.body.token,
        entryIds: rows.entryIds,
        candidate: boundedPreview.body.candidate,
      });
      assert.equal(committed.status, 200, JSON.stringify(committed.body));
      rows.mergedEntryIds.push(committed.body.entry.id);
      assert.ok(committed.body.entry.sourceName.length <= 300);
      assert.equal(committed.body.entry.sourceUrl, "");
      assert.doesNotMatch(committed.body.entry.body, /Source provenance|sourceName=/);

      const edited = await request("PATCH", `/knowledge/entries/${committed.body.entry.id}`, {
        body: `${marker} edited bounded draft`,
      });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.body, `${marker} edited bounded draft`);
    } finally {
      (openai.chat.completions as any).create = originalCreate;
    }
  });
});