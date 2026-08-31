/**
 * One-off harness (Task #52): generate voice profiles for every tracked
 * mailbox from real synced sent mail, then exercise getVoiceProfileFact
 * exactly the way the get_voice_profile context tool does.
 *
 * Run via: node test-voice-profiles.mjs
 */
import { db, emailMailboxesTable } from "@workspace/db";
import { generateVoiceProfile, listVoiceProfiles, getVoiceProfileFact } from "../src/lib/voice/profiles";

async function main() {
  const mailboxes = await db.select().from(emailMailboxesTable);
  console.log(`mailboxes: ${mailboxes.map((m) => m.email).join(", ")}`);

  const results = await Promise.allSettled(
    mailboxes.map((m) => generateVoiceProfile(m.id, "harness@task52")),
  );
  results.forEach((r, i) => {
    const email = mailboxes[i]!.email;
    if (r.status === "fulfilled") {
      console.log(`OK ${email}: status=${r.value.status} samples=${r.value.sampleMessageCount}`);
    } else {
      console.log(`FAIL ${email}: ${String(r.reason)}`);
    }
  });

  const all = await listVoiceProfiles();
  for (const row of all) {
    const traits = row.profile?.traits as Record<string, unknown> | null;
    console.log(
      `${row.mailbox.email}: status=${row.profile?.status} traitKeys=${traits ? Object.keys(traits).join(",") : "none"}`,
    );
  }

  console.log("\n--- getVoiceProfileFact('andrew') ---");
  console.log(JSON.stringify(await getVoiceProfileFact("andrew"), null, 2).slice(0, 2500));
  console.log("\n--- getVoiceProfileFact('nobody@example.com') ---");
  console.log(JSON.stringify(await getVoiceProfileFact("nobody@example.com")));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
