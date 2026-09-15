import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq, inArray, like } from "drizzle-orm";
import {
  db,
  knowledgeEntriesTable,
} from "@workspace/db";
import {
  KNOWLEDGE_CLASSIFICATION_SETTINGS_DEFAULT,
  type KnowledgeClassificationSettings,
} from "../src/lib/knowledgeClassification";
import {
  searchBrandVoiceGuidance,
  searchInternalKnowledge,
  searchKnowledge,
} from "../src/lib/contextCore/knowledge";
import {
  findContextTool,
  toolsForCaller,
} from "../src/lib/contextCore/tools";
import { internalCaller } from "../src/lib/contextCore/auth";
import {
  KnowledgePlaygroundError,
  runKnowledgePlayground,
  type PlaygroundChatRequest,
} from "../src/lib/knowledgePlayground";
import {
  searchPlaygroundBrandVoice,
  searchPlaygroundKnowledge,
} from "../src/lib/knowledgePlaygroundSearch";

const marker = `knowledge-classification-integration-${randomUUID()}`;
const entryIds: string[] = [];

function dateOnly(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function editableSettings(rule: string): KnowledgeClassificationSettings {
  return {
    groups: KNOWLEDGE_CLASSIFICATION_SETTINGS_DEFAULT.groups.map((group) => ({
      ...group,
      rules: group.id === "customer_shareable" ? [rule] : [...group.rules],
      categories: [...group.categories],
    })),
    updatedAt: "2099-01-01T00:00:00.000Z",
  };
}

test.after(async () => {
  // Delete by both ids and marker so a failed assertion after an insert still
  // cannot leave temporary entries in the development database.
  await db
    .delete(knowledgeEntriesTable)
    .where(
      entryIds.length
        ? inArray(knowledgeEntriesTable.id, entryIds)
        : like(knowledgeEntriesTable.title, `${marker}%`),
    );
  const leftovers = await db
    .select({ id: knowledgeEntriesTable.id })
    .from(knowledgeEntriesTable)
    .where(like(knowledgeEntriesTable.title, `${marker}%`));
  assert.equal(leftovers.length, 0, "classification integration test left temporary entries");
  await db.$client.end();
});

test("DB-backed context consumers isolate groups, state, live rules, and citations", async () => {
  const now = new Date();
  const rows = await db
    .insert(knowledgeEntriesTable)
    .values([
      {
        title: `${marker} customer approved current`,
        body: `${marker} CUSTOMER_FACT approved current`,
        category: "policy",
        knowledgeGroup: "customer_shareable",
        tags: [marker, "customer"],
        sourceName: `${marker} customer source`,
        sourceUrl: "https://example.invalid/customer-source",
        effectiveDate: dateOnly(-1),
        expiresDate: dateOnly(2),
        reviewStatus: "approved",
        approvedByEmail: "classification-test@invalid",
        approvedAt: now,
        lastReviewedAt: now,
        createdByEmail: "classification-test@invalid",
        updatedByEmail: "classification-test@invalid",
        createdAt: now,
        updatedAt: now,
      },
      {
        title: `${marker} internal approved current`,
        body: `${marker} INTERNAL_SECRET approved current`,
        category: "operations",
        knowledgeGroup: "internal_operational",
        tags: [marker, "internal"],
        sourceName: `${marker} internal source`,
        sourceUrl: "https://example.invalid/internal-source",
        effectiveDate: dateOnly(-1),
        expiresDate: dateOnly(2),
        reviewStatus: "approved",
        approvedByEmail: "classification-test@invalid",
        approvedAt: now,
        lastReviewedAt: now,
        createdByEmail: "classification-test@invalid",
        updatedByEmail: "classification-test@invalid",
        createdAt: now,
        updatedAt: now,
      },
      {
        title: `${marker} brand approved current`,
        body: `${marker} BRAND_TONE guidance only`,
        category: "voice",
        knowledgeGroup: "brand_voice",
        tags: [marker, "brand"],
        sourceName: `${marker} brand source`,
        sourceUrl: "https://example.invalid/brand-source",
        effectiveDate: dateOnly(-1),
        expiresDate: dateOnly(2),
        reviewStatus: "approved",
        approvedByEmail: "classification-test@invalid",
        approvedAt: now,
        lastReviewedAt: now,
        createdByEmail: "classification-test@invalid",
        updatedByEmail: "classification-test@invalid",
        createdAt: now,
        updatedAt: now,
      },
      {
        title: `${marker} customer draft`,
        body: `${marker} DRAFT_MUST_NOT_LEAK`,
        category: "policy",
        knowledgeGroup: "customer_shareable",
        tags: [marker, "draft"],
        effectiveDate: dateOnly(-1),
        expiresDate: dateOnly(2),
        reviewStatus: "draft",
        createdByEmail: "classification-test@invalid",
        updatedByEmail: "classification-test@invalid",
        createdAt: now,
        updatedAt: now,
      },
      {
        title: `${marker} customer expired`,
        body: `${marker} EXPIRED_MUST_NOT_LEAK`,
        category: "policy",
        knowledgeGroup: "customer_shareable",
        tags: [marker, "expired"],
        effectiveDate: dateOnly(-3),
        expiresDate: dateOnly(-1),
        reviewStatus: "approved",
        approvedByEmail: "classification-test@invalid",
        approvedAt: now,
        lastReviewedAt: now,
        createdByEmail: "classification-test@invalid",
        updatedByEmail: "classification-test@invalid",
        createdAt: now,
        updatedAt: now,
      },
      {
        title: `${marker} customer future`,
        body: `${marker} FUTURE_MUST_NOT_LEAK`,
        category: "policy",
        knowledgeGroup: "customer_shareable",
        tags: [marker, "future"],
        effectiveDate: dateOnly(2),
        expiresDate: dateOnly(5),
        reviewStatus: "approved",
        approvedByEmail: "classification-test@invalid",
        approvedAt: now,
        lastReviewedAt: now,
        createdByEmail: "classification-test@invalid",
        updatedByEmail: "classification-test@invalid",
        createdAt: now,
        updatedAt: now,
      },
      {
        title: `${marker} customer archived`,
        body: `${marker} ARCHIVED_MUST_NOT_LEAK`,
        category: "policy",
        knowledgeGroup: "customer_shareable",
        tags: [marker, "archived"],
        effectiveDate: dateOnly(-1),
        expiresDate: dateOnly(2),
        reviewStatus: "archived",
        createdByEmail: "classification-test@invalid",
        updatedByEmail: "classification-test@invalid",
        createdAt: now,
        updatedAt: now,
      },
      {
        title: `${marker} brand draft`,
        body: `${marker} BRAND_DRAFT_TONE`,
        category: "voice",
        knowledgeGroup: "brand_voice",
        tags: [marker, "brand-draft"],
        effectiveDate: dateOnly(-1),
        expiresDate: dateOnly(2),
        reviewStatus: "draft",
        createdByEmail: "classification-test@invalid",
        updatedByEmail: "classification-test@invalid",
        createdAt: now,
        updatedAt: now,
      },
      {
        title: `${marker} brand expired`,
        body: `${marker} BRAND_EXPIRED_MUST_NOT_LEAK`,
        category: "voice",
        knowledgeGroup: "brand_voice",
        tags: [marker, "brand-expired"],
        effectiveDate: dateOnly(-3),
        expiresDate: dateOnly(-1),
        reviewStatus: "approved",
        approvedByEmail: "classification-test@invalid",
        approvedAt: now,
        lastReviewedAt: now,
        createdByEmail: "classification-test@invalid",
        updatedByEmail: "classification-test@invalid",
        createdAt: now,
        updatedAt: now,
      },
    ])
    .returning();
  entryIds.push(...rows.map((row) => row.id));

  const customer = rows.find((row) => row.body.includes("CUSTOMER_FACT"))!;
  const internal = rows.find((row) => row.body.includes("INTERNAL_SECRET"))!;
  const brand = rows.find((row) => row.body.includes("BRAND_TONE"))!;
  const customerDraft = rows.find((row) => row.body.includes("DRAFT_MUST_NOT_LEAK"))!;
  const brandDraft = rows.find((row) => row.body.includes("BRAND_DRAFT_TONE"))!;
  const beforePlaygroundRead = await db
    .select({ id: knowledgeEntriesTable.id, updatedAt: knowledgeEntriesTable.updatedAt })
    .from(knowledgeEntriesTable)
    .where(inArray(knowledgeEntriesTable.id, entryIds));

  const customerResult = await searchKnowledge({ query: marker, limit: 20 });
  assert.deepEqual(customerResult.entries.map((entry) => entry.id), [customer.id]);
  assert.match(customerResult.entries[0]!.body, /CUSTOMER_FACT/);
  assert.doesNotMatch(JSON.stringify(customerResult), /INTERNAL_SECRET|BRAND_TONE|DRAFT_MUST_NOT_LEAK|EXPIRED_MUST_NOT_LEAK|FUTURE_MUST_NOT_LEAK/);
  assert.equal("sourceName" in customerResult.entries[0]!, false);
  assert.equal("sourceUrl" in customerResult.entries[0]!, false);
  assert.equal("knowledgeGroup" in customerResult.entries[0]!, false);

  // Rules are injectable only as a second, internal API argument. The public
  // tool schema cannot select this policy, and no app_settings row is written.
  const liveRule = `temporary live customer rule ${randomUUID()}`;
  const ruled = await searchKnowledge(
    { query: marker, limit: 20 },
    { classificationSettings: editableSettings(liveRule) },
  );
  assert.deepEqual(ruled.rules, [liveRule]);
  assert.equal(ruled.classificationUpdatedAt, "2099-01-01T00:00:00.000Z");

  const internalTool = findContextTool("search_internal_knowledge");
  assert.ok(internalTool, "internal operational tool must be registered");
  const staff = internalCaller("classification-test@invalid", "classification integration");
  const staffResult = await internalTool.handler({ query: marker }, staff);
  assert.deepEqual(
    (staffResult as { entries: Array<{ id: string; knowledgeGroup?: string }> }).entries.map(
      (entry) => entry.id,
    ),
    [internal.id],
  );
  assert.equal(
    (staffResult as { entries: Array<{ knowledgeGroup?: string }> }).entries[0]!.knowledgeGroup,
    "internal_operational",
  );

  const publicCaller = toolsForCaller({
    consumerId: "external-test",
    name: "public external test",
    tier: "external",
    scopes: ["*"],
    rateLimitPerMin: 60,
  });
  assert.equal(
    publicCaller.some((tool) => tool.name === "search_internal_knowledge"),
    false,
    "external consumers cannot discover the staff-only tool",
  );
  assert.equal(
    toolsForCaller(staff).some((tool) => tool.name === "search_internal_knowledge"),
    true,
  );

  const brandResult = await searchBrandVoiceGuidance({ query: "", limit: 50 });
  assert.deepEqual(brandResult.entries.map((entry) => entry.id), [brand.id]);
  assert.match(brandResult.entries[0]!.body, /BRAND_TONE/);
  assert.equal(brandResult.entries[0]!.knowledgeGroup, "brand_voice");

  // The playground's private retriever may opt into current drafts, but it
  // still enforces date/status/group boundaries and never uses internal facts.
  const playgroundApproved = await searchPlaygroundKnowledge({
    query: marker,
    limit: 20,
  });
  assert.deepEqual(playgroundApproved.entries.map((entry) => entry.id), [customer.id]);
  assert.equal(playgroundApproved.entries[0]!.reviewStatus, "approved");

  const playgroundWithDrafts = await searchPlaygroundKnowledge({
    query: marker,
    limit: 20,
    includeDrafts: true,
  });
  assert.equal(
    playgroundWithDrafts.entries.some((entry) => entry.id === customerDraft.id),
    true,
  );
  assert.equal(
    playgroundWithDrafts.entries.find((entry) => entry.id === customerDraft.id)?.reviewStatus,
    "draft",
  );
  assert.doesNotMatch(
    JSON.stringify(playgroundWithDrafts),
    /INTERNAL_SECRET|BRAND_TONE|ARCHIVED_MUST_NOT_LEAK|EXPIRED_MUST_NOT_LEAK|FUTURE_MUST_NOT_LEAK/,
  );

  const brandPlaygroundApproved = await searchPlaygroundBrandVoice({
    query: "",
    limit: 20,
  });
  assert.deepEqual(brandPlaygroundApproved.entries.map((entry) => entry.id), [brand.id]);
  assert.equal(brandPlaygroundApproved.entries[0]!.reviewStatus, "approved");
  const brandPlaygroundWithDrafts = await searchPlaygroundBrandVoice({
    query: "",
    limit: 20,
    includeDrafts: true,
  });
  assert.deepEqual(
    new Set(brandPlaygroundWithDrafts.entries.map((entry) => entry.id)),
    new Set([brand.id, brandDraft.id]),
  );
  assert.equal(
    brandPlaygroundWithDrafts.entries.find((entry) => entry.id === brandDraft.id)?.reviewStatus,
    "draft",
  );
  assert.doesNotMatch(JSON.stringify(brandPlaygroundWithDrafts), /BRAND_EXPIRED_MUST_NOT_LEAK/);
  const afterPlaygroundRead = await db
    .select({ id: knowledgeEntriesTable.id, updatedAt: knowledgeEntriesTable.updatedAt })
    .from(knowledgeEntriesTable)
    .where(inArray(knowledgeEntriesTable.id, entryIds));
  assert.deepEqual(
    new Map(afterPlaygroundRead.map((row) => [row.id, row.updatedAt.toISOString()])),
    new Map(beforePlaygroundRead.map((row) => [row.id, row.updatedAt.toISOString()])),
    "playground retrieval must not write knowledge entries",
  );

  const playgroundRequests: PlaygroundChatRequest[] = [];
  const playground = await runKnowledgePlayground(
    { message: `What is the approved ${marker} fact?` },
    {
      searchKnowledge: ({ query, limit }) => searchKnowledge({ query, limit }),
      getBrandVoiceGuidance: ({ query, limit }) =>
        searchBrandVoiceGuidance({ query, limit }),
      createChatCompletion: async (request) => {
        playgroundRequests.push(request);
        return {
          choices: [
            {
              message: {
                content:
                  playgroundRequests.length === 1
                    ? JSON.stringify({ queries: [marker] })
                    : JSON.stringify({
                        reply: `Approved customer fact. [kb:${customer.id}]`,
                        usedEntryIds: [customer.id],
                      }),
              },
            },
          ],
        };
      },
    },
  );
  assert.deepEqual(playground.usedEntryIds, [customer.id]);
  assert.match(playgroundRequests[1]!.messages[1]!.content, /BRAND_VOICE_GUIDANCE \(tone-only/);
  assert.match(playgroundRequests[1]!.messages[1]!.content, /BRAND_TONE/);
  assert.doesNotMatch(
    playgroundRequests[1]!.messages[1]!.content,
    new RegExp(`\\[kb:${brand.id}\\]`),
  );

  let rejectionCalls = 0;
  await assert.rejects(
    () =>
      runKnowledgePlayground(
        { message: `What is the approved ${marker} fact?` },
        {
          searchKnowledge: ({ query, limit }) => searchKnowledge({ query, limit }),
          getBrandVoiceGuidance: ({ query, limit }) =>
            searchBrandVoiceGuidance({ query, limit }),
          createChatCompletion: async () => {
            rejectionCalls += 1;
            return {
              choices: [
                {
                  message: {
                    content:
                      rejectionCalls === 1
                        ? JSON.stringify({ queries: [marker] })
                        : JSON.stringify({
                            reply: `Brand guidance as fact. [kb:${brand.id}]`,
                            usedEntryIds: [brand.id],
                          }),
                  },
                },
              ],
            };
          },
        },
      ),
    (error: unknown) =>
      error instanceof KnowledgePlaygroundError &&
      error.stage === "grounded_reply" &&
      error.statusCode === 502,
  );

  // The same query is deliberately repeated after changing the temporary
  // entry's group. Knowledge tools have no cache, so this must take effect
  // immediately and cannot leak the fact through a prior customer result.
  await db
    .update(knowledgeEntriesTable)
    .set({ knowledgeGroup: "internal_operational", updatedAt: new Date() })
    .where(eq(knowledgeEntriesTable.id, customer.id));
  const customerAfterGroupEdit = await searchKnowledge({ query: marker, limit: 20 });
  assert.equal(customerAfterGroupEdit.entries.some((entry) => entry.id === customer.id), false);
  const internalAfterGroupEdit = await searchInternalKnowledge({ query: marker, limit: 20 });
  assert.equal(internalAfterGroupEdit.entries.some((entry) => entry.id === customer.id), true);
});