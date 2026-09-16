import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  useGetAutoPrintConfig,
  getGetAutoPrintConfigQueryKey,
  useUpdateAutoPrintConfig,
  useListAutoPrintPrinters,
  useListImprintCategories,
  useStartAutoPrintRun,
  useGetAutoPrintRun,
  getGetAutoPrintRunQueryKey,
  useListAutoPrintRuns,
  getListAutoPrintRunsQueryKey,
  useListAutoPrintJobs,
  getListAutoPrintJobsQueryKey,
  useListPrintavoStatuses,
  getListPrintavoStatusesQueryKey,
  type AutoPrintConfig,
  type AutoPrintConfigScheduleMode,
  type AutoPrintCategoryMapping,
  type AutoPrintRun,
  type AutoPrintJob,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Bot,
  Loader2,
  Play,
  FlaskConical,
  Plus,
  Trash2,
  ChevronDown,
  AlertTriangle,
  Power,
} from "lucide-react";

function apiError(err: unknown): string | undefined {
  return err && typeof err === "object" && "data" in err
    ? (err as { data?: { error?: string } }).data?.error
    : undefined;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const RUN_STATUS_STYLES: Record<string, string> = {
  running: "bg-sky-500/15 text-sky-300",
  success: "bg-emerald-500/15 text-emerald-300",
  failed: "bg-red-500/15 text-red-300",
  interrupted: "bg-amber-500/15 text-amber-300",
};

const JOB_STATUS_STYLES: Record<string, string> = {
  printed: "bg-emerald-500/15 text-emerald-300",
  dry_run: "bg-sky-500/15 text-sky-300",
  failed: "bg-red-500/15 text-red-300",
  pending: "bg-slate-500/15 text-slate-300",
  skipped: "bg-slate-500/15 text-slate-300",
};

const DAILY_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_DAILY_TIMES = 12;
const DEFAULT_DAILY_TIME = "06:00";

function isDailyTime(value: unknown): value is string {
  return typeof value === "string" && DAILY_TIME_PATTERN.test(value);
}

function hydrateDailyTimes(value: unknown): string[] {
  const times = Array.isArray(value)
    ? value.filter(isDailyTime).slice(0, MAX_DAILY_TIMES)
    : [];
  return times.length > 0 ? times : [DEFAULT_DAILY_TIME];
}

function formatDailyTime(value: string): string {
  if (!isDailyTime(value)) return value;
  const [hours, minutes] = value.split(":").map(Number);
  const hour = hours % 12 || 12;
  return `${hour}:${String(minutes).padStart(2, "0")} ${hours >= 12 ? "PM" : "AM"}`;
}

const DECORATION_GROUP_LABELS = [
  "Screen Printing",
  "Heat Applied Graphics",
  "Embroidery",
  "Mixed Decoration",
] as const;

const DECORATION_GROUP_ALIASES: Record<string, (typeof DECORATION_GROUP_LABELS)[number]> = {
  "screen printing": "Screen Printing",
  "screen print": "Screen Printing",
  screenprinting: "Screen Printing",
  "screen prints": "Screen Printing",
  silkscreen: "Screen Printing",
  "silk screen": "Screen Printing",
  sp: "Screen Printing",
  "heat applied graphics": "Heat Applied Graphics",
  "heat applied graphic": "Heat Applied Graphics",
  "heat applied graphics - personalizations": "Heat Applied Graphics",
  "heat applied graphics - personalization": "Heat Applied Graphics",
  "heat applied": "Heat Applied Graphics",
  "heat press": "Heat Applied Graphics",
  dtf: "Heat Applied Graphics",
  embroidery: "Embroidery",
  "embroidery - personalizations": "Embroidery",
  "embroidery - personalization": "Embroidery",
  "embroidery - set up/digitizing": "Embroidery",
  "embroidery - setup/digitizing": "Embroidery",
  "embroidery - set up": "Embroidery",
  "embroidery - digitizing": "Embroidery",
  emb: "Embroidery",
  "mixed decoration": "Mixed Decoration",
  "mixed decorations": "Mixed Decoration",
};

function decorationGroupLabel(category: string): string | null {
  const normalized = category
    .trim()
    .toLowerCase()
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ");
  return DECORATION_GROUP_ALIASES[normalized] ?? null;
}

/* ── Source status multi-select ──────────────────────────────────────── */

function StatusMultiPicker({
  statuses,
  selected,
  onChange,
  emptyLabel,
  testId,
}: {
  statuses: { id: string; name: string; color?: string | null }[];
  selected: string[];
  onChange: (ids: string[]) => void;
  emptyLabel: string;
  testId: string;
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

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return statuses;
    return statuses.filter((s) => s.name.toLowerCase().includes(q));
  }, [statuses, search]);

  const byId = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setSearch("");
        }}
        className="flex items-center gap-2 bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2.5 py-2 hover:border-slate-500 transition-colors"
        data-testid={`button-${testId}`}
      >
        <span>
          {selected.length === 0
            ? emptyLabel
            : selected.length <= 2
              ? selected.map((id) => byId.get(id)?.name ?? id).join(", ")
              : `${selected.length} statuses`}
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
              data-testid={`input-${testId}-search`}
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
                    onChange={() =>
                      onChange(
                        selected.includes(s.id)
                          ? selected.filter((x) => x !== s.id)
                          : [...selected, s.id],
                      )
                    }
                    className="accent-[#059669]"
                    data-testid={`checkbox-${testId}-${s.id}`}
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
                Clear selection
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Config editor ───────────────────────────────────────────────────── */

