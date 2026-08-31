/**
 * One-off harness (Task #61): run a small offline drafting backtest against
 * real synced history and print the results. Exercises the exact service
 * the Hub route uses; nothing touches Missive.
 *
 * Run via: NODE_ENV=production node test-draft-backtest.mjs [samplePerMailbox]
 */
import { db, draftBacktestRunsTable, draftBacktestItemsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { startBacktestRun, listBacktestItems } from "../src/lib/draftBacktest/service";

const samplePerMailbox = Number(process.argv[2] ?? 2);

async function main() {
  const result = await startBacktestRun({
    samplePerMailbox,
    requestedByEmail: "harness@task61",
  });
  if ("error" in result) {
    console.log(`REFUSED: ${result.error}`);
    process.exit(1);
  }
  const runId = result.run.id;
  console.log(`run ${runId} started: ${result.run.itemsTotal} items, skipped=[${result.run.skippedMailboxes.join("; ")}]`);

  // The generation loop runs on setImmediate in this process — poll until done.
  for (;;) {
    await new Promise((r) => setTimeout(r, 10_000));
    const [run] = await db
      .select()
      .from(draftBacktestRunsTable)
      .where(eq(draftBacktestRunsTable.id, runId));
    console.log(`  ${run!.status}: ${run!.itemsDone}/${run!.itemsTotal} done, ${run!.itemsFailed} failed`);
    if (run!.status !== "running") break;
  }

  const items = await listBacktestItems(runId);
  for (const { item, mailboxEmail } of items.slice(0, 4)) {
    console.log(`\n=== ${mailboxEmail} | ${item.subject.slice(0, 60)} | ${item.counterpartEmail} | status=${item.status}${item.error ? ` err=${item.error}` : ""}`);
    console.log(`--- customer wrote:\n${item.inboundText.slice(0, 300)}`);
    console.log(`--- real reply:\n${item.replyText.slice(0, 300)}`);
    console.log(`--- VOICE draft:\n${item.voiceDraftBody.slice(0, 400)}`);
    console.log(`--- GENERIC draft:\n${item.genericDraftBody.slice(0, 300)}`);
    console.log(`--- facts: ${item.factsMarkdown.slice(0, 200).replace(/\n/g, " | ")}`);
  }
  const errors = items.filter((i) => i.item.status === "error");
  if (errors.length) {
    console.log(`\nERRORS (${errors.length}):`);
    for (const e of errors) console.log(`  ${e.mailboxEmail}: ${e.item.error}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
