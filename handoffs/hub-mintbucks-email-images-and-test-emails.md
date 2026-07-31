# Hub Mint Bucks: email images + test emails (ported from standalone update)

**Date:** July 31, 2026

## What was ported
From the standalone Mint Bucks app update (repo snapshot at /tmp/mbm):

1. **Branded email images**
   - `reward_rules.image_object_path` and `credits.image_object_path` (already added to the live shared DB via sanctioned additive `ALTER TABLE ... IF NOT EXISTS`; drizzle schema updated to match — never drizzle-push this DB).
   - Rule dialog and Issue Mint Bucks page upload an image; it renders in:
     - credit **issued** email (credit's own image, or the awarding rule's image for auto-issued credits),
     - **reminder** email (credit image ?? source rule image),
     - **Printavo auto-award notification** email (newest credit image ?? rule image, resolved in the poller).
   - Rules list shows a thumbnail next to the rule name.

2. **Test emails for reward rules**
   - `POST /mintbucks/rewards/test-email` (`sendTestRewardEmail`): sends a sample issued/reminder email with dummy customer data ("Test Customer", code MB-TESTCODE, creditId 0), `[TEST]` subject prefix + banner, redemption links omitted. **No credit is created, nothing written to the DB.**
   - UI: "Send a test email" section in the rule dialog with issue/reminder buttons; sample amount is derived from the rule's reward settings ($25 fallback).

## Architecture notes / traps
- **Storage split (accepted tradeoff):** Hub uploads go to the **Hub's own bucket** (presigned PUT via `POST /mintbucks/storage/uploads/request-url`). Emails sent by the *standalone* app cannot render Hub-uploaded images (they'd point at the standalone bucket and 404). Tyler accepted this.
- **Image serving:** public (no-auth) `GET /api/mintbucks/images/objects/*` on the api-server serves ACL-public objects from the Hub bucket; on miss it 302-redirects to `${MINTBUCKS_APP_URL}/api/storage/objects/...` for standalone-uploaded images. Email `<img src>` uses the Hub's public domain + this route.
- **`MINTBUCKS_APP_URL` is unset in dev** (pre-existing — the QR-code route already 503s without it). Effect here: the standalone-image fallback 404s in dev. Set it in production for full parity.
- **Email safety guard unchanged:** while `MINTBUCKS_EMAIL_MODE !== "live"`, every email (including test emails) is redirected to tyler@mintprintworks.com with a `[TEST→original]` subject.
- **`email_log` was intentionally NOT ported** — the table doesn't exist in the live shared DB and isn't needed for parity.
- New OpenAPI schemas: `MbTestEmailRequest`, `MbUploadUrlRequest` (request-body schemas must end `...Request`, never `...Body` — orval collision). Orval generates `SendTestRewardEmailBody` / `RequestMbUploadUrlBody` / `RequestMbUploadUrlResponse` zod from the operationIds.

## Files touched (high level)
- api-server: `mintbucks/lib/{objectStorage,objectAcl,objectImages,email,rewards,poller}.ts`, `mintbucks/routes/{rewards,credits,storage}.ts`, `routes/mintbucksPublic.ts` (mounted above staff gate).
- hub: `hooks/use-mb-image-upload.ts` (small presign+PUT hook — no Uppy), `components/mintbucks/RuleFormDialog.tsx`, `pages/mintbucks/{Rewards,IssueCredit}.tsx`.
- spec: `lib/api-spec/openapi.yaml` + codegen.
