import { useEffect, useState } from "react";
import {
  useGetSyncStatus,
  getGetSyncStatusQueryKey,
} from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";

function relTime(iso: string, now: number): string {
  const diffMin = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin} min ago`;
  const hrs = Math.floor(diffMin / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/**
 * Compact "last synced with Printavo" indicator — shown in the sidebar and
 * on pages whose data comes from the 5-minute sync.
 */
export function LastSynced({ className = "" }: { className?: string }) {
  const { data } = useGetSyncStatus({
    query: {
      queryKey: getGetSyncStatusQueryKey(),
      refetchInterval: 30_000,
      staleTime: 15_000,
    },
  });

  // Re-render periodically so the relative time stays fresh.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  if (!data) return null;
  const run = data.lastIncremental ?? data.seed;
  if (!run) return null;

  if (run.status === "running") {
    return (
      <div className={`flex items-center gap-1.5 text-[11px] text-sky-400 ${className}`}>
        <Loader2 size={11} className="animate-spin flex-shrink-0" />
        Syncing with Printavo…
      </div>
    );
  }

  if (!run.finishedAt) return null;
  const failed = run.status === "failed";
  return (
    <div
      className={`flex items-center gap-1.5 text-[11px] ${failed ? "text-amber-400" : "text-slate-400"} ${className}`}
      title={`Last Printavo sync ${failed ? "failed" : "finished"} ${new Date(run.finishedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })}`}
    >
      <span
        className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${failed ? "bg-amber-400" : "bg-[#10b981]"}`}
      />
      {failed ? "Printavo sync failed" : "Printavo synced"} {relTime(run.finishedAt, now)}
    </div>
  );
}
