import { randomUUID } from "node:crypto";

export const KNOWLEDGE_MERGE_MIN_ENTRIES = 2;
export const KNOWLEDGE_MERGE_MAX_ENTRIES = 20;
export const KNOWLEDGE_BULK_DELETE_MAX_ENTRIES = 100;
export const KNOWLEDGE_MERGE_TOKEN_TTL_MS = 10 * 60 * 1000;

export type KnowledgeMergeSnapshot = {
  id: string;
  updatedAt: string;
};

export type KnowledgeMergeLinkSnapshot = {
  entryId: string;
  documentId: string;
  sectionKey: string;
  stale: string;
  createdAt: string;
};

type StoredMergeToken = {
  ownerId: string;
  snapshots: KnowledgeMergeSnapshot[];
  links: KnowledgeMergeLinkSnapshot[];
  expiresAt: number;
};

const mergeTokens = new Map<string, StoredMergeToken>();
const MAX_STORED_MERGE_TOKENS = 1_000;

function sameIds(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((id, index) => id === b[index]);
}

function sameLinks(
  left: KnowledgeMergeLinkSnapshot[],
  right: KnowledgeMergeLinkSnapshot[],
): boolean {
  if (left.length !== right.length) return false;
  const key = (link: KnowledgeMergeLinkSnapshot) =>
    `${link.entryId}\u0000${link.documentId}\u0000${link.sectionKey}\u0000${link.stale}\u0000${link.createdAt}`;
  const expected = new Set(left.map(key));
  return right.every((link) => expected.has(key(link)));
}

function removeExpiredMergeTokens(now = Date.now()): void {
  for (const [token, value] of mergeTokens) {
    if (value.expiresAt <= now) mergeTokens.delete(token);
  }
  while (mergeTokens.size > MAX_STORED_MERGE_TOKENS) {
    const oldest = mergeTokens.keys().next().value;
    if (!oldest) break;
    mergeTokens.delete(oldest);
  }
}

/**
 * Issue an opaque, single-use server-side snapshot token. The token never
 * contains client-controlled entry content; commit reads the rows again and
 * compares these versions while holding row locks.
 */
export function issueKnowledgeMergeToken(
  ownerId: string,
  snapshots: KnowledgeMergeSnapshot[],
  links: KnowledgeMergeLinkSnapshot[] = [],
): string {
  removeExpiredMergeTokens();
  const token = randomUUID();
  mergeTokens.set(token, {
    ownerId,
    snapshots: snapshots.map((snapshot) => ({ ...snapshot })),
    links: links.map((link) => ({ ...link })),
    expiresAt: Date.now() + KNOWLEDGE_MERGE_TOKEN_TTL_MS,
  });
  return token;
}

/**
 * Atomically consume a preview token. A consumed token can never be replayed,
 * including after a successful commit response is retried by the browser.
 */
export function takeKnowledgeMergeToken(
  token: string,
  ownerId: string,
  entryIds: string[],
  links?: KnowledgeMergeLinkSnapshot[],
): { snapshots: KnowledgeMergeSnapshot[]; links: KnowledgeMergeLinkSnapshot[] } | null {
  removeExpiredMergeTokens();
  const stored = mergeTokens.get(token);
  if (
    !stored ||
    stored.ownerId !== ownerId ||
    !sameIds(entryIds, stored.snapshots.map((snapshot) => snapshot.id)) ||
    (links !== undefined && !sameLinks(stored.links, links))
  ) {
    return null;
  }
  mergeTokens.delete(token);
  return {
    snapshots: stored.snapshots.map((snapshot) => ({ ...snapshot })),
    links: stored.links.map((link) => ({ ...link })),
  };
}

export function mergeSnapshotsMatch(
  expected: KnowledgeMergeSnapshot[],
  actual: KnowledgeMergeSnapshot[],
): boolean {
  if (!sameIds(expected.map((snapshot) => snapshot.id), actual.map((snapshot) => snapshot.id))) {
    return false;
  }
  const byId = new Map(actual.map((snapshot) => [snapshot.id, snapshot.updatedAt]));
  return expected.every((snapshot) => byId.get(snapshot.id) === snapshot.updatedAt);
}

export function mergeLinksMatch(
  expected: KnowledgeMergeLinkSnapshot[],
  actual: KnowledgeMergeLinkSnapshot[],
): boolean {
  return sameLinks(expected, actual);
}