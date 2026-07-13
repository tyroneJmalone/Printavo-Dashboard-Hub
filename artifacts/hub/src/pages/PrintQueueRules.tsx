import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  useListPqStatusRules,
  getListPqStatusRulesQueryKey,
  useCreatePqStatusRule,
  useUpdatePqStatusRule,
  useDeletePqStatusRule,
  useReorderPqStatusRules,
  useGetPqAutomation,
  getGetPqAutomationQueryKey,
  useSetPqAutomation,
  useListPrintavoStatuses,
  getListPrintavoStatusesQueryKey,
  type PqStatusRule,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Zap,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  X,
  ChevronDown,
  Power,
} from "lucide-react";

type DecoChoice = "mixed" | "print" | "heat" | "embroidery" | "any";
type DueChoice = "none" | "more_than" | "at_most";
type ModeChoice = "off" | "ask" | "auto";

const NO_CHANGE = "__no_change__";

const DECO_CHOICE_LABELS: Record<DecoChoice, string> = {
  mixed: "Mixed decoration (2+ types)",
  heat: "Heat press only",
  print: "Screen print only",
  embroidery: "Embroidery only",
  any: "Any order (catch-all)",
};

const MODE_LABELS: Record<ModeChoice, string> = {
  off: "Off (paused)",
  ask: "Ask first",
  auto: "Automatic",
};

function ruleWhen(r: PqStatusRule): string {
  if (r.specialMixedDeco) return DECO_CHOICE_LABELS.mixed;
  if (r.decoGroup) return DECO_CHOICE_LABELS[r.decoGroup as DecoChoice] ?? r.decoGroup;
  return DECO_CHOICE_LABELS.any;
}

