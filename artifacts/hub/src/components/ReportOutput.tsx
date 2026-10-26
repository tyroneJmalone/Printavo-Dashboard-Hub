import { useState, type RefObject } from "react";
import { Printer, Download } from "lucide-react";
import { useIsFetching } from "@tanstack/react-query";

export type CsvTable = { headers: string[]; rows: (string | number | null | undefined)[][] };

/** Neutralise spreadsheet formula injection; keep plain numbers intact. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function downloadCsv(filename: string, lines: unknown[][]) {
  const text = "\ufeff" + lines.map(l => l.map(csvCell).join(",")).join("\r\n");
  const href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a"); a.href = href; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** Reads rendered tables and summary cards (marked data-report-summary) as text only. */
function captureRendered(root: HTMLElement): unknown[][] {
  const out: unknown[][] = [];
  root.querySelectorAll<HTMLElement>("[data-report-summary]").forEach(el => {
    const label = el.querySelector("[data-summary-label]")?.textContent?.trim();
    const value = el.querySelector("[data-summary-value]")?.textContent?.trim();
    if (label) out.push([label, value ?? ""]);
  });
  root.querySelectorAll("table").forEach((table, i) => {
    out.push([]);
    const caption = table.closest("[data-report-section]")?.getAttribute("data-report-section");
    out.push([`Table ${i + 1}${caption ? `: ${caption}` : ""}`]);
    table.querySelectorAll("tr").forEach(tr => {
      const cells = Array.from(tr.querySelectorAll("th,td")).map(c => (c as HTMLElement).innerText.replace(/\s+/g, " ").trim());
      if (cells.some(Boolean)) out.push(cells);
    });
  });
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "report";

export function ReportOutputControls({ targetRef, title, filters, scope, csvProvider, printOnly, disabled = false }: {
  targetRef: RefObject<HTMLElement | null>;
  title: string;
  filters: string[];
  /** Plain-language scope e.g. "Current page only (rows 1-100 of 4,210)". */
  scope: string;
  /** When given, CSV exports these rows (e.g. all results) instead of rendered tables. */
  csvProvider?: () => CsvTable;
  /** Hide CSV when the view already has its own all-results export. */
  printOnly?: boolean;
  disabled?: boolean;
}) {
  const [msg, setMsg] = useState("");
  const pendingReports = useIsFetching({ predicate: q => q.queryKey.some(k => typeof k === "string" && (k.startsWith("/api/reports/") || k === "chipply-report")) });
  const blocked = disabled || pendingReports > 0;
  const generated = () => new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
  const meta = (s: string) => [[title], [`Generated ${generated()} ET`], [`Scope: ${s}`], ...filters.map(f => [`Filter: ${f}`]), []];

  const print = () => {
    const el = targetRef.current; if (!el) return;
    // Clone the rendered DOM (no HTML strings) into a body-level root so the app shell is fully hidden.
    const root = document.createElement("div");
    root.id = "report-print-root";
    root.setAttribute("data-print-target", "");
    const header = document.createElement("div");
    header.className = "report-print-header";
    const h = document.createElement("h1"); h.textContent = title; header.appendChild(h);
    for (const line of [`Generated ${generated()} ET`, `Scope: ${scope}`, filters.length ? `Filters: ${filters.join(" · ")}` : "Filters: none"]) {
      const p = document.createElement("p"); p.textContent = line; header.appendChild(p);
    }
    root.appendChild(header);
    const clone = el.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("[data-print-exclude]").forEach(n => n.remove());
    root.appendChild(clone);
    document.body.appendChild(root);
    document.body.classList.add("report-printing");
    let cleaned = false;
    const done = () => { if (cleaned) return; cleaned = true; root.remove(); document.body.classList.remove("report-printing"); window.removeEventListener("afterprint", done); };
    window.addEventListener("afterprint", done);
    try { window.print(); } catch { done(); setMsg("Printing could not start. Please try again."); }
  };

  const exportCsv = () => {
    const el = targetRef.current;
    if (csvProvider) {
      const t = csvProvider();
      downloadCsv(`${slug(title)}.csv`, [...meta(`All matching rows (${t.rows.length})`), t.headers, ...t.rows]);
      setMsg(`Exported ${t.rows.length} rows.`);
      return;
    }
    if (!el) return;
    const body = captureRendered(el);
    if (!body.some(r => r.length > 1)) { setMsg("Nothing rendered to export yet."); return; }
    downloadCsv(`${slug(title)}.csv`, [...meta(`${scope} (as rendered on screen)`), ...body]);
    setMsg("Exported rendered view.");
  };

  return <div data-print-exclude className="flex flex-wrap items-center gap-2 print:hidden" data-testid="report-output-controls">
    <span className="text-[11px] text-slate-500" data-testid="text-export-scope">{printOnly ? `Print: ${scope}` : csvProvider ? `Print: ${scope} · CSV: all matching rows` : `CSV/print: ${scope}`}</span>
    <button type="button" disabled={blocked} onClick={print} data-testid="button-print-report" className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-40"><Printer size={14} /> Print / Save PDF</button>
    {!printOnly && <button type="button" disabled={blocked} onClick={exportCsv} data-testid="button-export-csv" className="flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-700 disabled:opacity-40"><Download size={14} /> Export CSV</button>}
    {msg && <span role="status" className="text-[11px] text-emerald-400">{msg}</span>}
  </div>;
}
