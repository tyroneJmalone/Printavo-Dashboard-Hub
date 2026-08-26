/**
 * Task #34 — Missive correspondence authorization contract.
 *
 * These tests intentionally exercise only a future, side-effect-free policy
 * module. They do not start Express, query a database, or call Missive.
 *
 * Expected module: src/lib/missive/accessPolicy.ts
 *
 * Expected exports:
 * - normalizeMessageId(value: string | null | undefined): string | null
 * - hasMailboxCapability(input: {
 *     actor: { id: string };
 *     mailbox: { id: string; isProtected: boolean };
 *     capability: "read" | "search" | "cite" | "manage";
 *     grants: readonly {
 *       mailboxId: string;
 *       subjectId: string;
 *       capabilities: readonly ("read" | "search" | "cite" | "manage")[];
 *       revokedAt?: Date | string | null;
 *       expiresAt?: Date | string | null;
 *     }[];
 *     now?: Date;
 *   }): boolean
 * - filterAuthorizedSearchResults(input: {
 *     actor: { id: string };
 *     results: readonly { mailboxId: string; messageId: string; [key: string]: unknown }[];
 *     mailboxes: readonly { id: string; isProtected: boolean }[];
 *     grants: readonly MailboxGrant[];
 *     now?: Date;
 *   }): result[]
 * - filterAuthorizedCitationSources(input: {
 *     actor: { id: string };
 *     sources: readonly { mailboxId: string; messageId: string; [key: string]: unknown }[];
 *     mailboxes: readonly { id: string; isProtected: boolean }[];
 *     grants: readonly MailboxGrant[];
 *     now?: Date;
 *   }): source[]
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeMessageId,
  hasMailboxCapability,
  filterAuthorizedSearchResults,
  filterAuthorizedCitationSources,
} from "../src/lib/missive/accessPolicy.ts";
import {
  missiveApiUrl,
  retryDelay,
} from "../src/lib/missive/client.ts";

type Capability = "read" | "search" | "cite" | "manage";

const now = new Date("2026-02-20T12:00:00.000Z");
const actor = { id: "user-alice" };
const protectedMailbox = { id: "mailbox-exec", isProtected: true };
const salesMailbox = { id: "mailbox-sales", isProtected: false };

test("Missive API URL validation stays within the resolved /v1 path", () => {
  assert.equal(
    missiveApiUrl("/v1/organizations?limit=2").href,
    "https://public.missiveapp.com/v1/organizations?limit=2",
  );
  for (const path of [
    "/organizations",
    "/v1/../organizations",
    "/v1/%2e%2e/organizations",
    "/v1/%2E%2E/organizations",
    "/v1/..\\organizations",
  ]) {
    assert.throws(() => missiveApiUrl(path), /must stay within/);
  }
});

test("Missive Retry-After supports delta seconds", () => {
  assert.equal(
    retryDelay(new Response(null, { headers: { "Retry-After": "3" } }), 0),
    3_000,
  );
});

test("Missive Retry-After supports HTTP dates", () => {
  const retryAt = new Date(Date.now() + 10_000);
  const delay = retryDelay(
    new Response(null, { headers: { "Retry-After": retryAt.toUTCString() } }),
    0,
  );
  assert.ok(delay >= 8_000 && delay <= 10_000);
});
const mailboxes = [protectedMailbox, salesMailbox];

function grant(
  mailboxId: string,
  capabilities: readonly Capability[],
  extras: Partial<{
    subjectId: string;
    revokedAt: Date | string | null;
    expiresAt: Date | string | null;
  }> = {},
) {
  return {
    mailboxId,
    subjectId: actor.id,
    capabilities,
    ...extras,
  };
}

test("normalizeMessageId: canonicalizes RFC 5322 brackets, whitespace, and domain case", () => {
  assert.equal(
    normalizeMessageId(" \t<CAEP+42@EXAMPLE.COM>\r\n"),
    "CAEP+42@example.com",
  );
  assert.equal(normalizeMessageId("CAEP+42@EXAMPLE.COM"), "CAEP+42@example.com");
});

test("normalizeMessageId: rejects absent, malformed, and multi-ID input instead of guessing", () => {
  for (const input of [
    null,
    undefined,
    "",
    "   ",
    "<>",
    "<missing-domain>",
    "<one@example.com> <two@example.com>",
    "one@example.com,two@example.com",
  ]) {
    assert.equal(normalizeMessageId(input), null, String(input));
  }
});

test("normalizeMessageId: preserves case-sensitive local part and removes only outer syntax", () => {
  assert.equal(
    normalizeMessageId(" <CaseSensitive.Local@Example.COM> "),
    "CaseSensitive.Local@example.com",
  );
});

test("protected mailbox: no grant means no read, search, citation, or management capability", () => {
  for (const capability of ["read", "search", "cite", "manage"] as const) {
    assert.equal(
      hasMailboxCapability({
        actor,
        mailbox: protectedMailbox,
        capability,
        grants: [],
        now,
      }),
      false,
      capability,
    );
  }
});

test("mailbox ACL: capabilities are explicit and do not escalate from another capability", () => {
  const grants = [grant(protectedMailbox.id, ["read"])];

  assert.equal(
    hasMailboxCapability({ actor, mailbox: protectedMailbox, capability: "read", grants, now }),
    true,
  );
  for (const capability of ["search", "cite", "manage"] as const) {
    assert.equal(
      hasMailboxCapability({ actor, mailbox: protectedMailbox, capability, grants, now }),
      false,
      capability,
    );
  }
});

test("mailbox ACL: grants are principal- and mailbox-scoped", () => {
  const grants = [
    grant(protectedMailbox.id, ["read", "search", "cite"]),
    {
      ...grant(salesMailbox.id, ["read", "search", "cite"]),
      subjectId: "user-bob",
    },
  ];

  assert.equal(
    hasMailboxCapability({ actor, mailbox: protectedMailbox, capability: "search", grants, now }),
    true,
  );
  assert.equal(
    hasMailboxCapability({ actor, mailbox: salesMailbox, capability: "search", grants, now }),
    false,
  );
});

test("mailbox ACL: revoked and expired grants fail closed", () => {
  const variants = [
    grant(protectedMailbox.id, ["read", "search", "cite"], { revokedAt: now }),
    grant(protectedMailbox.id, ["read", "search", "cite"], {
      expiresAt: "2026-02-20T11:59:59.999Z",
    }),
  ];

  for (const grants of variants) {
    assert.equal(
      hasMailboxCapability({ actor, mailbox: protectedMailbox, capability: "read", grants: [grants], now }),
      false,
    );
  }
});

test("search authorization: emits only results from mailboxes with both read and search capability", () => {
  const results = [
    { mailboxId: protectedMailbox.id, messageId: "<allowed@corp.example>", snippet: "Board agenda" },
    { mailboxId: salesMailbox.id, messageId: "<sales@corp.example>", snippet: "Customer quote" },
  ];
  const visible = filterAuthorizedSearchResults({
    actor,
    results,
    mailboxes,
    grants: [
      grant(protectedMailbox.id, ["read", "search"]),
      grant(salesMailbox.id, ["read"]),
    ],
    now,
  });

  assert.deepEqual(visible, [results[0]]);
});

test("citation authorization: search access alone cannot disclose a source citation", () => {
  const sources = [
    { mailboxId: protectedMailbox.id, messageId: "<board@corp.example>", quote: "Confidential agenda" },
  ];
  const visible = filterAuthorizedCitationSources({
    actor,
    sources,
    mailboxes,
    grants: [grant(protectedMailbox.id, ["read", "search"])],
    now,
  });

  assert.deepEqual(visible, []);
});

test("citation authorization: requires cite and read, and excludes unknown mailboxes", () => {
  const sources = [
    { mailboxId: protectedMailbox.id, messageId: "<board@corp.example>", quote: "Allowed source" },
    { mailboxId: "mailbox-forged", messageId: "<forged@corp.example>", quote: "Must never leak" },
  ];
  const visible = filterAuthorizedCitationSources({
    actor,
    sources,
    mailboxes,
    grants: [grant(protectedMailbox.id, ["read", "cite"])],
    now,
  });

  assert.deepEqual(visible, [sources[0]]);
});

test("cross-mailbox isolation: a shared Message-ID never grants access to another mailbox", () => {
  const duplicateMessageId = "<copied-message@corp.example>";
  const results = [
    { mailboxId: salesMailbox.id, messageId: duplicateMessageId, snippet: "Permitted copy" },
    { mailboxId: protectedMailbox.id, messageId: duplicateMessageId, snippet: "Executive copy" },
  ];
  const visible = filterAuthorizedSearchResults({
    actor,
    results,
    mailboxes,
    grants: [grant(salesMailbox.id, ["read", "search"])],
    now,
  });

  assert.deepEqual(visible, [results[0]]);
  assert.equal(normalizeMessageId(results[0].messageId), normalizeMessageId(results[1].messageId));
});