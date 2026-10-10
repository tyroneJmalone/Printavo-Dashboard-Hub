import type { KnowledgeGroup } from "@workspace/api-client-react";

export const LIBRARY_PAGE_SIZE = 30;
export const LIBRARY_REFRESH_MS = 30_000;

const GROUP_META: Record<string, { label: string; note: string; cls: string }> = {
  customer_shareable: {
    label: "Customer-shareable",
    note: "Approved for use with customers.",
    cls: "bg-[#059669]/15 text-[#10b981] border-[#059669]/30",
  },
  internal_operational: {
    label: "Internal only",
    note: "Internal operational content. Do not share with customers.",
    cls: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  },
  brand_voice: {
    label: "Brand voice",
    note: "Brand voice and style guidance for staff. Not a customer-facing document.",
    cls: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  },
};

export function groupMeta(group: KnowledgeGroup | string | null | undefined) {
  return GROUP_META[group ?? ""] ?? GROUP_META.internal_operational;
}

export function GroupBadge({ group }: { group: KnowledgeGroup | string | null | undefined }) {
  const m = groupMeta(group);
  return (
    <span className={`inline-flex items-center text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded border ${m.cls}`}>
      {m.label}
    </span>
  );
}

export function formatDate(value?: string | null): string | null {
  if (!value) return null;
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function excerpt(body: string, max = 180): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
}
