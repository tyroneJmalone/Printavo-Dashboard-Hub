/** API audit details are JSON objects, not React children. Render only user-facing fields. */
export function automationLogText(detail: unknown): string | null {
  if (detail == null) return null;
  if (typeof detail === "string") return detail;
  if (typeof detail !== "object" || Array.isArray(detail)) return null;
  const d = detail as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ["message", "error", "note"]) {
    if (typeof d[key] === "string" && d[key]) parts.push(d[key] as string);
  }
  const counts = [["invoices", "eligible invoices"], ["queued", "queued"],
    ["unchanged", "unchanged"], ["held", "held/skipped"]] as const;
  const totals = counts.flatMap(([key, label]) =>
    typeof d[key] === "number" ? [`${d[key]} ${label}`] : []);
  if (totals.length) parts.push(totals.join(" · "));
  if (Array.isArray(d.errors)) parts.push(...d.errors.filter((e): e is string => typeof e === "string"));
  if (Array.isArray(d.steps)) {
    for (const step of d.steps) {
      if (step && typeof step.name === "string") {
        parts.push(`${step.name}${typeof step.state === "string" ? `: ${step.state}` : ""}`);
      }
    }
  }
  return parts.join("\n") || null;
}
