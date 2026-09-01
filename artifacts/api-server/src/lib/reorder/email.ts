// Reorder Portal → sales team notification email via Resend
// (@replit/connectors-sdk proxies through the Replit-managed Resend
// connection). Mirrors the Mint Bucks email transport conventions.
import { ReplitConnectors } from "@replit/connectors-sdk";
import type { Logger } from "pino";

const BUSINESS_NAME = "Mint Printworks";
const FROM_EMAIL = process.env.FROM_EMAIL ?? "noreply@mintprintworks.com";
/** Where reorder requests land for the sales team. */
const SALES_EMAIL = process.env.REORDER_SALES_EMAIL ?? "info@mintprintworks.com";

// Test-mode guard: until REORDER_EMAIL_MODE=live is set, every outbound
// email is redirected to Tyler with the original recipient preserved in
// the subject, so the sales inbox never receives test submissions.
const TEST_REDIRECT_EMAIL = "tyler@mintprintworks.com";

function applyEmailGuard(opts: { to: string; subject: string }): {
  to: string;
  subject: string;
  redirected: boolean;
} {
  if (process.env.REORDER_EMAIL_MODE === "live") {
    return { to: opts.to, subject: opts.subject, redirected: false };
  }
  return {
    to: TEST_REDIRECT_EMAIL,
    subject: `[TEST→${opts.to}] ${opts.subject}`,
    redirected: true,
  };
}

export interface ReorderEmailItem {
  itemNumber: string | null;
  color: string | null;
  description: string | null;
  sizes: Array<{ label: string; qty: number }>;
}

export interface ReorderEmailData {
  requestId: string;
  orderId: string;
  visualId: number | null;
  orderNickname: string | null;
  customerName: string;
  customerEmail: string;
  customerCompany: string | null;
  notes: string | null;
  items: ReorderEmailItem[];
  totalQty: number;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
  body{font-family:'Helvetica Neue',Arial,sans-serif;margin:0;padding:0;background:#f5f5f0}
  .wrap{max-width:640px;margin:40px auto;background:#fff;border-radius:8px;overflow:hidden}
  .hd{background:#16261c;padding:20px 32px;text-align:center}
  .hd .t{color:#7CC24D;font-size:20px;font-weight:800;letter-spacing:1px}
  .hd .s{color:#a8c5b8;font-size:12px;margin-top:4px;text-transform:uppercase;letter-spacing:2px}
  .bd{padding:32px}
  .ref{background:#f5faee;border:2px solid #7CC24D;border-radius:8px;padding:16px 20px;margin:0 0 20px}
  .ref .n{font-size:22px;font-weight:800;color:#16261c}
  .ref .l{color:#5f7c44;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin-top:2px}
  .dl{background:#f9f9f7;border-radius:6px;padding:4px 16px 16px;margin:0 0 20px}
  .dl dt{color:#666;font-size:11px;text-transform:uppercase;letter-spacing:.5px;margin-top:12px}
  .dl dd{color:#16261c;font-weight:600;margin:2px 0 0}
  table.items{width:100%;border-collapse:collapse;margin:0 0 20px}
  table.items th{background:#16261c;color:#7CC24D;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:8px 10px}
  table.items td{border-bottom:1px solid #e8e8e2;padding:10px;font-size:13px;color:#333;vertical-align:top}
  .sz{display:inline-block;background:#f5faee;border:1px solid #cfe6b8;border-radius:4px;padding:2px 8px;margin:2px 4px 2px 0;font-size:12px;color:#16261c;font-weight:600;white-space:nowrap}
  .note{border-left:3px solid #7CC24D;padding:12px 16px;background:#f5faee;margin:0 0 20px;color:#16261c}
  .ft{background:#f5f5f0;padding:20px 32px;text-align:center;color:#999;font-size:12px}
`;

export async function sendReorderRequestEmail(
  data: ReorderEmailData,
  log: Logger,
): Promise<boolean> {
  const orderRef = data.visualId != null ? `#${data.visualId}` : data.orderId;
  const subject = `Reorder request — order ${orderRef} · ${data.customerName}${data.customerCompany ? ` (${data.customerCompany})` : ""}`;

  const itemsRows = data.items
    .map((it) => {
      const sizeChips = it.sizes
        .map((s) => `<span class="sz">${esc(s.label)} × ${s.qty}</span>`)
        .join("");
      const qty = it.sizes.reduce((sum, s) => sum + s.qty, 0);
      return `<tr>
        <td><strong>${esc(it.description ?? "(no description)")}</strong>${it.itemNumber ? `<br><span style="color:#666">${esc(it.itemNumber)}</span>` : ""}${it.color ? `<br><span style="color:#666">${esc(it.color)}</span>` : ""}</td>
        <td>${sizeChips}</td>
        <td style="text-align:right;font-weight:700">${qty}</td>
      </tr>`;
    })
    .join("");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="wrap">
  <div class="hd"><div class="t">MINT PRINTWORKS</div><div class="s">New Reorder Request</div></div>
  <div class="bd">
    <div class="ref"><div class="n">Order ${esc(orderRef)}${data.orderNickname ? ` — ${esc(data.orderNickname)}` : ""}</div><div class="l">Customer wants to reorder</div></div>
    <div class="dl"><dl>
      <dt>Name</dt><dd>${esc(data.customerName)}</dd>
      <dt>Email</dt><dd>${esc(data.customerEmail)}</dd>
      ${data.customerCompany ? `<dt>Company</dt><dd>${esc(data.customerCompany)}</dd>` : ""}
    </dl></div>
    <table class="items">
      <tr><th>Item</th><th>Sizes</th><th style="text-align:right">Qty</th></tr>
      ${itemsRows}
      <tr><td colspan="2" style="text-align:right;font-weight:700;color:#16261c">Total pieces</td><td style="text-align:right;font-weight:800;color:#16261c">${data.totalQty}</td></tr>
    </table>
    ${data.notes ? `<div class="note"><strong>Customer notes:</strong><br>${esc(data.notes).replace(/\n/g, "<br>")}</div>` : ""}
    <p style="color:#666;font-size:12px">Reply to this email to reach the customer directly. This request is also in the Hub's Reorder Requests inbox (id ${esc(data.requestId)}).</p>
  </div>
  <div class="ft"><p>${BUSINESS_NAME} · Reorder Portal</p></div>
</div>
</body></html>`;

  const guarded = applyEmailGuard({ to: SALES_EMAIL, subject });
  if (guarded.redirected) {
    log.info(
      { originalTo: SALES_EMAIL, redirectedTo: guarded.to },
      "Reorder email test mode — redirecting",
    );
  }

  try {
    const connectors = new ReplitConnectors();
    const response = await connectors.proxy("resend", "/emails", {
      method: "POST",
      body: JSON.stringify({
        from: `${BUSINESS_NAME} Reorder Portal <${FROM_EMAIL}>`,
        to: guarded.to,
        reply_to: data.customerEmail,
        subject: guarded.subject,
        html,
      }),
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      log.error(
        { to: guarded.to, status: response.status, body },
        "Resend API error (reorder request)",
      );
      return false;
    }
    const result = (await response.json()) as { id?: string };
    log.info(
      { to: guarded.to, id: result.id, requestId: data.requestId },
      "Reorder request email sent",
    );
    return true;
  } catch (err) {
    log.error({ err, to: guarded.to }, "Failed to send reorder request email");
    return false;
  }
}
