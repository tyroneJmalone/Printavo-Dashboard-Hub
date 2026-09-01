import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  useListReorderRequests,
  useUpdateReorderRequest,
  getListReorderRequestsQueryKey,
  type ReorderRequestRecord,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Inbox, Clock, Mail, Building2, ChevronDown, ChevronUp, CheckCircle2, CircleDot, CircleDashed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";

type StatusKey = "new" | "in_progress" | "done";

const STATUS_META: Record<StatusKey, { label: string; badge: string; icon: typeof CircleDot }> = {
  new: { label: "New", badge: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", icon: CircleDot },
  in_progress: { label: "In progress", badge: "bg-amber-500/10 text-amber-400 border-amber-500/20", icon: CircleDashed },
  done: { label: "Done", badge: "bg-slate-500/10 text-slate-400 border-slate-500/20", icon: CheckCircle2 },
};

const NEXT_ACTION: Record<StatusKey, { to: StatusKey; label: string } | null> = {
  new: { to: "in_progress", label: "Start" },
  in_progress: { to: "done", label: "Mark done" },
  done: null,
};

function RequestCard({ request }: { request: ReorderRequestRecord }) {
  const [expanded, setExpanded] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateReorderRequest();

  const status = (request.status as StatusKey) ?? "new";
  const meta = STATUS_META[status] ?? STATUS_META.new;
  const next = NEXT_ACTION[status];

  const setStatus = (to: StatusKey) => {
    update.mutate(
      { id: request.id, data: { status: to } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListReorderRequestsQueryKey() });
        },
        onError: (error: Error) => {
          toast({ title: "Could not update request", description: error.message, variant: "destructive" });
        },
      },
    );
  };

  return (
    <div className="bg-[#0f172a] border border-slate-800 rounded-xl p-4" data-testid={`card-request-${request.id}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 mb-1.5 flex-wrap">
            <span className="font-mono text-sm font-bold text-emerald-400">
              {request.visualId != null ? `Order #${request.visualId}` : "Order"}
            </span>
            <Badge variant="outline" className={`text-[10px] uppercase font-bold py-0 h-5 border ${meta.badge}`}>
              {meta.label}
            </Badge>
            <span className="text-[10px] text-slate-500 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatDistanceToNow(new Date(request.createdAt), { addSuffix: true })}
            </span>
            {!request.emailSent && (
              <span className="text-[10px] text-amber-500">email not sent</span>
            )}
          </div>
          {request.orderNickname && (
            <p className="text-sm text-slate-300 truncate">{request.orderNickname}</p>
          )}
          <div className="flex items-center gap-4 mt-1.5 text-xs text-slate-400 flex-wrap">
            <span className="font-medium text-slate-300">{request.customerName}</span>
            <span className="flex items-center gap-1">
              <Mail className="w-3 h-3" />
              <a href={`mailto:${request.customerEmail}`} className="hover:text-emerald-400 transition-colors">
                {request.customerEmail}
              </a>
            </span>
            {request.customerCompany && (
              <span className="flex items-center gap-1">
                <Building2 className="w-3 h-3" />
                {request.customerCompany}
              </span>
            )}
            <span className="text-slate-500">{request.totalQty} pieces</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {next && (
            <Button
              size="sm"
              variant="outline"
              disabled={update.isPending}
              onClick={() => setStatus(next.to)}
              className="border-slate-700 text-slate-200"
              data-testid={`button-status-${request.id}`}
            >
              {update.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : next.label}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
            className="text-slate-400"
            data-testid={`button-expand-${request.id}`}
          >
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-4 pt-4 border-t border-slate-800 flex flex-col gap-3">
          {(request.items ?? []).map((item, idx) => (
            <div key={idx} className="bg-slate-950/60 border border-slate-800/60 rounded-lg p-3">
              <div className="text-sm text-slate-200 font-medium">
                {item.description ?? "(no description)"}
              </div>
              <div className="text-xs text-slate-500 mt-0.5">
                {[item.itemNumber, item.color].filter(Boolean).join(" · ")}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {item.sizes.map((s, i) => (
                  <span
                    key={i}
                    className="text-[11px] font-semibold bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 rounded px-2 py-0.5"
                  >
                    {s.label} × {s.qty}
                  </span>
                ))}
              </div>
            </div>
          ))}
          {request.notes && (
            <div className="bg-slate-950/60 border-l-2 border-emerald-500/50 rounded-r-lg p-3 text-sm text-slate-300 whitespace-pre-wrap">
              {request.notes}
            </div>
          )}
          {status === "done" && (
            <div>
              <Button
                size="sm"
                variant="ghost"
                disabled={update.isPending}
                onClick={() => setStatus("new")}
                className="text-slate-500 text-xs"
                data-testid={`button-reopen-${request.id}`}
              >
                Reopen
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ReorderRequests() {
  const [filter, setFilter] = useState<StatusKey | "all">("new");
  const { data, isLoading } = useListReorderRequests({ status: "all" });

  const counts = data?.counts;
  const tabs: Array<{ key: StatusKey | "all"; label: string; count?: number }> = [
    { key: "new", label: "New", count: counts?.new },
    { key: "in_progress", label: "In progress", count: counts?.inProgress },
    { key: "done", label: "Done", count: counts?.done },
    { key: "all", label: "All" },
  ];

  const visible = (data?.requests ?? []).filter(
    (r) => filter === "all" || r.status === filter,
  );

  return (
    <AppShell>
      <div className="max-w-5xl mx-auto p-6 flex flex-col gap-6 h-full">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2 tracking-tight">
            <Inbox className="text-[#10b981]" size={28} />
            Reorder Requests
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Customer reorder requests submitted through the public Reorder Portal. Follow up with a quote, then mark them done.
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => setFilter(t.key)}
              className={`text-xs font-semibold rounded-full px-3.5 py-1.5 border transition-colors ${
                filter === t.key
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                  : "bg-slate-900 text-slate-400 border-slate-800 hover:border-slate-700"
              }`}
              data-testid={`tab-${t.key}`}
            >
              {t.label}
              {typeof t.count === "number" && (
                <span className="ml-1.5 text-[10px] text-slate-500">{t.count}</span>
              )}
            </button>
          ))}
        </div>

        {isLoading ? (
          <div className="py-12 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-slate-500" />
          </div>
        ) : visible.length === 0 ? (
          <div className="bg-[#0f172a]/50 border border-slate-800/50 rounded-xl p-8 text-center flex flex-col items-center">
            <Inbox className="w-10 h-10 text-slate-700 mb-3" />
            <p className="text-slate-400 text-sm">
              {filter === "new" ? "No new reorder requests." : "Nothing here."}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {visible.map((r) => (
              <RequestCard key={r.id} request={r} />
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
