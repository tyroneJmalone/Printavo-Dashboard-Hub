/** Published origin verified through deployment metadata. Never use a preview URL in production mail. */
const PUBLISHED_ORIGIN = "https://MintHub.replit.app";

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function reviewLinks(orderId: string, files: { jobId?: string | null; name?: string; filename?: string }[], development = false) {
  const domain = process.env.REPLIT_DEV_DOMAIN;
  if (development && !domain) throw new Error("Development preview address is unavailable; cannot send a test review link.");
  const origin = development ? `https://${domain}` : PUBLISHED_ORIGIN;
  const links = [
    { label: "Review invoice in SepScope", url: `${origin}/printscope/automation?review=${encodeURIComponent(orderId)}` },
    ...files.filter(f => f.jobId).map(f => ({
      label: `Inspection: ${f.name ?? f.filename ?? "OUTPUT file"}`,
      url: `${origin}/printscope?job=${encodeURIComponent(f.jobId!)}`,
    })),
  ];
  return {
    text: links.map(l => `${l.label}: ${l.url}`).join("\n"),
    html: links.map(l => `<p><a href="${escapeHtml(l.url)}">${escapeHtml(l.label)}</a></p>`).join(""),
  };
}

export function inspectionNotes(existing: string, files: { jobId?: string | null; name: string; verdict?: string | null; inspectedAt?: string | null }[], testMode: boolean) {
  const blocks: string[] = [];
  for (const file of files) {
    if (!file.jobId || !["pass", "fail"].includes(file.verdict ?? "")) {
      throw new Error("A dated Pass/Fail result is required before recording an inspection.");
    }
    const marker = `[SepScope inspection ${file.jobId}]`;
    if (existing.includes(marker)) continue;
    const date = new Date(file.inspectedAt ?? "");
    if (!Number.isFinite(date.getTime())) throw new Error("Inspection completion date is unavailable.");
    const dateLabel = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(date);
    blocks.push(`<p>${escapeHtml(marker)}${testMode ? " [RESTRICTED LIVE TEST]" : ""}<br>OUTPUT inspected: ${escapeHtml(file.name)}<br>Inspected: ${escapeHtml(dateLabel)}<br>Result: ${file.verdict!.toUpperCase()}</p>`);
  }
  return blocks.length ? existing + "\n" + blocks.join("\n") : existing;
}