function ConfigEditor({ initial }: { initial: AutoPrintConfig }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: statusData } = useListPrintavoStatuses({
    query: { queryKey: getListPrintavoStatusesQueryKey() },
  });
  const statuses = statusData?.statuses ?? [];
  const { data: printerData } = useListAutoPrintPrinters();
  const { data: categoryData } = useListImprintCategories();
  const categories = categoryData?.categories ?? [...DECORATION_GROUP_LABELS];

  const [enabled, setEnabled] = useState(initial.enabled);
  const [dryRun, setDryRun] = useState(initial.dryRun);
  const [scheduleHours, setScheduleHours] = useState(String(initial.scheduleHours));
  const [scheduleMode, setScheduleMode] = useState<AutoPrintConfigScheduleMode>(
    initial.scheduleMode === "daily" ? "daily" : "interval",
  );
  const [dailyTimes, setDailyTimes] = useState<string[]>(
    hydrateDailyTimes(initial.dailyTimes),
  );
  const [copies, setCopies] = useState(String(initial.copies));
  const [sourceStatusIds, setSourceStatusIds] = useState<string[]>(
    initial.sourceStatusIds,
  );
  const [printerId, setPrinterId] = useState(initial.printerId ?? "");
  const [errorStatusId, setErrorStatusId] = useState(initial.errorStatusId ?? "");
  const [mappings, setMappings] = useState<AutoPrintCategoryMapping[]>(
    initial.categoryMappings,
  );
  const [newCategory, setNewCategory] = useState("");
  const [newTarget, setNewTarget] = useState("");

  const printers = printerData?.printers ?? [];
  const printersConfigured = printerData?.configured ?? true;
  const selectedPrinter = printers.find((p) => String(p.id) === printerId);
  const statusName = (id: string) =>
    statuses.find((s) => s.id === id)?.name ?? id;
  const scheduleSummary = useMemo(() => {
    if (scheduleMode === "daily") {
      const times = dailyTimes.filter(isDailyTime).map(formatDailyTime);
      const visibleTimes = times.length > 0 ? times : [formatDailyTime(DEFAULT_DAILY_TIME)];
      return `At ${visibleTimes.join(", ")} Eastern Time, new orders in the source statuses are printed once and moved by decoration category.`;
    }
    return `Every ${scheduleHours || "6"} hours, new orders in the source statuses are printed once and moved by decoration category.`;
  }, [dailyTimes, scheduleHours, scheduleMode]);

  const save = useUpdateAutoPrintConfig({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getGetAutoPrintConfigQueryKey(),
        });
        toast({ title: "Auto-print settings saved" });
      },
      onError: (err: unknown) =>
        toast({
          title: "Could not save settings",
          description: apiError(err) ?? "Save failed",
          variant: "destructive",
        }),
    },
  });

  const doSave = () => {
    const invalidTimeIndex = dailyTimes.findIndex((time) => !isDailyTime(time));
    if (invalidTimeIndex !== -1) {
      toast({
        title: "Invalid daily time",
        description: `Enter a valid time for daily time ${invalidTimeIndex + 1} (HH:mm, for example 06:00).`,
        variant: "destructive",
      });
      return;
    }

    const payload = {
      enabled,
      dryRun,
      scheduleHours: Math.min(24, Math.max(1, Number(scheduleHours) || 6)),
      scheduleMode,
      dailyTimes,
      copies: Math.min(10, Math.max(1, Number(copies) || 1)),
      sourceStatusIds,
      printerId: printerId || null,
      printerName: selectedPrinter?.name ?? (printerId ? initial.printerName : null),
      errorStatusId: errorStatusId || null,
      errorStatusName: errorStatusId ? statusName(errorStatusId) : null,
      categoryMappings: mappings,
    };

    save.mutate({
      data: payload,
    });
  };

  const addMapping = () => {
    const cat = newCategory.trim();
    if (!cat || !newTarget) {
      toast({
        title: "Category and status required",
        description: "Pick a decoration category and the status printed orders move to.",
        variant: "destructive",
      });
      return;
    }
    if (mappings.some((m) => m.category.toLowerCase() === cat.toLowerCase())) {
      toast({ title: "That category is already mapped", variant: "destructive" });
      return;
    }
    setMappings([
      ...mappings,
      { category: cat, statusId: newTarget, statusName: statusName(newTarget) },
    ]);
    setNewCategory("");
    setNewTarget("");
  };

  const updateDailyTime = (index: number, value: string) => {
    setDailyTimes((current) =>
      current.map((time, timeIndex) => (timeIndex === index ? value : time)),
    );
  };

  const addDailyTime = () => {
    setDailyTimes((current) =>
      current.length >= MAX_DAILY_TIMES
        ? current
        : [...current, DEFAULT_DAILY_TIME],
    );
  };

  const removeDailyTime = (index: number) => {
    setDailyTimes((current) =>
      current.length <= 1 ? current : current.filter((_, timeIndex) => timeIndex !== index),
    );
  };

  return (
    <div className="space-y-4">
      {!printersConfigured && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[13px] text-amber-200">
          <AlertTriangle size={15} />
          PrintNode API key is not configured — printing is unavailable.
        </div>
      )}

      <div className="rounded-xl border border-slate-800 bg-[#0f172a] p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
              <Power size={15} className={enabled ? "text-[#059669]" : "text-slate-500"} />
              Scheduled auto-printing
            </h2>
            <p
              className="text-[12px] text-slate-400 mt-0.5"
              data-testid="text-schedule-summary-header"
            >
              {scheduleSummary}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setEnabled((v) => !v)}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              enabled ? "bg-[#059669]" : "bg-slate-700"
            }`}
            data-testid="toggle-autoprint-enabled"
          >
            <span
              className={`absolute left-0 top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                enabled ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-slate-800 bg-[#020617] px-3 py-2.5">
          <div>
            <div className="text-[13px] text-slate-200 flex items-center gap-1.5">
              <FlaskConical size={13} className={dryRun ? "text-sky-400" : "text-slate-500"} />
              Dry-run mode
            </div>
            <div className="text-[11px] text-slate-500">
              Simulate runs — render workorders but never print or move orders.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDryRun((v) => !v)}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              dryRun ? "bg-sky-500" : "bg-slate-700"
            }`}
            data-testid="toggle-autoprint-dryrun"
          >
            <span
              className={`absolute left-0 top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                dryRun ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
        {!dryRun && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-200">
            <AlertTriangle size={13} />
            Live mode — runs will physically print and move orders in Printavo.
          </div>
        )}

        <div className="rounded-lg border border-slate-800 bg-[#020617] p-3 space-y-3">
          <div>
            <span className="text-[11px] uppercase tracking-wide text-slate-500">
              Schedule
            </span>
            <p
              className="text-[12px] text-slate-400 mt-1"
              data-testid="text-schedule-summary"
            >
              {scheduleSummary}
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label
              className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                scheduleMode === "interval"
                  ? "border-[#059669]/60 bg-[#059669]/10"
                  : "border-slate-800 hover:border-slate-700"
              }`}
            >
              <input
                type="radio"
                name="autoprint-schedule-mode"
                value="interval"
                checked={scheduleMode === "interval"}
                onChange={() => setScheduleMode("interval")}
                className="mt-0.5 accent-[#059669]"
                data-testid="input-schedule-mode-interval"
              />
              <span>
                <span className="block text-[13px] text-slate-200">
                  Every N hours
                </span>
                <span className="block text-[11px] text-slate-500 mt-0.5">
                  Run on a repeating interval.
                </span>
              </span>
            </label>
            <label
              className={`flex items-start gap-2 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                scheduleMode === "daily"
                  ? "border-[#059669]/60 bg-[#059669]/10"
                  : "border-slate-800 hover:border-slate-700"
              }`}
            >
              <input
                type="radio"
                name="autoprint-schedule-mode"
                value="daily"
                checked={scheduleMode === "daily"}
                onChange={() => setScheduleMode("daily")}
                className="mt-0.5 accent-[#059669]"
                data-testid="input-schedule-mode-daily"
              />
              <span>
                <span className="block text-[13px] text-slate-200">
                  Specific times (Eastern)
                </span>
                <span className="block text-[11px] text-slate-500 mt-0.5">
                  Run once at each selected time.
                </span>
              </span>
            </label>
          </div>

          {scheduleMode === "interval" ? (
            <label className="block max-w-48">
              <span className="text-[11px] uppercase tracking-wide text-slate-500">
                Every (hours)
              </span>
              <input
                type="number"
                min={1}
                max={24}
                value={scheduleHours}
                onChange={(e) => setScheduleHours(e.target.value)}
                className="mt-1 w-full px-2.5 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-[#059669]"
                data-testid="input-schedule-hours"
              />
            </label>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-[11px] uppercase tracking-wide text-slate-500">
                    Daily times
                  </span>
                  <p
                    className="text-[11px] text-slate-500 mt-0.5"
                    data-testid="text-daily-timezone-note"
                  >
                    Times use Eastern Time and adjust automatically for daylight saving time.
                  </p>
                  <p className="text-[11px] text-slate-500" data-testid="text-daily-missed-note">
                    Missed times are skipped; there is no catch-up run.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={addDailyTime}
                  disabled={dailyTimes.length >= MAX_DAILY_TIMES}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 hover:border-slate-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="button-add-daily-time"
                >
                  <Plus size={13} /> Add time
                </button>
              </div>
              <div className="space-y-1.5">
                {dailyTimes.map((time, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2"
                    data-testid={`row-daily-time-${index}`}
                  >
                    <input
                      type="time"
                      value={time}
                      onChange={(e) => updateDailyTime(index, e.target.value)}
                      className="w-36 px-2.5 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-[#059669]"
                      aria-label={`Daily print time ${index + 1}`}
                      data-testid={`input-daily-time-${index}`}
                    />
                    <button
                      type="button"
                      onClick={() => removeDailyTime(index)}
                      disabled={dailyTimes.length <= 1}
                      className="p-2 text-slate-500 hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      aria-label={`Remove daily print time ${index + 1}`}
                      title={
                        dailyTimes.length <= 1
                          ? "At least one time is required"
                          : "Remove time"
                      }
                      data-testid={`button-remove-daily-time-${index}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-500">
                Add up to {MAX_DAILY_TIMES} daily times.
              </p>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">
              Copies
            </span>
            <input
              type="number"
              min={1}
              max={10}
              value={copies}
              onChange={(e) => setCopies(e.target.value)}
              className="mt-1 w-full px-2.5 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-[#059669]"
              data-testid="input-copies"
            />
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">
              Printer
            </span>
            <select
              value={printerId}
              onChange={(e) => setPrinterId(e.target.value)}
              className="mt-1 w-full px-2.5 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-[#059669]"
              data-testid="select-printer"
            >
              <option value="">— pick a printer —</option>
              {printers.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.name}
                  {p.computerState === "disconnected" ? " (computer offline)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">
              On print failure, move to
            </span>
            <select
              value={errorStatusId}
              onChange={(e) => setErrorStatusId(e.target.value)}
              className="mt-1 w-full px-2.5 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-[#059669]"
              data-testid="select-error-status"
            >
              <option value="">Leave order where it is</option>
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div>
          <span className="text-[11px] uppercase tracking-wide text-slate-500 block mb-1">
            Print orders from these statuses
          </span>
          <StatusMultiPicker
            statuses={statuses}
            selected={sourceStatusIds}
            onChange={setSourceStatusIds}
            emptyLabel="No source statuses — nothing will print"
            testId="autoprint-sources"
          />
        </div>
        {selectedPrinter?.computerState === "disconnected" && (
          <p className="text-[11px] text-amber-300/80">
            The print computer is offline right now — jobs will queue at PrintNode
            and print when it reconnects.
          </p>
        )}
      </div>

      <div className="rounded-xl border border-slate-800 bg-[#0f172a] p-4 space-y-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">
            After successful printing, move orders by decoration
          </h2>
          <p className="text-[12px] text-slate-400 mt-0.5">
            Positive-quantity line-item categories decide the destination after
            the workorder prints successfully. Mixed orders only match Mixed
            Decoration; mixed or unmapped orders stay where they are.
          </p>
        </div>
        {mappings.length > 0 && (
          <div className="space-y-1.5">
            {mappings.map((m) => (
              <div
                key={m.category}
                className="flex items-center gap-2 rounded-lg bg-[#020617] border border-slate-800 px-3 py-2"
                data-testid={`row-mapping-${m.category}`}
              >
                <span className="text-[13px] text-slate-200 font-medium">
                  {m.category}
                </span>
                <span className="text-slate-500 text-[12px]">→</span>
                <span className="text-[13px] text-slate-300 truncate">
                  {m.statusName}
                </span>
                {!decorationGroupLabel(m.category) && (
                  <span
                    className="text-[11px] text-amber-300/80"
                    title="This saved category is not recognized and will not move orders."
                  >
                    unrecognized — stays unchanged
                  </span>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setMappings(mappings.filter((x) => x.category !== m.category))
                  }
                  className="ml-auto text-slate-500 hover:text-red-400 transition-colors"
                  data-testid={`button-delete-mapping-${m.category}`}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-end gap-2">
          <label className="block flex-1 min-w-40">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">
              Decoration category
            </span>
            <input
              list="autoprint-categories"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="e.g. Screen Printing"
              className="mt-1 w-full px-2.5 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-[#059669]"
              data-testid="input-new-mapping-category"
            />
            <datalist id="autoprint-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="block flex-1 min-w-48">
            <span className="text-[11px] uppercase tracking-wide text-slate-500">
              Move to status
            </span>
            <select
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
              className="mt-1 w-full px-2.5 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 focus:outline-none focus:border-[#059669]"
              data-testid="select-new-mapping-target"
            >
              <option value="">— pick a status —</option>
              {statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={addMapping}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 hover:border-slate-500 transition-colors"
            data-testid="button-add-mapping"
          >
            <Plus size={13} /> Add
          </button>
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={doSave}
          disabled={save.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#059669] hover:bg-[#047857] text-white text-[13px] font-medium transition-colors disabled:opacity-60"
          data-testid="button-save-config"
        >
          {save.isPending && <Loader2 size={14} className="animate-spin" />}
          Save settings
        </button>
      </div>
    </div>
  );
}

/* ── Run panel + history ─────────────────────────────────────────────── */

function countsLine(run: AutoPrintRun): string {
  const c = run.counts;
  const bits = [
    `${c.candidates} candidate${c.candidates === 1 ? "" : "s"}`,
    c.printed > 0 ? `${c.printed} printed` : null,
    c.dryRun > 0 ? `${c.dryRun} simulated` : null,
    c.failed > 0 ? `${c.failed} failed` : null,
    c.alreadyPrinted > 0 ? `${c.alreadyPrinted} already printed` : null,
    c.detailPending > 0 ? `${c.detailPending} awaiting detail sync` : null,
    c.deferred > 0 ? `${c.deferred} deferred to next run` : null,
  ].filter(Boolean);
  return bits.join(" · ");
}

function RunPanel() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const wasRunning = useRef(false);

  const start = useStartAutoPrintRun({
    mutation: {
      onSuccess: (run) => {
        setActiveRunId(run.id);
        wasRunning.current = true;
      },
      onError: (err: unknown) =>
        toast({
          title: "Could not start run",
          description: apiError(err) ?? "Run failed to start",
          variant: "destructive",
        }),
    },
  });

  const { data: activeRun } = useGetAutoPrintRun(activeRunId ?? "", {
    query: {
      queryKey: getGetAutoPrintRunQueryKey(activeRunId ?? ""),
      enabled: !!activeRunId,
      refetchInterval: (q) =>
        q.state.data?.status === "running" ? 2000 : false,
    },
  });

  useEffect(() => {
    if (!activeRun) return;
    if (activeRun.status !== "running" && wasRunning.current) {
      wasRunning.current = false;
      queryClient.invalidateQueries({ queryKey: getListAutoPrintRunsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListAutoPrintJobsQueryKey() });
    }
  }, [activeRun, queryClient]);

  const running = activeRun?.status === "running";

  return (
    <div className="rounded-xl border border-slate-800 bg-[#0f172a] p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Run now</h2>
          <p className="text-[12px] text-slate-400 mt-0.5">
            Test run simulates without printing. Print now uses your live settings.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => start.mutate({ data: { dryRun: true } })}
            disabled={start.isPending || running}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 hover:border-slate-500 transition-colors disabled:opacity-60"
            data-testid="button-test-run"
          >
            <FlaskConical size={13} className="text-sky-400" /> Test run (no printing)
          </button>
          <button
            type="button"
            onClick={() => setConfirmLive(true)}
            disabled={start.isPending || running || confirmLive}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#059669] hover:bg-[#047857] text-white text-xs font-medium transition-colors disabled:opacity-60"
            data-testid="button-live-run"
          >
            {running ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Play size={13} />
            )}
            Print now
          </button>
        </div>
      </div>
      {confirmLive && (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5"
          data-testid="panel-confirm-live-run"
        >
          <AlertTriangle size={15} className="text-amber-300 flex-shrink-0" />
          <span className="text-[13px] text-amber-200 flex-1 min-w-48">
            This will physically print workorders and move orders in Printavo.
            Are you sure?
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setConfirmLive(false)}
              className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-xs text-slate-200 hover:border-slate-500 transition-colors"
              data-testid="button-cancel-live-run"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmLive(false);
                start.mutate({ data: { dryRun: false } });
              }}
              disabled={start.isPending || running}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-medium transition-colors disabled:opacity-60"
              data-testid="button-confirm-live-run"
            >
              <Play size={12} /> Yes, print for real
            </button>
          </div>
        </div>
      )}
      {activeRun && (
        <div
          className="rounded-lg bg-[#020617] border border-slate-800 px-3 py-2.5 text-[13px]"
          data-testid="panel-active-run"
        >
          <div className="flex items-center gap-2">
            <span
              className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
                RUN_STATUS_STYLES[activeRun.status] ?? "bg-slate-500/15 text-slate-300"
              }`}
            >
              {activeRun.status}
            </span>
            {activeRun.dryRun && (
              <span className="px-1.5 py-0.5 rounded text-[11px] bg-sky-500/15 text-sky-300">
                dry run
              </span>
            )}
            <span className="text-slate-400 text-[12px]">
              started {fmtTime(activeRun.startedAt)}
            </span>
            {running && <Loader2 size={13} className="animate-spin text-slate-400" />}
          </div>
          <div className="text-slate-300 mt-1.5">{countsLine(activeRun)}</div>
          {activeRun.error && (
            <div className="text-red-300 mt-1">{activeRun.error}</div>
          )}
          {activeRun.advanceSkipped && (
            <div className="text-amber-300 mt-1">{activeRun.advanceSkipped}</div>
          )}
        </div>
      )}
    </div>
  );
}

function HistoryTables() {
  const { data: runData } = useListAutoPrintRuns(
    { limit: 10 },
    {
      query: {
        queryKey: getListAutoPrintRunsQueryKey({ limit: 10 }),
        refetchInterval: 15000,
      },
    },
  );
  const { data: jobData } = useListAutoPrintJobs(
    { limit: 50 },
    {
      query: {
        queryKey: getListAutoPrintJobsQueryKey({ limit: 50 }),
        refetchInterval: 15000,
      },
    },
  );
  const runs = runData?.runs ?? [];
  const jobs = jobData?.jobs ?? [];

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <div className="rounded-xl border border-slate-800 bg-[#0f172a] p-4">
        <h2 className="text-sm font-semibold text-slate-100 mb-3">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="text-[12px] text-slate-500">No runs yet.</p>
        ) : (
          <div className="space-y-1.5">
            {runs.map((r) => (
              <div
                key={r.id}
                className="rounded-lg bg-[#020617] border border-slate-800 px-3 py-2 text-[12px]"
                data-testid={`row-run-${r.id}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
                      RUN_STATUS_STYLES[r.status] ?? "bg-slate-500/15 text-slate-300"
                    }`}
                  >
                    {r.status}
                  </span>
                  {r.dryRun && (
                    <span className="px-1.5 py-0.5 rounded text-[11px] bg-sky-500/15 text-sky-300">
                      dry run
                    </span>
                  )}
                  <span className="text-slate-500">
                    {r.trigger === "scheduled" ? "scheduled" : "manual"}
                  </span>
                  <span className="text-slate-400 ml-auto">
                    {fmtTime(r.startedAt)}
                  </span>
                </div>
                <div className="text-slate-400 mt-1">{countsLine(r)}</div>
                {r.error && <div className="text-red-300 mt-0.5">{r.error}</div>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-slate-800 bg-[#0f172a] p-4">
        <h2 className="text-sm font-semibold text-slate-100 mb-3">
          Printed workorders
        </h2>
        {jobs.length === 0 ? (
          <p className="text-[12px] text-slate-500">Nothing printed yet.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto custom-scrollbar space-y-1.5">
            {jobs.map((j: AutoPrintJob) => (
              <div
                key={j.id}
                className="rounded-lg bg-[#020617] border border-slate-800 px-3 py-2 text-[12px]"
                data-testid={`row-job-${j.id}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-slate-200 font-medium">
                    #{j.visualId ?? "?"}
                  </span>
                  <span className="text-slate-400 truncate flex-1">
                    {j.nickname ?? ""}
                  </span>
                  <span
                    className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
                      JOB_STATUS_STYLES[j.status] ?? "bg-slate-500/15 text-slate-300"
                    }`}
                  >
                    {j.status === "dry_run" ? "simulated" : j.status}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-slate-500 mt-1">
                  <span>{fmtTime(j.printedAt ?? j.createdAt)}</span>
                  {j.targetStatusName && (
                    <span className="truncate">→ {j.targetStatusName}</span>
                  )}
                </div>
                {j.errorMessage && (
                  <div className="text-red-300 mt-0.5">{j.errorMessage}</div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Page ────────────────────────────────────────────────────────────── */

export default function AutoPrint() {
  const { data: config, isLoading } = useGetAutoPrintConfig();

  return (
    <AppShell>
      <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center gap-2.5">
          <Bot size={20} className="text-[#059669]" />
          <div>
            <h1 className="text-lg font-semibold text-slate-100">Auto-Print</h1>
            <p className="text-[12px] text-slate-400">
              Automatically print workorders for new orders and move them to the
              right production status.
            </p>
          </div>
        </div>

        <RunPanel />

        {isLoading || !config ? (
          <div className="flex items-center gap-2 text-slate-400 text-sm py-8 justify-center">
            <Loader2 size={16} className="animate-spin" /> Loading settings…
          </div>
        ) : (
          <ConfigEditor initial={config} />
        )}

        <HistoryTables />
      </div>
    </AppShell>
  );
}