function ruleDue(r: PqStatusRule): string {
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

/* ── Source status multi-select (empty = any status) ─────────────────── */

function SourceStatusPicker({
  statuses,
  selected,
  onChange,
}: {
  statuses: { id: string; name: string; color?: string | null }[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = (id: string) => {
    onChange(
      selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id],
    );
  };

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return statuses;
    return statuses.filter((s) => s.name.toLowerCase().includes(q));
  }, [statuses, search]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setSearch("");
        }}
        className="flex items-center gap-2 bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2.5 py-2 hover:border-slate-500 transition-colors"
        data-testid="button-source-status-picker"
      >
        <span>
          {selected.length === 0
            ? "Any current status"
            : `${selected.length} status${selected.length === 1 ? "" : "es"}`}
        </span>
        <ChevronDown size={13} className="text-slate-400" />
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-80 rounded-md bg-[#0f172a] border border-slate-700 shadow-xl">
          <div className="p-2 border-b border-slate-800">
            <input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search statuses…"
              className="w-full px-2.5 py-1.5 rounded bg-[#020617] border border-slate-700 text-[13px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-[#059669]"
              data-testid="input-source-status-search"
            />
          </div>
          <div className="max-h-72 overflow-y-auto custom-scrollbar">
            {visible.length === 0 ? (
              <div className="px-3 py-4 text-center text-[12px] text-slate-500">
                No statuses match.
              </div>
            ) : (
              visible.map((s) => (
                <label
                  key={s.id}
                  className="flex items-center gap-2.5 px-3 py-2 text-[13px] text-slate-200 hover:bg-slate-800 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(s.id)}
                    onChange={() => toggle(s.id)}
                    className="accent-[#059669]"
                    data-testid={`checkbox-source-status-${s.id}`}
                  />
                  <span
                    className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ backgroundColor: s.color || "#475569" }}
                  />
                  <span className="truncate">{s.name}</span>
                </label>
              ))
            )}
          </div>
          {selected.length > 0 && (
            <div className="p-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => onChange([])}
                className="text-[11px] text-slate-400 hover:text-slate-200 transition-colors"
              >
                Clear — match any current status
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Rule editor ─────────────────────────────────────────────────────── */

function RuleEditor({
  rule,
  onClose,
}: {
  rule: PqStatusRule | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: statusData } = useListPrintavoStatuses({
    query: { queryKey: getListPrintavoStatusesQueryKey() },
  });
  const statuses = statusData?.statuses ?? [];

  const [name, setName] = useState(rule?.name ?? "");
  const [sourceStatusIds, setSourceStatusIds] = useState<string[]>(
    rule?.sourceStatusIds ?? [],
  );
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
  const [target, setTarget] = useState(
    rule ? (rule.targetStatusId ?? NO_CHANGE) : "",
  );
  const [mode, setMode] = useState<ModeChoice>((rule?.mode as ModeChoice) ?? "ask");

  const onDone = () => {
    queryClient.invalidateQueries({ queryKey: getListPqStatusRulesQueryKey() });
    onClose();
  };
  const onFail = (err: unknown) => {
    toast({
      title: "Could not save rule",
      description: apiError(err) ?? "Save failed",
      variant: "destructive",
    });
  };
  const create = useCreatePqStatusRule({
    mutation: { onSuccess: onDone, onError: onFail },
  });
  const update = useUpdatePqStatusRule({
    mutation: { onSuccess: onDone, onError: onFail },
  });

  const save = () => {
    if (!target) {
      toast({
        title: "Pick a result",
        description:
          "Choose the Printavo status to move matching orders into, or \u201cNo change\u201d to stop lower rules from matching.",
        variant: "destructive",
      });
      return;
    }
    const body = {
      name: name.trim() === "" ? null : name.trim(),
      sourceStatusIds,
      decoGroup: deco === "mixed" || deco === "any" ? null : deco,
      specialMixedDeco: deco === "mixed",
      dueComparator: due === "none" ? null : due,
      dueBusinessDays: due === "none" ? null : Math.max(0, Number(days) || 0),
      targetStatusId: target === NO_CHANGE ? null : target,
      mode,
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
        Rule name (optional)
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Rush prints"
          className={`${selectCls} w-40`}
          data-testid="input-rule-name"
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-slate-400 font-semibold">
        Current status is
        <SourceStatusPicker
          statuses={statuses}
          selected={sourceStatusIds}
          onChange={setSourceStatusIds}
        />
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-slate-400 font-semibold">
        And the order is
        <select
          value={deco}
          onChange={(e) => setDeco(e.target.value as DecoChoice)}
          className={selectCls}
          data-testid="select-deco"
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
          data-testid="select-due"
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
            data-testid="input-due-days"
          />
        </label>
      )}
      <label className="flex flex-col gap-1 text-[11px] text-slate-400 font-semibold">
        Move to
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className={`${selectCls} max-w-[280px]`}
          data-testid="select-target-status"
        >
          <option value="">— pick a result —</option>
          <option value={NO_CHANGE}>No change (stop — keep current status)</option>
          {statuses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-slate-400 font-semibold">
        How it runs
        <select
          value={mode}
          onChange={(e) => setMode(e.target.value as ModeChoice)}
          className={selectCls}
          data-testid="select-mode"
        >
          {(Object.keys(MODE_LABELS) as ModeChoice[]).map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2 ml-auto">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-50"
          data-testid="button-save-rule"
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

/* ── Page ────────────────────────────────────────────────────────────── */

export default function PrintQueueRules() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListPqStatusRules({
    query: { queryKey: getListPqStatusRulesQueryKey() },
  });
  const { data: automation } = useGetPqAutomation({
    query: { queryKey: getGetPqAutomationQueryKey() },
  });
  const { data: statusData } = useListPrintavoStatuses({
    query: { queryKey: getListPrintavoStatusesQueryKey() },
  });
  const statusName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of statusData?.statuses ?? []) m.set(s.id, s.name);
    return m;
  }, [statusData]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListPqStatusRulesQueryKey() });

  const setAutomation = useSetPqAutomation({
    mutation: {
      onSuccess: (updated) => {
        queryClient.setQueryData(getGetPqAutomationQueryKey(), updated);
      },
      onError: (err) => {
        queryClient.invalidateQueries({ queryKey: getGetPqAutomationQueryKey() });
        toast({
          title: "Could not update automation",
          description: apiError(err) ?? "Save failed",
          variant: "destructive",
        });
      },
    },
  });

  const reorder = useReorderPqStatusRules({
    mutation: {
      onSuccess: (updated) => {
        queryClient.setQueryData(getListPqStatusRulesQueryKey(), updated);
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

  const update = useUpdatePqStatusRule({
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
  const del = useDeletePqStatusRule({
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
  const enabled = automation?.enabled ?? false;

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
                <Zap className="text-[#10b981]" size={24} />
                Print Queue Rules
              </h1>
              <p className="text-xs text-slate-400 mt-1">
                After you print workorders, these rules decide which Printavo
                status each printed order moves to — first matching rule wins,
                top to bottom.
              </p>
            </div>
            <button
              onClick={() => {
                setAdding(true);
                setEditingId(null);
              }}
              className="flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors"
              data-testid="button-add-rule"
            >
              <Plus size={14} /> Add rule
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-4 custom-scrollbar">
          {/* Kill switch */}
          <div
            className={`rounded-xl border px-4 py-3 flex items-center gap-3 ${
              enabled
                ? "bg-[#059669]/5 border-[#059669]/30"
                : "bg-slate-900/40 border-slate-800"
            }`}
          >
            <Power size={18} className={enabled ? "text-[#10b981]" : "text-slate-500"} />
            <div className="flex-1">
              <div className="text-sm font-semibold text-white">
                Automation is {enabled ? "ON" : "OFF"}
              </div>
              <div className="text-[11px] text-slate-400">
                {enabled
                  ? "Printing workorders will evaluate these rules — \u201cAsk first\u201d rules show a confirmation, \u201cAutomatic\u201d rules move orders right away."
                  : "Master switch is off — printing never changes statuses, no matter what the rules say. Manual bulk changes on the Print Queue page still work."}
              </div>
            </div>
            <button
              onClick={() => setAutomation.mutate({ data: { enabled: !enabled } })}
              disabled={setAutomation.isPending}
              className={`text-xs font-semibold px-4 py-2 rounded-lg border transition-colors disabled:opacity-50 ${
                enabled
                  ? "bg-red-500/10 border-red-500/25 text-red-400 hover:bg-red-500/20"
                  : "bg-[#059669]/10 border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20"
              }`}
              data-testid="button-toggle-automation"
            >
              {setAutomation.isPending ? (
                <Loader2 size={13} className="animate-spin" />
              ) : enabled ? (
                "Turn off"
              ) : (
                "Turn on"
              )}
            </button>
          </div>

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
                No rules yet — add one to start moving orders after workorders
                print.
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
                          {r.name ? r.name : ruleWhen(r)}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {r.name ? `${ruleWhen(r)} · ` : ""}
                          {ruleDue(r)}
                          {r.sourceStatusIds.length > 0 && (
                            <>
                              {" · from "}
                              {r.sourceStatusIds
                                .map((id) => statusName.get(id) ?? "unknown status")
                                .join(", ")}
                            </>
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-slate-500">→</span>
                      {r.targetStatusId ? (
                        <span className="px-2 py-1 rounded text-[11px] font-semibold bg-[#059669]/10 border border-[#059669]/25 text-[#10b981]">
                          {r.targetStatusName}
                        </span>
                      ) : (
                        <span className="px-2 py-1 rounded text-[11px] font-semibold bg-slate-800 border border-slate-700 text-slate-400">
                          No change
                        </span>
                      )}
                      <span
                        className={`px-2 py-1 rounded text-[11px] font-semibold border ${
                          r.mode === "auto"
                            ? "bg-sky-500/10 border-sky-500/25 text-sky-400"
                            : r.mode === "ask"
                              ? "bg-amber-500/10 border-amber-500/25 text-amber-400"
                              : "bg-slate-800 border-slate-700 text-slate-500"
                        }`}
                        data-testid={`badge-mode-${r.id}`}
                      >
                        {MODE_LABELS[r.mode as ModeChoice] ?? r.mode}
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
                                `Delete this rule?\n\n${r.name ?? ruleWhen(r)} → ${r.targetStatusName ?? "No change"}`,
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
            Rules run when you print workorders from the Print Queue page.
            &ldquo;Current status is&rdquo; left empty matches any status. A{" "}
            <span className="text-slate-400">No change</span> rule stops lower
            rules from touching matching orders. &ldquo;Off (paused)&rdquo; rules
            are skipped entirely. Business days are Mon–Fri excluding shop holidays,
            counted from print time to the order's{" "}
            <span className="text-slate-400">customer</span> due date. Only
            screen print, heat press, and embroidery lines determine an order's
            decoration type.
          </div>
        </div>
      </div>
    </AppShell>
  );
}
