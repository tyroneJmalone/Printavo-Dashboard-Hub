import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "@/lib/current-user";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, MessageSquarePlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";

const BASE = "";

interface FeedbackRow {
  id: number;
  type: string;
  title: string;
  body: string;
  status: string;
  createdAt: string;
  memberName: string | null;
  memberEmail: string | null;
  memberColor: string | null;
}

async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  if (res.status === 204) return null;
  return res.json();
}

const TYPE_META: Record<string, { label: string; emoji: string; color: string }> = {
  bug:     { label: "Bug",     emoji: "🐛", color: "text-red-600 bg-red-50 border-red-200" },
  feature: { label: "Feature", emoji: "✨", color: "text-blue-600 bg-blue-50 border-blue-200" },
  idea:    { label: "Idea",    emoji: "💡", color: "text-yellow-600 bg-yellow-50 border-yellow-200" },
  general: { label: "General", emoji: "💬", color: "text-gray-600 bg-gray-50 border-gray-200" },
};

const STATUS_META: Record<string, { label: string; color: string }> = {
  open:         { label: "Open",         color: "text-orange-600 bg-orange-50 border-orange-200" },
  acknowledged: { label: "Acknowledged", color: "text-blue-600 bg-blue-50 border-blue-200" },
  done:         { label: "Done",         color: "text-green-600 bg-green-50 border-green-200" },
};

export function FeedbackAdmin() {
  const { currentUser } = useCurrentUser();
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: items, isLoading } = useQuery<FeedbackRow[]>({
    queryKey: ["feedback-admin"],
    queryFn: () => apiFetch("/api/momintum/feedback"),
    enabled: !!currentUser?.isAdmin,
    refetchInterval: 60_000,
  });

  const updateStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      apiFetch(`/api/momintum/feedback/${id}`, { method: "PATCH", body: JSON.stringify({ status }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["feedback-admin"] }),
    onError: () => toast({ title: "Error", description: "Could not update status.", variant: "destructive" }),
  });

  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/momintum/feedback/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["feedback-admin"] }),
    onError: () => toast({ title: "Error", description: "Could not delete.", variant: "destructive" }),
  });

  if (!currentUser?.isAdmin) {
    return <div className="p-8 text-center text-muted-foreground">Admin access required.</div>;
  }

  const open = (items ?? []).filter((i) => i.status === "open").length;

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <MessageSquarePlus className="w-6 h-6 text-primary" />
            Team Feedback
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Bugs, ideas, and feature requests from your team.
          </p>
        </div>
        {open > 0 && (
          <Badge className="text-sm px-3 py-1 bg-orange-100 text-orange-700 border-orange-200 border">
            {open} open
          </Badge>
        )}
      </div>

      {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {!isLoading && (items ?? []).length === 0 && (
        <div className="rounded-xl border border-dashed p-12 text-center">
          <MessageSquarePlus className="w-8 h-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-muted-foreground text-sm">No feedback yet. Team members can submit via the button in the app.</p>
        </div>
      )}

      <div className="space-y-3">
        {(items ?? []).map((item) => {
          const tm = TYPE_META[item.type] ?? TYPE_META.general;
          const sm = STATUS_META[item.status] ?? STATUS_META.open;
          return (
            <div key={item.id} className="rounded-xl border bg-card p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${tm.color}`}>
                      {tm.emoji} {tm.label}
                    </span>
                    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${sm.color}`}>
                      {sm.label}
                    </span>
                  </div>
                  <p className="font-semibold text-sm">{item.title}</p>
                  <p className="text-sm text-muted-foreground mt-1 whitespace-pre-wrap">{item.body}</p>
                </div>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => remove.mutate(item.id)}
                  disabled={remove.isPending}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>

              <div className="flex items-center justify-between gap-3 pt-1 border-t">
                <div className="flex items-center gap-2 min-w-0">
                  {item.memberColor && (
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                      style={{ backgroundColor: item.memberColor }}
                    >
                      {(item.memberName ?? "?").slice(0, 1)}
                    </div>
                  )}
                  <span className="text-xs text-muted-foreground truncate">
                    {item.memberName ?? "Unknown"} · {formatDistanceToNow(new Date(item.createdAt), { addSuffix: true })}
                  </span>
                </div>
                <Select
                  value={item.status}
                  onValueChange={(val) => updateStatus.mutate({ id: item.id, status: val })}
                >
                  <SelectTrigger className="h-7 text-xs w-36 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="open">Open</SelectItem>
                    <SelectItem value="acknowledged">Acknowledged</SelectItem>
                    <SelectItem value="done">Done</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
