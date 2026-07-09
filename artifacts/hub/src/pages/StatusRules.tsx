import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { StatusSuggestionsCard } from "@/components/purchasing/StatusSuggestionsCard";
import {
  useListStatusRules,
  getListStatusRulesQueryKey,
  useListPrintavoStatuses,
  getListPrintavoStatusesQueryKey,
  useCreateStatusRule,
  useUpdateStatusRule,
  useReorderStatusRules,
  useDeleteStatusRule,
  type StatusRule,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Wand2,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  X,
} from "lucide-react";

type DecoChoice = "mixed" | "print" | "heat" | "embroidery" | "any";
type DueChoice = "none" | "more_than" | "at_most";

const DECO_CHOICE_LABELS: Record<DecoChoice, string> = {
  mixed: "Mixed decoration (2+ types)",
  heat: "Heat press only",
  print: "Screen print only",
  embroidery: "Embroidery only",
  any: "Any order (catch-all)",
};

function ruleWhen(r: StatusRule): string {
  if (r.specialMixedDeco) return DECO_CHOICE_LABELS.mixed;
  if (r.decoGroup) return DECO_CHOICE_LABELS[r.decoGroup as DecoChoice] ?? r.decoGroup;
  return DECO_CHOICE_LABELS.any;
}

function ruleDue(r: StatusRule): string {
  if (!r.dueComparator || r.dueBusinessDays == null) return "any due date";
  return r.dueComparator === "more_than"
    ? `due more than ${r.dueBusinessDays} business day${r.dueBusinessDays === 1 ? "" : "s"} out`
    : `due within ${r.dueBusinessDays} business day${r.dueBusinessDays === 1 ? "" : "s"}`;
}

function apiError(err: unknown): string | undefined {
  return err && typeof err === "object" && "data" in err
    ? (err as { data?: { error?: string } }).data?.error
    : undefined;
}

