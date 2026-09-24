import {
  applyStatusSuggestion,
  dismissStatusSuggestion,
  useListStatusSuggestions,
  getListStatusSuggestionsQueryKey,
  useApplyStatusSuggestion,
  useDismissStatusSuggestion,
  useEvaluateStatusSuggestions,
  type StatusSuggestion,
} from "@workspace/api-client-react";
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import {
  Wand2,
  Loader2,
  ArrowRight,
  Check,
  X,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import {
  createSuggestionInFlightGuard,
  reconcileSuggestionSelection,
  selectedSuggestionIds,
} from "./statusSuggestionSelection";

const DECO_LABELS: Record<string, string> = {
  print: "Print",
  heat: "Heat press",
  embroidery: "Embroidery",
};

function apiError(err: unknown): string | undefined {
  return err && typeof err === "object" && "data" in err
    ? (err as { data?: { error?: string } }).data?.error
    : undefined;
}

function dueLabel(s: StatusSuggestion): string | null {
  if (!s.dueDate) return null;
  const d = new Date(s.dueDate).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC", // date-only value stored at UTC midnight
  });
  return s.businessDaysOut != null
    ? `due ${d} (${s.businessDaysOut} business day${s.businessDaysOut === 1 ? "" : "s"} out)`
    : `due ${d}`;
}

function SuggestionRow({
  s,
  selected,
  onSelectedChange,
  batchError,
  controlsDisabled,
  acquire,
  release,
}: {
  s: StatusSuggestion;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  batchError?: string;
  controlsDisabled: boolean;
  acquire: (id: string) => boolean;
  release: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [individualError, setIndividualError] = useState<string | null>(null);
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListStatusSuggestionsQueryKey() });

  const apply = useApplyStatusSuggestion({
    mutation: {
      onSuccess: (updated) => {
        setIndividualError(null);
        invalidate();
        toast({
          title: `Order ${updated.visualId ? `#${updated.visualId}` : ""} status updated`,
          description: `Printavo status is now "${updated.suggestedStatusName}".`,
        });
      },
      onError: (err) => {
        const message = apiError(err) ?? "Status change failed — you can retry.";
        setIndividualError(message);
        invalidate();
        toast({
          title: "Could not update status in Printavo",
          description: message,
          variant: "destructive",
        });
      },
      onSettled: () => release(s.id),
    },
  });
  const dismiss = useDismissStatusSuggestion({
    mutation: {
      onSuccess: () => invalidate(),
      onError: (err) => {
        const message = apiError(err) ?? "Dismiss failed — you can retry.";
        setIndividualError(message);
        invalidate();
        toast({
          title: "Could not dismiss suggestion",
          description: message,
          variant: "destructive",
        });
      },
      onSettled: () => release(s.id),
    },
  });

  const confirmApply = () => {
    if (
      window.confirm(
        `Change order ${s.visualId ? `#${s.visualId}` : s.orderPrintavoId} in Printavo\n\nfrom: ${s.currentStatusName ?? "(unknown)"}\nto: ${s.suggestedStatusName}\n\nThis updates the REAL order status in Printavo.`,
      )
    ) {
      if (!acquire(s.id)) return;
      apply.mutate({ id: s.id });
    }
  };

  const busy = controlsDisabled || apply.isPending || dismiss.isPending;
  const due = dueLabel(s);

  return (
    <div className="px-4 py-3 flex flex-wrap items-center gap-3">
      <input
        type="checkbox"
        checked={selected}
        onChange={(event) => onSelectedChange(event.target.checked)}
        disabled={controlsDisabled}
        aria-label={`Select status suggestion for order ${s.visualId ?? s.orderPrintavoId}`}
        className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-emerald-500"
      />
      <div className="min-w-[90px] font-mono text-sm">
        <PrintavoOrderLink orderId={s.orderPrintavoId} visualId={s.visualId} />
      </div>
      <div className="min-w-[160px] flex-1">
        <div className="text-sm text-slate-200 truncate">
          {s.nickname ?? s.customerCompany ?? "—"}
        </div>
        <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-2">
          <span>
            {s.mixed
              ? "Mixed decoration"
              : s.decoGroups.map((g) => DECO_LABELS[g] ?? g).join(" + ") || "No deco lines"}
          </span>
          {due && <span>· {due}</span>}
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className="px-2 py-1 rounded bg-slate-800/70 border border-slate-700 text-slate-400">
          {s.currentStatusName ?? "(unknown)"}
        </span>
        <ArrowRight size={13} className="text-slate-500 flex-shrink-0" />
        <span className="px-2 py-1 rounded bg-[#059669]/10 border border-[#059669]/25 text-[#10b981] font-semibold">
          {s.suggestedStatusName}
        </span>
      </div>
      {(s.state === "failed" || batchError || individualError) && (
        <div className="w-full sm:w-auto flex items-center gap-1.5 text-[11px] text-red-400">
          <AlertTriangle size={12} className="flex-shrink-0" />
          <span
            className="truncate max-w-[280px]"
            title={batchError ?? individualError ?? s.error ?? undefined}
          >
            {batchError ?? individualError ?? s.error ?? "Last attempt failed"}
          </span>
        </div>
      )}
      <div className="flex items-center gap-2 ml-auto">
        <button
          onClick={confirmApply}
          disabled={busy}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-50"
        >
          {apply.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Check size={13} />
          )}
          {s.state === "failed" ? "Retry" : "Apply"}
        </button>
        <button
          onClick={() => {
            if (!acquire(s.id)) return;
            dismiss.mutate({ id: s.id });
          }}
          disabled={busy}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
        >
          {dismiss.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <X size={13} />
          )}
          Dismiss
        </button>
      </div>
    </div>
  );
}

