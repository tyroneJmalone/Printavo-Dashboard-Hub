export interface FailureEmail {
  key: string;
  title: string;
  reason: string;
  invoice: string | null;
  at: string;
}

export function failureEmailBody(incident: FailureEmail) {
  return {
    subject: `[Hub AutoPrint] ${incident.title}${incident.invoice ? ` — #${incident.invoice}` : ""}`,
    text: [
      incident.title,
      incident.invoice ? `Invoice/workorder: #${incident.invoice}` : "",
      `Recorded: ${new Date(incident.at).toLocaleString("en-US", { timeZone: "America/New_York" })} Eastern`,
      "", incident.reason, "",
      "Open Hub → Settings → Rules/Automations → AutoPrint.",
      "Search the invoice number. Use Pending Retries & Operator Review for print issues, or MERCH Status/Category Correction for post-print changes.",
      "Printer acceptance does not prove physical printing. If acceptance is unknown, verify PrintNode and the printer before resending.",
      "This notification does not reprint or change the invoice.",
    ].filter(Boolean).join("\n"),
  };
}

// Resend retains idempotency keys for 24 hours. Never replay an ambiguous send
// after that window: doing so could duplicate an already accepted notification.
export function emailRetryWindowOpen(firstAttempt: string, now = Date.now()) {
  const first = Date.parse(firstAttempt);
  return Number.isFinite(first) && now - first < 23 * 60 * 60_000;
}
