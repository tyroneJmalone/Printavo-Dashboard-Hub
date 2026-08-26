export type MailboxCapability = "read" | "search" | "cite" | "manage";

export interface PolicyGrant {
  mailboxId: string;
  subjectId: string;
  capabilities: readonly MailboxCapability[];
  revokedAt?: Date | string | null;
  expiresAt?: Date | string | null;
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  let candidate = value.trim();
  if (!candidate) return null;
  if (candidate.startsWith("<") && candidate.endsWith(">")) {
    candidate = candidate.slice(1, -1).trim();
  }
  if (
    !candidate ||
    /[<>,\s]/.test(candidate) ||
    candidate.split("@").length !== 2
  ) {
    return null;
  }
  const [local, domain] = candidate.split("@");
  if (!local || !domain || !domain.includes(".")) return null;
  return `${local}@${domain.toLowerCase()}`;
}

function activeGrant(
  grant: PolicyGrant,
  actorId: string,
  mailboxId: string,
  capability: MailboxCapability,
  now: Date,
): boolean {
  if (
    grant.subjectId !== actorId ||
    grant.mailboxId !== mailboxId ||
    !grant.capabilities.includes(capability)
  ) {
    return false;
  }
  if (grant.revokedAt) return false;
  if (grant.expiresAt && new Date(grant.expiresAt).getTime() <= now.getTime()) {
    return false;
  }
  return true;
}

export function hasMailboxCapability(input: {
  actor: { id: string };
  mailbox: { id: string; isProtected: boolean };
  capability: MailboxCapability;
  grants: readonly PolicyGrant[];
  now?: Date;
}): boolean {
  const now = input.now ?? new Date();
  return input.grants.some((grant) =>
    activeGrant(grant, input.actor.id, input.mailbox.id, input.capability, now),
  );
}

function filterWithCapabilities<T extends { mailboxId: string }>(
  rows: readonly T[],
  input: {
    actor: { id: string };
    mailboxes: readonly { id: string; isProtected: boolean }[];
    grants: readonly PolicyGrant[];
    now?: Date;
  },
  capabilities: readonly MailboxCapability[],
): T[] {
  const mailboxes = new Map(input.mailboxes.map((mailbox) => [mailbox.id, mailbox]));
  return rows.filter((row) => {
    const mailbox = mailboxes.get(row.mailboxId);
    if (!mailbox) return false;
    return capabilities.every((capability) =>
      hasMailboxCapability({
        actor: input.actor,
        mailbox,
        capability,
        grants: input.grants,
        now: input.now,
      }),
    );
  });
}

export function filterAuthorizedSearchResults<T extends { mailboxId: string }>(
  input: {
    actor: { id: string };
    results: readonly T[];
    mailboxes: readonly { id: string; isProtected: boolean }[];
    grants: readonly PolicyGrant[];
    now?: Date;
  },
): T[] {
  return filterWithCapabilities(input.results, input, ["read", "search"]);
}

export function filterAuthorizedCitationSources<T extends { mailboxId: string }>(
  input: {
    actor: { id: string };
    sources: readonly T[];
    mailboxes: readonly { id: string; isProtected: boolean }[];
    grants: readonly PolicyGrant[];
    now?: Date;
  },
): T[] {
  return filterWithCapabilities(input.sources, input, ["read", "cite"]);
}