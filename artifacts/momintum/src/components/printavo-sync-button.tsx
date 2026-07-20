import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/**
 * Admin-only sidebar button that triggers a manual Printavo task sync cycle
 * via the hub API. Auth rides on the browser session (same as every other
 * API call); the endpoint itself is admin-gated server-side.
 */

interface SyncSummary {
  scanned: number;
  created: number;
  contentUpdated: number;
  listMoved: number;
  completedTwins: number;
  reopenedTwins: number;
  completedInPrintavo: number;
  reopenedInPrintavo: number;
  twinsDeletedFromPrintavoDelete: number;
  errors: string[];
}

function describeSummary(s: SyncSummary): string {
  const parts: string[] = [];
  if (s.created) parts.push(`${s.created} new task${s.created === 1 ? "" : "s"}`);
  const updated = s.contentUpdated + s.listMoved;
  if (updated) parts.push(`${updated} updated`);
  if (s.completedTwins) parts.push(`${s.completedTwins} completed here`);
  if (s.reopenedTwins) parts.push(`${s.reopenedTwins} reopened here`);
  if (s.completedInPrintavo) parts.push(`${s.completedInPrintavo} completed in Printavo`);
  if (s.reopenedInPrintavo) parts.push(`${s.reopenedInPrintavo} reopened in Printavo`);
  if (s.twinsDeletedFromPrintavoDelete) parts.push(`${s.twinsDeletedFromPrintavoDelete} moved to trash`);
  if (parts.length === 0) return `Everything already in sync (${s.scanned} tasks checked).`;
  return parts.join(", ") + ".";
}

export function PrintavoSyncButton() {
  const [syncing, setSyncing] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const runSync = async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await fetch("/api/printavo-tasks/sync-now", { method: "POST" });
      if (res.status === 409) {
        toast({ title: "Sync already running", description: "Give it a few seconds and try again." });
        return;
      }
      if (!res.ok) {
        throw new Error(`Sync failed (${res.status})`);
      }
      const summary = (await res.json()) as SyncSummary;
      // Refresh all task data so any sync changes show up immediately.
      await queryClient.invalidateQueries();
      if (summary.errors.length > 0) {
        toast({
          title: "Sync finished with errors",
          description: `${describeSummary(summary)} ${summary.errors.length} error${summary.errors.length === 1 ? "" : "s"} — check with your admin/agent.`,
          variant: "destructive",
        });
      } else {
        toast({ title: "Printavo sync complete", description: describeSummary(summary) });
      }
    } catch (err) {
      toast({
        title: "Sync failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <button
      onClick={runSync}
      disabled={syncing}
      className={cn(
        "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors w-full",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sidebar-foreground/50",
        syncing && "opacity-70 cursor-wait",
      )}
    >
      <RefreshCw className={cn("w-4 h-4 shrink-0", syncing && "animate-spin")} />
      <span className="truncate">{syncing ? "Syncing with Printavo…" : "Sync Printavo Tasks"}</span>
    </button>
  );
}
