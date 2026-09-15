import assert from "node:assert/strict";
import test from "node:test";
import {
  KnowledgePlaygroundError,
  runKnowledgePlayground,
  type KnowledgePlaygroundDependencies,
  type KnowledgePlaygroundEntry,
  type PlaygroundChatRequest,
} from "../src/lib/knowledgePlayground";

const entryA: KnowledgePlaygroundEntry = {
  id: "entry-a",
  title: "Standard turnaround",
  body: "Standard turnaround is 10 business days after art approval.",
  category: "policy",
  reviewStatus: "approved",
};
const entryB: KnowledgePlaygroundEntry = {
  id: "entry-b",
  title: "Rush service",
  body: "Rush service may be available when confirmed by the production team.",
  category: "production",
  reviewStatus: "approved",
};

function fakeDependencies(
  responses: string[],
  searchResults: KnowledgePlaygroundEntry[][],
): KnowledgePlaygroundDependencies & { requests: PlaygroundChatRequest[]; searches: string[] } {
  const requests: PlaygroundChatRequest[] = [];
  const searches: string[] = [];
  return {
    requests,
    searches,
    createChatCompletion: async (request) => {
      requests.push(request);
      const content = responses.shift();
      if (!content) throw new Error("unexpected model call");
      return { choices: [{ message: { content } }] };
    },
    searchKnowledge: async ({ query }) => {
      searches.push(query);
      return { entries: searchResults.shift() ?? [] };
    },
  };
}

test("extracts keyword queries, deduplicates retrieval, and validates grounded citations", async () => {
  const dependencies = fakeDependencies(
    [
      JSON.stringify({ queries: ["rush turnaround", "rush turnaround", "art approval"] }),
      JSON.stringify({
        reply:
          "Standard turnaround is 10 business days after art approval. [kb:entry-a]",
        usedEntryIds: ["entry-a"],
      }),
    ],
    [
      [entryA, entryB],
      [entryA],
    ],
  );

  const result = await runKnowledgePlayground(
    { message: "Could you tell me whether rush service is available?" },
    dependencies,
  );

  assert.deepEqual(result.searchQueries, ["rush turnaround", "art approval"]);
  assert.deepEqual(result.retrievedEntries, [entryA, entryB]);
  assert.deepEqual(result.usedEntryIds, ["entry-a"]);
  assert.equal(result.includeDrafts, false);
  assert.deepEqual(result.brandGuidance, []);
  assert.match(result.reply, /\[kb:entry-a\]/);
  assert.equal(dependencies.searches.length, 2);
  assert.equal(dependencies.requests.length, 2);
  assert.match(dependencies.requests[1]!.messages[1]!.content, /entry-a/);
  assert.match(dependencies.requests[1]!.messages[1]!.content, /entry-b/);
});

test("returns an explicit no-match reply without a grounded generation call", async () => {
  const dependencies = fakeDependencies(
    [JSON.stringify({ queries: ["unmatched garment question"] })],
    [[]],
  );

  const result = await runKnowledgePlayground(
    { message: "Do you carry a garment that is not in the knowledge base?" },
    dependencies,
  );

  assert.equal(dependencies.requests.length, 1);
  assert.deepEqual(result.retrievedEntries, []);
  assert.deepEqual(result.usedEntryIds, []);
  assert.match(result.reply, /couldn't find an approved knowledge-base entry/i);
  assert.match(result.note, /No customer-facing reply was generated/);
});

test("rejects citations outside the retrieved subset", async () => {
  const dependencies = fakeDependencies(
    [
      JSON.stringify({ queries: ["turnaround"] }),
      JSON.stringify({
        reply: "Turnaround is 10 days. [kb:not-retrieved]",
        usedEntryIds: ["not-retrieved"],
      }),
    ],
    [[entryA]],
  );

  await assert.rejects(
    () =>
      runKnowledgePlayground(
        { message: "How long does a standard order take?" },
        dependencies,
      ),
    (error: unknown) =>
      error instanceof KnowledgePlaygroundError &&
      error.stage === "grounded_reply" &&
      error.statusCode === 502,
  );
});

test("keeps brand guidance separate from customer facts and consumes editable fact rules", async () => {
  const requests: PlaygroundChatRequest[] = [];
  const dependencies: KnowledgePlaygroundDependencies = {
    searchKnowledge: async () => ({
      entries: [entryA],
      rules: ["Preserve approved qualifications exactly."],
      classificationUpdatedAt: "2026-01-01T00:00:00.000Z",
    }),
    getBrandVoiceGuidance: async () => ({
      entries: [
        {
          id: "brand-entry",
          title: "Warm and concise",
          body: "Use a warm, concise greeting. This is tone only, never a fact.",
          category: "voice",
          reviewStatus: "approved",
        },
      ],
      rules: ["Custom live brand rule: keep salutations under five words."],
    }),
    createChatCompletion: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        return { choices: [{ message: { content: JSON.stringify({ queries: ["turnaround"] }) } }] };
      }
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: "Standard turnaround is 10 business days after art approval. [kb:entry-a]",
                usedEntryIds: ["entry-a"],
              }),
            },
          },
        ],
      };
    },
  };

  const result = await runKnowledgePlayground(
    { message: "How long does a standard order take?" },
    dependencies,
  );

  assert.deepEqual(result.usedEntryIds, ["entry-a"]);
  assert.equal(result.includeDrafts, false);
  assert.deepEqual(result.brandGuidance[0]?.reviewStatus, "approved");
  assert.match(requests[1]!.messages[1]!.content, /Preserve approved qualifications exactly/);
  assert.match(requests[1]!.messages[1]!.content, /BRAND_VOICE_GUIDANCE \(tone-only/);
  assert.match(requests[1]!.messages[1]!.content, /Warm and concise/);
  assert.match(
    requests[1]!.messages[1]!.content,
    /Custom live brand rule: keep salutations under five words/,
  );
  assert.match(requests[1]!.messages[1]!.content, /NON_EDITABLE_BRAND_SAFETY_RULES/);
  assert.doesNotMatch(requests[1]!.messages[1]!.content, /brand-entry\]/);
});

