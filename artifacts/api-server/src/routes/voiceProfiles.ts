import { Router, type IRouter } from "express";
import {
  ListVoiceProfilesResponse,
  RefreshVoiceProfileParams,
  RefreshVoiceProfileResponse,
} from "@workspace/api-zod";
import { listVoiceProfiles, kickVoiceProfileRefresh } from "../lib/voice/profiles";
import type { VoiceProfileWithMailbox } from "../lib/voice/profiles";

/**
 * Voice profiles — staff-visible (mounted behind requireStaff). Profiles
 * contain distilled style traits only, never message content, so any staff
 * member may view them and trigger a refresh for any mailbox.
 */
const router: IRouter = Router();

function dto(row: VoiceProfileWithMailbox) {
  const { mailbox, profile } = row;
  return {
    mailboxId: mailbox.id,
    mailboxEmail: mailbox.email,
    mailboxName: mailbox.displayName ?? null,
    status: profile?.status ?? "none",
    traits: (profile?.traits as Record<string, unknown> | null) ?? null,
    sampleMessageCount: profile?.sampleMessageCount ?? 0,
    sampleFrom: profile?.sampleFrom?.toISOString() ?? null,
    sampleTo: profile?.sampleTo?.toISOString() ?? null,
    model: profile?.model ?? null,
    error: profile?.error ?? null,
    generatedAt: profile?.generatedAt?.toISOString() ?? null,
  };
}

router.get("/voice-profiles", async (_req, res): Promise<void> => {
  const rows = await listVoiceProfiles();
  res.json(ListVoiceProfilesResponse.parse(rows.map(dto)));
});

router.post("/voice-profiles/:mailboxId/refresh", async (req, res): Promise<void> => {
  const params = RefreshVoiceProfileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const requestedBy = req.staff?.email ?? null;
  const kicked = kickVoiceProfileRefresh(params.data.mailboxId, requestedBy, req.log);
  res.json(
    RefreshVoiceProfileResponse.parse({
      started: kicked.started,
      reason: kicked.reason ?? null,
    }),
  );
});

export default router;
