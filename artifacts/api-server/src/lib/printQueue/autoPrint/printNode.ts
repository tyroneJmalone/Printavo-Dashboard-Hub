/**
 * Minimal PrintNode REST client (no npm dependency). Basic auth with the
 * API key as username. The key comes from the environment only — it is
 * never persisted to the database or included in run/job rows.
 */

const BASE = "https://api.printnode.com";
const TIMEOUT_MS = 20_000;

export function printNodeConfigured(): boolean {
  return !!process.env.PRINTNODE_API_KEY;
}

function authHeader(): string {
  const key = process.env.PRINTNODE_API_KEY ?? "";
  return "Basic " + Buffer.from(`${key}:`).toString("base64");
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  if (!printNodeConfigured()) {
    throw new Error("PRINTNODE_API_KEY is not configured");
  }
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: authHeader(),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `PrintNode ${method} ${path} failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

export interface PrintNodePrinter {
  id: number;
  name: string;
  state: string;
  computerName: string | null;
  computerState: string | null;
}

interface RawPrinter {
  id: number;
  name: string;
  state: string;
  computer?: { name?: string; state?: string } | null;
}

export async function listPrinters(): Promise<PrintNodePrinter[]> {
  const raw = await request<RawPrinter[]>("GET", "/printers");
  return raw.map((p) => ({
    id: p.id,
    name: p.name,
    state: p.state,
    computerName: p.computer?.name ?? null,
    computerState: p.computer?.state ?? null,
  }));
}

/** Submit a PDF print job. Returns the PrintNode job id. */
export async function submitPdfPrintJob(opts: {
  printerId: number;
  title: string;
  pdfBase64: string;
  copies: number;
  source: string;
}): Promise<number> {
  const jobId = await request<number>("POST", "/printjobs", {
    printerId: opts.printerId,
    title: opts.title,
    contentType: "pdf_base64",
    content: opts.pdfBase64,
    source: opts.source,
    qty: opts.copies,
  });
  return jobId;
}
