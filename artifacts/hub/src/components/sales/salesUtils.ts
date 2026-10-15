import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  useSaveSalesRecord,
  useArchiveSalesRecord,
  type SalesSaveRequest,
  type SalesFollowupStatus,
} from "@workspace/api-client-react";

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
export function parseIso(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
export function todayIso(): string {
  return isoDate(new Date());
}
export function addDays(s: string, n: number): string {
  const d = parseIso(s);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}
export function addYears(s: string, n: number): string {
  const d = parseIso(s);
  const month = d.getMonth();
  d.setFullYear(d.getFullYear() + n);
  if (d.getMonth() !== month) d.setDate(0);
  return isoDate(d);
}
export function fmtDay(s: string | null | undefined, precision: "day" | "month" = "day"): string {
  if (!s) return "—";
  const d = parseIso(s);
  return precision === "month"
    ? d.toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export const STATUSES: { value: SalesFollowupStatus; label: string; tone: string }[] = [
  { value: "needs_contact", label: "Needs contact", tone: "border-amber-700/60 bg-amber-950/40 text-amber-300" },
  { value: "contacted", label: "Contacted", tone: "border-sky-700/60 bg-sky-950/40 text-sky-300" },
  { value: "waiting", label: "Waiting", tone: "border-indigo-700/60 bg-indigo-950/40 text-indigo-300" },
  { value: "opportunity", label: "Opportunity", tone: "border-emerald-700/60 bg-emerald-950/40 text-emerald-300" },
  { value: "snoozed", label: "Snoozed", tone: "border-slate-600 bg-slate-800/60 text-slate-300" },
  { value: "dismissed", label: "Dismissed", tone: "border-slate-700 bg-slate-900 text-slate-500" },
  { value: "completed", label: "Completed", tone: "border-teal-700/60 bg-teal-950/40 text-teal-300" },
];
export const statusMeta = (s: string) => STATUSES.find((x) => x.value === s) ?? STATUSES[0];
export const OPEN_STATUSES = new Set(["needs_contact", "contacted", "waiting", "opportunity", "snoozed"]);

export function errorInfo(err: unknown): { conflict: boolean; message: string } {
  const e = err as { status?: number; data?: { error?: string; message?: string } | string | null; message?: string };
  const server = typeof e?.data === "string" ? e.data : e?.data?.error ?? e?.data?.message;
  const text = server ?? e?.message ?? "Something went wrong";
  if (e?.status === 409)
    return {
      conflict: true,
      message: `${text} — If this record was changed elsewhere, close this window and reopen it after the data reloads before trying again.`,
    };
  return { conflict: false, message: text };
}

/** Next annual occurrence on/after `from` for a YYYY-MM-DD start date (Feb 29 clamps to Feb 28). */
export function nextAnnual(start: string, from: string, precision: "day" | "month" = "day"): string {
  const [, m, d] = start.split("-").map(Number);
  const fy = Number(from.slice(0, 4));
  const build = (y: number) => {
    if (precision === "month") return `${y}-${String(m).padStart(2, "0")}-01`;
    const last = new Date(y, m, 0).getDate();
    return `${y}-${String(m).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
  };
  const cmpFrom = precision === "month" ? from.slice(0, 7) + "-01" : from;
  const thisYear = build(fy);
  return thisYear >= cmpFrom ? thisYear : build(fy + 1);
}

export function useSalesInvalidate() {
  const qc = useQueryClient();
  return () =>
    qc.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/customers/sales"),
    });
}

/** Save/archive helpers: invalidate on success, reload + explain on 409, never auto-retry. */
export function useSalesActions() {
  const { toast } = useToast();
  const invalidate = useSalesInvalidate();
  const saveM = useSaveSalesRecord();
  const archiveM = useArchiveSalesRecord();

  const fail = (title: string, err: unknown) => {
    const info = errorInfo(err);
    if (info.conflict) invalidate();
    toast({ title, description: info.message, variant: "destructive" });
  };

  const save = async (data: SalesSaveRequest, successTitle?: string): Promise<string | null> => {
    try {
      const r = await saveM.mutateAsync({ data });
      invalidate();
      if (successTitle) toast({ title: successTitle });
      return r.id;
    } catch (err) {
      fail("Save failed", err);
      return null;
    }
  };
  /** Raw save that throws — used by sequential batches that report per-row results. */
  const saveRaw = async (data: SalesSaveRequest) => (await saveM.mutateAsync({ data })).id;

  const archive = async (id: string, version: number, successTitle?: string): Promise<boolean> => {
    try {
      await archiveM.mutateAsync({ data: { id, version } });
      invalidate();
      if (successTitle) toast({ title: successTitle });
      return true;
    } catch (err) {
      fail("Archive failed", err);
      return false;
    }
  };
  return { save, saveRaw, archive, invalidate, busy: saveM.isPending || archiveM.isPending };
}
