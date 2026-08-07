import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { LastSynced } from "@/components/LastSynced";
import { triggerPoll, getSyncStatus } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw } from "lucide-react";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A forced sync runs 1-3 minutes server-side (throttled Printavo crawl), far
 * longer than proxies keep an HTTP response open, so POST /sync/poll returns
 * "Poll started" immediately and we watch GET /sync/status until the run
 * leaves the "running" state.
 */
async function watchSyncUntilDone(): Promise<{ ok: boolean; error: string | null }> {
  const start = Date.now();
  const deadline = start + 6 * 60_000;
  let runId: number | null = null;
  while (Date.now() < deadline) {
    await sleep(4000);
    try {
      const status = await getSyncStatus();
      const run = status.lastIncremental;
      if (run?.status === "running") {
        runId = run.id;
        continue;
      }
      if (runId !== null && run?.id === runId) {
        return { ok: run.status === "completed", error: run.error ?? null };
      }
      // Never observed it running after 30s: either it finished within our
      // first 4s check, or it never actually started. Trust the run record
      // (allowing a little client/server clock skew) instead of assuming
      // success.
      if (runId === null && Date.now() - start > 30_000) {
        if (run?.finishedAt && new Date(run.startedAt).getTime() >= start - 60_000) {
          return { ok: run.status === "completed", error: run.error ?? null };
        }
        return { ok: false, error: "The sync never started — check the Dashboard sync panel." };
      }
    } catch {
      // Transient status-fetch hiccup — keep watching until the deadline.
    }
  }
  return { ok: false, error: "Timed out waiting for the sync to finish" };
}

/**
 * Global "last synced with Printavo" status + "Sync now" button, shown atop
 * every page (mounted once in AppShell). On completion it invalidates ALL
 * cached queries so whatever page is open refreshes with the new data.
 */
export function PrintavoSyncBar() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  const refreshAll = () => void queryClient.invalidateQueries();

  /**
   * Forced refresh: trigger a Printavo incremental poll (new/changed orders +
   * their line-item details), wait for it to finish, then refresh whatever
   * page data is on screen. Safe to spam — the server no-ops with a message
   * if a sync is already running.
   */
  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await triggerPoll();
      if (!res.ran) {
        // ran:false covers several cases the server reports as 200: another
        // sync busy, seed not done, creds missing, or an actual poll failure.
        const failed = res.message.startsWith("Poll failed");
        refreshAll();
        toast({
          title: failed ? "Printavo sync failed" : "Sync not run",
          description: res.message,
          ...(failed ? { variant: "destructive" as const } : {}),
        });
        return;
      }
      if (res.stats !== null) {
        // Finished within the server's grace window — already done.
        refreshAll();
        toast({ title: "Synced with Printavo", description: res.message });
        return;
      }
      toast({
        title: "Syncing with Printavo",
        description: "Pulling the latest orders — usually takes a minute or two.",
      });
      const outcome = await watchSyncUntilDone();
      refreshAll();
      if (outcome.ok) {
        toast({
          title: "Synced with Printavo",
          description: "Latest Printavo changes pulled — page refreshed.",
        });
      } else {
        toast({
          title: "Printavo sync failed",
          description: outcome.error ?? "Check the Dashboard sync panel.",
          variant: "destructive",
        });
      }
    } catch (err) {
      // Still refresh — the scheduler may have landed data anyway.
      refreshAll();
      toast({
        title: "Printavo sync failed",
        description: err instanceof Error ? err.message : "Check the Dashboard sync panel.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex-shrink-0 flex items-center justify-end gap-3 px-6 py-1.5 bg-[#0f172a]/80 border-b border-slate-800/70">
      <LastSynced />
      <button
        onClick={() => void handleSync()}
        disabled={syncing}
        title="Pull the latest orders from Printavo now"
        className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-md bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-50"
      >
        <RefreshCw size={11} className={syncing ? "animate-spin" : ""} />
        {syncing ? "Syncing with Printavo…" : "Sync now"}
      </button>
    </div>
  );
}