test("defaults to approved facts, opts into current drafts, and keeps brand IDs out of citations", async () => {
  const requests: PlaygroundChatRequest[] = [];
  const searches: Array<{ includeDrafts?: boolean; query: string }> = [];
  const dependencies: KnowledgePlaygroundDependencies = {
    searchKnowledge: async ({ query, includeDrafts }) => {
      searches.push({ query, includeDrafts });
      return {
        entries: [
          {
            ...entryA,
            reviewStatus: "approved",
          },
          ...(includeDrafts
            ? [
                {
                  id: "entry-draft",
                  title: "Draft turnaround",
                  body: "Draft turnaround is being reviewed.",
                  category: "policy",
                  reviewStatus: "draft" as const,
                },
              ]
            : []),
        ],
      };
    },
    getBrandVoiceGuidance: async ({ includeDrafts }) => ({
      entries: [
        {
          id: "brand-approved",
          title: "Warm tone",
          body: "Use a warm tone.",
          category: "voice",
          reviewStatus: "approved",
        },
        ...(includeDrafts
          ? [
              {
                id: "brand-draft",
                title: "Draft tone",
                body: "Try a shorter greeting while this is reviewed.",
                category: "voice",
                reviewStatus: "draft" as const,
              },
            ]
          : []),
      ],
    }),
    createChatCompletion: async (request) => {
      requests.push(request);
      if (requests.length % 2 === 1) {
        return { choices: [{ message: { content: JSON.stringify({ queries: ["turnaround"] }) } }] };
      }
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: "The approved turnaround is 10 business days. [kb:entry-a]",
                usedEntryIds: ["entry-a"],
              }),
            },
          },
        ],
      };
    },
  };

  const defaultResult = await runKnowledgePlayground(
    { message: "How long is turnaround?" },
    dependencies,
  );
  assert.equal(defaultResult.includeDrafts, false);
  assert.deepEqual(defaultResult.retrievedEntries.map((entry) => entry.id), ["entry-a"]);
  assert.deepEqual(defaultResult.brandGuidance.map((entry) => entry.id), ["brand-approved"]);
  assert.equal(searches[0]?.includeDrafts, false);

  const draftResult = await runKnowledgePlayground(
    { message: "How long is turnaround?", includeDrafts: true },
    dependencies,
  );
  assert.equal(draftResult.includeDrafts, true);
  assert.deepEqual(
    draftResult.retrievedEntries.map((entry) => [entry.id, entry.reviewStatus]),
    [
      ["entry-a", "approved"],
      ["entry-draft", "draft"],
    ],
  );
  assert.deepEqual(
    draftResult.brandGuidance.map((entry) => [entry.id, entry.reviewStatus]),
    [
      ["brand-approved", "approved"],
      ["brand-draft", "draft"],
    ],
  );
  assert.match(requests[3]!.messages[1]!.content, /approved or draft\/effective/);
  assert.match(requests[3]!.messages[1]!.content, /"reviewStatus":"draft"/);

  let invalidCitationCalls = 0;
  const invalidCitationDependencies: KnowledgePlaygroundDependencies = {
    ...dependencies,
    createChatCompletion: async () => {
      invalidCitationCalls += 1;
      if (invalidCitationCalls === 1) {
        return {
          choices: [
            { message: { content: JSON.stringify({ queries: ["turnaround"] }) } },
          ],
        };
      }
      return {
        choices: [
          {
            message: {
              content: JSON.stringify({
                reply: "Brand guidance is the policy. [kb:brand-draft]",
                usedEntryIds: ["brand-draft"],
              }),
            },
          },
        ],
      };
    },
  };
  await assert.rejects(
    () =>
      runKnowledgePlayground(
        { message: "How long is turnaround?", includeDrafts: true },
        invalidCitationDependencies,
      ),
    (error: unknown) =>
      error instanceof KnowledgePlaygroundError &&
      error.stage === "grounded_reply" &&
      error.statusCode === 502,
  );
});

test("surfaces malformed extraction and retrieval failures", async () => {
  const malformed = fakeDependencies(["not json"], []);
  await assert.rejects(
    () => runKnowledgePlayground({ message: "A valid customer question" }, malformed),
    (error: unknown) =>
      error instanceof KnowledgePlaygroundError &&
      error.stage === "query_extraction" &&
      error.statusCode === 502,
  );

  const failedSearch = fakeDependencies(
    [JSON.stringify({ queries: ["turnaround"] })],
    [],
  );
  failedSearch.searchKnowledge = async () => {
    throw new Error("database unavailable");
  };
  await assert.rejects(
    () => runKnowledgePlayground({ message: "A valid customer question" }, failedSearch),
    (error: unknown) =>
      error instanceof KnowledgePlaygroundError &&
      error.stage === "knowledge_search" &&
      error.statusCode === 503,
  );
});