/**
 * Pending status-change suggestions produced by the rules engine after a PO
 * push. Nothing touches Printavo until Apply is clicked.
 */
export function StatusSuggestionsCard({
  showWhenEmpty = false,
}: {
  showWhenEmpty?: boolean;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchErrors, setBatchErrors] = useState<Record<string, string>>({});
  const [batchAction, setBatchAction] = useState<"apply" | "dismiss" | null>(null);
  const [inFlightIds, setInFlightIds] = useState<Set<string>>(new Set());
  const inFlightGuard = useRef(createSuggestionInFlightGuard());
  const previousVisibleIds = useRef<string[]>([]);
  const { data, isLoading } = useListStatusSuggestions(undefined, {
    query: {
      queryKey: getListStatusSuggestionsQueryKey(),
      refetchInterval: 15000,
    },
  });

  const evaluate = useEvaluateStatusSuggestions({
    mutation: {
      onSuccess: (summary) => {
        queryClient.invalidateQueries({
          queryKey: getListStatusSuggestionsQueryKey(),
        });
        toast({
          title: "Checked recent orders",
          description: `${summary.checked} order${summary.checked === 1 ? "" : "s"} checked — ${summary.suggested} new suggestion${summary.suggested === 1 ? "" : "s"}.`,
        });
      },
      onError: (err) => {
        toast({
          title: "Could not check orders",
          description: apiError(err) ?? "Evaluation failed",
          variant: "destructive",
        });
      },
    },
  });

  const suggestions = data?.suggestions ?? [];
  const visibleIds = suggestions.map((suggestion) => suggestion.id);
  useEffect(() => {
    const previous = [...previousVisibleIds.current];
    setSelectedIds((selected) =>
      reconcileSuggestionSelection(selected, previous, visibleIds),
    );
    previousVisibleIds.current = visibleIds;
  }, [visibleIds.join("|")]);

  const acquire = (id: string): boolean => {
    if (!inFlightGuard.current.acquire(id)) return false;
    setInFlightIds((ids) => new Set(ids).add(id));
    return true;
  };
  const release = (id: string) => {
    inFlightGuard.current.release(id);
    setInFlightIds((ids) => {
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
  };

  const selectedIdsInView = selectedSuggestionIds(visibleIds, selectedIds);
  const allSelected =
    suggestions.length > 0 && selectedIdsInView.length === suggestions.length;

  const runBatch = async (action: "apply" | "dismiss") => {
    const ids = selectedSuggestionIds(visibleIds, selectedIds);
    if (ids.length === 0) return;
    if (
      action === "apply" &&
      !window.confirm(
        `Apply ${ids.length} selected status change${ids.length === 1 ? "" : "s"} to the REAL orders in Printavo? Unselected suggestions will not be changed.`,
      )
    ) {
      return;
    }
    const acquiredIds = ids.filter((id) => acquire(id));
    if (acquiredIds.length !== ids.length) {
      acquiredIds.forEach(release);
      return;
    }
    setBatchAction(action);
    setBatchErrors((errors) => {
      const next = { ...errors };
      ids.forEach((id) => delete next[id]);
      return next;
    });
    const failures: Record<string, string> = {};
    let succeeded = 0;
    for (const id of acquiredIds) {
      try {
        if (action === "apply") await applyStatusSuggestion(id);
        else await dismissStatusSuggestion(id);
        succeeded += 1;
      } catch (err) {
        failures[id] =
          apiError(err) ??
          (action === "apply"
            ? "Status change failed — you can retry."
            : "Dismiss failed — you can retry.");
      } finally {
        release(id);
      }
    }
    setBatchErrors((errors) => ({ ...errors, ...failures }));
    setBatchAction(null);
    await queryClient.invalidateQueries({
      queryKey: getListStatusSuggestionsQueryKey(),
    });
    toast({
      title:
        action === "apply"
          ? `${succeeded} selected status change${succeeded === 1 ? "" : "s"} applied`
          : `${succeeded} selected suggestion${succeeded === 1 ? "" : "s"} declined`,
      description:
        Object.keys(failures).length > 0
          ? `${Object.keys(failures).length} failed and remain visible to retry.`
          : "Unselected suggestions were left unchanged.",
      variant: Object.keys(failures).length > 0 ? "destructive" : "default",
    });
  };
  if (!showWhenEmpty && suggestions.length === 0) return null;

  return (
    <div className="bg-slate-900/40 border border-[#059669]/25 rounded-xl overflow-hidden">
      <div className="px-4 py-3 flex items-center gap-2 border-b border-slate-800 bg-[#059669]/5">
        <Wand2 size={15} className="text-[#10b981]" />
        <div className="text-sm font-semibold text-white">Status suggestions</div>
        <div className="text-[11px] text-slate-500">
          blanks ordered — suggested Printavo status changes (nothing is applied automatically)
        </div>
        {showWhenEmpty && (
          <button
            onClick={() => evaluate.mutate()}
            disabled={evaluate.isPending}
            className="ml-auto flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            {evaluate.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <RefreshCw size={13} />
            )}
            Check now
          </button>
        )}
      </div>
      {suggestions.length > 0 && (
        <div className="px-4 py-2.5 flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950/30">
          <label className="flex items-center gap-2 text-xs text-slate-300 mr-auto">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(event) =>
                setSelectedIds(event.target.checked ? new Set(visibleIds) : new Set())
              }
              aria-label="Select all status suggestions"
              disabled={batchAction !== null}
              className="h-4 w-4 rounded border-slate-600 bg-slate-900 accent-emerald-500"
            />
            {selectedIdsInView.length} of {suggestions.length} selected
          </label>
          <button
            type="button"
            onClick={() => void runBatch("apply")}
            disabled={
              selectedIdsInView.length === 0 ||
              batchAction !== null ||
              inFlightIds.size > 0
            }
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-50"
          >
            {batchAction === "apply" ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
            Apply selected
          </button>
          <button
            type="button"
            onClick={() => void runBatch("dismiss")}
            disabled={
              selectedIdsInView.length === 0 ||
              batchAction !== null ||
              inFlightIds.size > 0
            }
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            {batchAction === "dismiss" ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
            Decline selected
          </button>
        </div>
      )}
      {isLoading ? (
        <div className="px-4 py-6 flex justify-center">
          <Loader2 className="animate-spin text-[#10b981]" size={20} />
        </div>
      ) : suggestions.length === 0 ? (
        <div className="px-4 py-5 text-xs text-slate-500">
          No pending suggestions. They appear here after a PO push once an
          order's blanks are all ordered — or click Check now.
        </div>
      ) : (
        <div className="divide-y divide-slate-800">
          {suggestions.map((s) => (
            <SuggestionRow
              key={s.id}
              s={s}
              selected={selectedIds.has(s.id)}
              onSelectedChange={(selected) =>
                setSelectedIds((ids) => {
                  const next = new Set(ids);
                  if (selected) next.add(s.id);
                  else next.delete(s.id);
                  return next;
                })
              }
              batchError={batchErrors[s.id]}
              controlsDisabled={batchAction !== null || inFlightIds.has(s.id)}
              acquire={acquire}
              release={release}
            />
          ))}
        </div>
      )}
    </div>
  );
}