function RuleEditor({
  rule,
  onClose,
}: {
  rule: StatusRule | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: statusData } = useListPrintavoStatuses({
    query: { queryKey: getListPrintavoStatusesQueryKey() },
  });

  const [deco, setDeco] = useState<DecoChoice>(
    rule
      ? rule.specialMixedDeco
        ? "mixed"
        : ((rule.decoGroup as DecoChoice | null) ?? "any")
      : "any",
  );
  const [due, setDue] = useState<DueChoice>(
    rule?.dueComparator ? (rule.dueComparator as DueChoice) : "none",
  );
  const [days, setDays] = useState(
    rule?.dueBusinessDays != null ? String(rule.dueBusinessDays) : "5",
  );
  const [targetStatusId, setTargetStatusId] = useState(rule?.targetStatusId ?? "");

  const onDone = () => {
    queryClient.invalidateQueries({ queryKey: getListStatusRulesQueryKey() });
    onClose();
  };
  const onFail = (err: unknown) => {
    toast({
      title: "Could not save rule",
      description: apiError(err) ?? "Save failed",
      variant: "destructive",
    });
  };
  const create = useCreateStatusRule({
    mutation: { onSuccess: onDone, onError: onFail },
  });
  const update = useUpdateStatusRule({
    mutation: { onSuccess: onDone, onError: onFail },
  });

  const save = () => {
    if (!targetStatusId) {
      toast({
        title: "Pick a target status",
        description: "The rule needs a Printavo status to move orders into.",
        variant: "destructive",
      });
      return;
    }
    const body = {
      decoGroup: deco === "mixed" || deco === "any" ? null : deco,
      specialMixedDeco: deco === "mixed",
      dueComparator: due === "none" ? null : due,
      dueBusinessDays: due === "none" ? null : Math.max(0, Number(days) || 0),
      targetStatusId,
    };
    if (rule) update.mutate({ id: rule.id, data: body });
    else create.mutate({ data: body });
  };

  const saving = create.isPending || update.isPending;
  const selectCls =
    "bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2.5 py-2 focus:outline-none focus:border-[#059669]";

  return (
    <div className="px-4 py-4 bg-slate-900/70 border-t border-slate-800 flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-[11px] text-slate-400 font-semibold">
        When the order is
        <select
          value={deco}
          onChange={(e) => setDeco(e.target.value as DecoChoice)}
          className={selectCls}
        >
          {(Object.keys(DECO_CHOICE_LABELS) as DecoChoice[]).map((c) => (
            <option key={c} value={c}>
              {DECO_CHOICE_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-slate-400 font-semibold">
        Customer due date
        <select
          value={due}
          onChange={(e) => setDue(e.target.value as DueChoice)}
          className={selectCls}
        >
          <option value="none">Any due date</option>
          <option value="more_than">More than … business days out</option>
          <option value="at_most">Within … business days</option>
        </select>
      </label>
      {due !== "none" && (
        <label className="flex flex-col gap-1 text-[11px] text-slate-400 font-semibold">
          Business days
          <input
            type="number"
            min={0}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            className={`${selectCls} w-24`}
          />
        </label>
      )}
      <label className="flex flex-col gap-1 text-[11px] text-slate-400 font-semibold">
        Move to Printavo status
        <select
          value={targetStatusId}
          onChange={(e) => setTargetStatusId(e.target.value)}
          className={`${selectCls} max-w-[280px]`}
        >
          <option value="">— pick a status —</option>
          {(statusData?.statuses ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2 ml-auto">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-50"
        >
          {saving && <Loader2 size={13} className="animate-spin" />}
          {rule ? "Save changes" : "Add rule"}
        </button>
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
        >
          <X size={13} /> Cancel
        </button>
      </div>
    </div>
  );
}

export default function StatusRules() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListStatusRules({
    query: { queryKey: getListStatusRulesQueryKey() },
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListStatusRulesQueryKey() });

  const reorder = useReorderStatusRules({
    mutation: {
      onSuccess: (updated) => {
        queryClient.setQueryData(getListStatusRulesQueryKey(), updated);
      },
      onError: (err) => {
        invalidate();
        toast({
          title: "Could not reorder rules",
          description: apiError(err) ?? "Reorder failed",
          variant: "destructive",
        });
      },
    },
  });

  const update = useUpdateStatusRule({
    mutation: {
      onSuccess: () => invalidate(),
      onError: (err) => {
        invalidate();
        toast({
          title: "Could not update rule",
          description: apiError(err) ?? "Update failed",
          variant: "destructive",
        });
      },
    },
  });
  const del = useDeleteStatusRule({
    mutation: {
      onSuccess: () => invalidate(),
      onError: (err) => {
        toast({
          title: "Could not delete rule",
          description: apiError(err) ?? "Delete failed",
          variant: "destructive",
        });
      },
    },
  });

  const rules = data?.rules ?? [];

  const move = (index: number, dir: -1 | 1) => {
    if (reorder.isPending) return;
    const next = rules.map((r) => r.id);
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    reorder.mutate({ data: { orderedIds: next } });
  };

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
                <Wand2 className="text-[#10b981]" size={24} />
                Status Rules
              </h1>
              <p className="text-xs text-slate-400 mt-1">
                After a PO push, orders with all blanks ordered get a suggested
                Printavo status — first matching rule wins, top to bottom.
                Suggestions always need your confirmation.
              </p>
            </div>
            <button
              onClick={() => {
                setAdding(true);
                setEditingId(null);
              }}
              className="flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors"
            >
              <Plus size={14} /> Add rule
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar">
          <StatusSuggestionsCard showWhenEmpty />

          <div className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 text-sm font-semibold text-white">
              Rules (checked top to bottom)
            </div>
            {isLoading ? (
              <div className="px-4 py-8 flex justify-center">
                <Loader2 className="animate-spin text-[#10b981]" size={24} />
              </div>
            ) : rules.length === 0 && !adding ? (
              <div className="px-4 py-6 text-xs text-slate-500">
                No rules yet — add one to start getting status suggestions after
                PO pushes.
              </div>
            ) : (
              <div className="divide-y divide-slate-800">
                {rules.map((r, i) => (
                  <div key={r.id}>
                    <div
                      className={`px-4 py-3 flex flex-wrap items-center gap-3 ${r.enabled ? "" : "opacity-50"}`}
                    >
                      <div className="flex flex-col gap-0.5">
                        <button
                          onClick={() => move(i, -1)}
                          disabled={i === 0 || reorder.isPending}
                          className="text-slate-500 hover:text-white disabled:opacity-30 transition-colors"
                          aria-label="Move up"
                        >
                          <ArrowUp size={13} />
                        </button>
                        <button
                          onClick={() => move(i, 1)}
                          disabled={i === rules.length - 1 || reorder.isPending}
                          className="text-slate-500 hover:text-white disabled:opacity-30 transition-colors"
                          aria-label="Move down"
                        >
                          <ArrowDown size={13} />
                        </button>
                      </div>
                      <span className="w-6 text-center font-mono text-xs text-slate-500">
                        {i + 1}
                      </span>
                      <div className="min-w-[220px] flex-1">
                        <div className="text-sm text-slate-200 font-medium">
                          {ruleWhen(r)}
                        </div>
                        <div className="text-[11px] text-slate-500">{ruleDue(r)}</div>
                      </div>
                      <span className="text-xs text-slate-500">→</span>
                      <span className="px-2 py-1 rounded text-[11px] font-semibold bg-[#059669]/10 border border-[#059669]/25 text-[#10b981]">
                        {r.targetStatusName}
                      </span>
                      <div className="flex items-center gap-2 ml-auto">
                        <button
                          onClick={() =>
                            update.mutate({ id: r.id, data: { enabled: !r.enabled } })
                          }
                          disabled={update.isPending}
                          className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 ${
                            r.enabled
                              ? "bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700"
                              : "bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20"
                          }`}
                        >
                          {r.enabled ? "Disable" : "Enable"}
                        </button>
                        <button
                          onClick={() => {
                            setEditingId(editingId === r.id ? null : r.id);
                            setAdding(false);
                          }}
                          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
                        >
                          <Pencil size={13} /> Edit
                        </button>
                        <button
                          onClick={() => {
                            if (
                              window.confirm(
                                `Delete this rule?\n\n${ruleWhen(r)} → ${r.targetStatusName}`,
                              )
                            ) {
                              del.mutate({ id: r.id });
                            }
                          }}
                          disabled={del.isPending}
                          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                    {editingId === r.id && (
                      <RuleEditor rule={r} onClose={() => setEditingId(null)} />
                    )}
                  </div>
                ))}
              </div>
            )}
            {adding && <RuleEditor rule={null} onClose={() => setAdding(false)} />}
          </div>

          <div className="text-[11px] text-slate-500 leading-relaxed max-w-3xl">
            Business days are Mon–Fri excluding shop holidays (New Year's,
            Memorial Day, July 4, Labor Day, Thanksgiving + Eve, Christmas Eve +
            Day, New Year's Eve). The due window counts from the PO push to the
            order's <span className="text-slate-400">customer</span> due date.
            Only screen print, heat press, and embroidery lines determine an
            order's decoration type — contract and fee lines are ignored.
          </div>
        </div>
      </div>
    </AppShell>
  );
}
