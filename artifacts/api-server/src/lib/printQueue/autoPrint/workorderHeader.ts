import { nicknameHasKeyword } from "../../purchasing/ruleMatching";

/** Same case-insensitive, whole-keyword matching used by status routing. */
export function workorderHeaderText(nickname: string | null = null, isReprint = false): string {
  const labels: string[] = [];
  if (nicknameHasKeyword(nickname, ["firm", "rush", "deadline"])) labels.push("Rush/Firm Deadline");
  if (isReprint) labels.push("UPDATED");
  return labels.join(" — ");
}

/** Keep the existing banner styling and avoid ever injecting nickname HTML. */
export function workorderHeaderScript(nickname: string | null = null, isReprint = false): string {
  const text = workorderHeaderText(nickname, isReprint);
  return `(() => {
    document.querySelectorAll(".pq-reprint-banner").forEach(banner => banner.remove());
    const text = ${JSON.stringify(text)};
    if (!text) return;
    const banner = document.createElement("div");
    banner.className = "pq-reprint-banner";
    banner.textContent = text;
    document.body.prepend(banner);
  })()`;
}
