import { useMemo, useState, type ReactNode } from "react";
import { useGetAdminUpdates, getGetAdminUpdatesQueryKey } from "@workspace/api-client-react";
import type { AdminPlanningDocument, AdminRelease } from "@workspace/api-client-react";
import { ArrowLeft, Download, FileText, History, Search } from "lucide-react";

const input = "w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 [color-scheme:dark]";
const CATEGORY_ORDER = ["Admin action needed", "New features", "Improvements", "Fixes"];
const RELEASE_LABEL: Record<AdminRelease["status"], string> = {
  prepared: "Prepared for publishing",
  published: "Included in published build",
  historical: "Historical summary (publish date unverified)",
};
const RELEASE_TONE: Record<AdminRelease["status"], string> = {
  prepared: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  published: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  historical: "border-slate-500/40 bg-slate-700/40 text-slate-300",
};
const DOC_STATUSES = ["Idea", "Planned", "In progress", "Needs verification", "Deferred"] as const;
const DOC_TONE: Record<string, string> = {
  Idea: "border-slate-500/40 text-slate-300",
  Planned: "border-sky-500/40 text-sky-200",
  "In progress": "border-emerald-500/40 text-emerald-200",
  "Needs verification": "border-amber-500/40 text-amber-200",
  Deferred: "border-slate-600 text-slate-400",
};

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" aria-pressed={active} onClick={onClick}
    className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${active ? "border-emerald-500/60 bg-emerald-600/20 text-emerald-200" : "border-slate-700 text-slate-400 hover:text-white"}`}>{children}</button>;
}

function SearchBox({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return <label className="relative block">
    <span className="sr-only">{label}</span>
    <Search size={14} aria-hidden className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
    <input type="search" className={`${input} pl-9`} placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} />
  </label>;
}

function Empty({ text, onClear }: { text: string; onClear: () => void }) {
  return <div className="rounded-xl border border-dashed border-slate-700 p-8 text-center text-sm text-slate-400">
    {text} <button type="button" onClick={onClear} className="ml-1 text-emerald-300 underline">Clear filters</button>
  </div>;
}

function Changelog({ releases }: { releases: AdminRelease[] }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<AdminRelease["status"] | "all">("all");
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    releases.forEach((r) => { c[r.status] = (c[r.status] ?? 0) + 1; });
    return c;
  }, [releases]);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return releases.filter((r) => (status === "all" || r.status === status) &&
      (!t || r.title.toLowerCase().includes(t) || r.notes.some((n) => n.text.toLowerCase().includes(t) || n.category.toLowerCase().includes(t))));
  }, [releases, q, status]);

  return <div className="space-y-4">
    <SearchBox value={q} onChange={setQ} label="Search release notes" />
    <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by release status">
      <Chip active={status === "all"} onClick={() => setStatus("all")}>All ({releases.length})</Chip>
      {(Object.keys(RELEASE_LABEL) as AdminRelease["status"][]).map((s) =>
        <Chip key={s} active={status === s} onClick={() => setStatus(s)}>{s === "historical" ? "Historical" : RELEASE_LABEL[s]} ({counts[s] ?? 0})</Chip>)}
    </div>
    {releases.length === 0 ? <p className="text-sm text-slate-400">No release entries have been recorded.</p>
      : filtered.length === 0 ? <Empty text="No release entries match." onClear={() => { setQ(""); setStatus("all"); }} />
      : <ol className="space-y-4">
        {filtered.map((r) => {
          const cats = [...new Set(r.notes.map((n) => n.category))].sort((a, b) => CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b));
          return <li key={r.id} className="rounded-xl border border-slate-700 bg-slate-800/40">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-700/70 px-5 py-3">
              <h3 className="text-base font-semibold text-white">{r.title}</h3>
              <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${RELEASE_TONE[r.status]}`}>{RELEASE_LABEL[r.status]}</span>
              <span className="ml-auto font-mono text-xs text-slate-400">{r.date ?? "Date not recorded"}</span>
            </div>
            <div className="space-y-4 px-5 py-4">
              {cats.length === 0 && <p className="text-sm text-slate-500">No notes in this entry.</p>}
              {cats.map((c) => <section key={c}>
                <h4 className={`mb-1.5 text-[11px] font-semibold uppercase tracking-wide ${c === "Admin action needed" ? "text-amber-300" : "text-slate-400"}`}>{c}</h4>
                <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-200 marker:text-slate-600">
                  {r.notes.filter((n) => n.category === c).map((n, i) => <li key={i}>{n.text}</li>)}
                </ul>
              </section>)}
            </div>
          </li>;
        })}
      </ol>}
  </div>;
}

/** Renders inline markdown as plain React text: code, bold, and links (only to indexed docs or http URLs). */
function Inline({ text, onOpen, byFile }: { text: string; onOpen: (d: AdminPlanningDocument) => void; byFile: Map<string, AdminPlanningDocument> }) {
  const parts: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0; let m: RegExpExecArray | null; let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) parts.push(<code key={k++} className="rounded bg-slate-800 px-1 font-mono text-[0.85em] text-emerald-200">{m[1].slice(1, -1)}</code>);
    else if (m[2]) parts.push(<strong key={k++} className="font-semibold text-white">{m[2].slice(2, -2)}</strong>);
    else {
      const label = m[4]; const href = m[5];
      const doc = byFile.get(href.split("#")[0].split("/").pop() ?? "");
      if (doc) parts.push(<button key={k++} type="button" onClick={() => onOpen(doc)} className="text-emerald-300 underline">{label}</button>);
      else if (/^https?:\/\//.test(href)) parts.push(<a key={k++} href={href} target="_blank" rel="noopener noreferrer" className="text-sky-300 underline">{label}</a>);
      else parts.push(label);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function Markdown({ source, onOpen, byFile }: { source: string; onOpen: (d: AdminPlanningDocument) => void; byFile: Map<string, AdminPlanningDocument> }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0; let k = 0;
  const inl = (t: string) => <Inline text={t} onOpen={onOpen} byFile={byFile} />;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const buf: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++;
      out.push(<pre key={k++} className="overflow-x-auto rounded-lg bg-slate-950/70 p-3 font-mono text-xs text-slate-300">{buf.join("\n")}</pre>);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      const cls = lvl === 1 ? "text-xl font-semibold text-white mt-2" : lvl === 2 ? "text-lg font-semibold text-white mt-4" : "text-sm font-semibold uppercase tracking-wide text-slate-300 mt-3";
      out.push(<p key={k++} role="heading" aria-level={lvl + 2} className={cls}>{inl(h[2])}</p>);
      i++; continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: string[] = []; const ordered = /^\s*\d+\./.test(line);
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
      const L = ordered ? "ol" : "ul";
      out.push(<L key={k++} className={`${ordered ? "list-decimal" : "list-disc"} space-y-1 pl-5 marker:text-slate-500`}>{items.map((t, j) => <li key={j}>{inl(t.replace(/^\[( |x)\]\s*/i, (s) => (/x/i.test(s) ? "[done] " : "[open] ")))}</li>)}</L>);
      continue;
    }
    if (line.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(<blockquote key={k++} className="border-l-2 border-slate-600 pl-3 text-slate-400">{inl(buf.join(" "))}</blockquote>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+\.)\s+)/.test(lines[i])) buf.push(lines[i++]);
    out.push(<p key={k++} className="whitespace-pre-wrap">{inl(buf.join("\n"))}</p>);
  }
  return <div className="space-y-3 text-sm leading-relaxed text-slate-200">{out}</div>;
}

function download(doc: AdminPlanningDocument) {
  const url = URL.createObjectURL(new Blob([doc.content], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = doc.filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Documents({ documents }: { documents: AdminPlanningDocument[] }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const byFile = useMemo(() => new Map(documents.map((d) => [d.filename, d])), [documents]);
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    documents.forEach((d) => { c[d.status] = (c[d.status] ?? 0) + 1; });
    return c;
  }, [documents]);
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return documents.filter((d) => (status === "all" || d.status === status) &&
      (!t || d.title.toLowerCase().includes(t) || d.summary.toLowerCase().includes(t) || d.content.toLowerCase().includes(t)));
  }, [documents, q, status]);
  const open = documents.find((d) => d.id === openId);
  const openDoc = (d: AdminPlanningDocument) => { setOpenId(d.id); window.scrollTo({ top: 0 }); };

  if (open) return <article className="rounded-xl border border-slate-700 bg-slate-800/40">
    <div className="flex flex-wrap items-center gap-3 border-b border-slate-700/70 px-5 py-3">
      <button type="button" onClick={() => setOpenId(null)} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:text-white"><ArrowLeft size={13} />All documents</button>
      <button type="button" onClick={() => download(open)} className="ml-auto flex items-center gap-1.5 rounded-lg border border-emerald-600/40 bg-emerald-600/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-600/20"><Download size={13} />Download {open.filename}</button>
    </div>
    <div className="px-5 py-4">
      <h3 className="text-lg font-semibold text-white">{open.title}</h3>
      <p className="mt-1 text-xs text-slate-400"><span className={`mr-2 rounded-full border px-2 py-0.5 ${DOC_TONE[open.status]}`}>{open.status}</span>Updated: {open.updatedOn ?? "Not recorded"} · <span className="font-mono">{open.filename}</span></p>
      <div className="mt-5 border-t border-slate-700/70 pt-4"><Markdown source={open.content} onOpen={openDoc} byFile={byFile} /></div>
    </div>
  </article>;

  return <div className="space-y-4">
    <SearchBox value={q} onChange={setQ} label="Search titles, summaries, and document text" />
    <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by document status">
      <Chip active={status === "all"} onClick={() => setStatus("all")}>All ({documents.length})</Chip>
      {DOC_STATUSES.map((s) => <Chip key={s} active={status === s} onClick={() => setStatus(s)}>{s} ({counts[s] ?? 0})</Chip>)}
    </div>
    {documents.length === 0 ? <p className="text-sm text-slate-400">No planning documents have been indexed.</p>
      : filtered.length === 0 ? <Empty text="No documents match." onClear={() => { setQ(""); setStatus("all"); }} />
      : <ul className="divide-y divide-slate-700/70 rounded-xl border border-slate-700 bg-slate-800/40">
        {filtered.map((d) => <li key={d.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-white">{d.title}</h3>
              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${DOC_TONE[d.status]}`}>{d.status}</span>
            </div>
            <p className="mt-1 text-sm text-slate-300">{d.summary}</p>
            <p className="mt-1 text-xs text-slate-500">Updated: {d.updatedOn ?? "Not recorded"} · <span className="font-mono">{d.filename}</span></p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={() => openDoc(d)} className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-emerald-500 hover:text-white">View document</button>
            <button type="button" onClick={() => download(d)} aria-label={`Download ${d.filename}`} className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-slate-400 hover:text-white"><Download size={14} /></button>
          </div>
        </li>)}
      </ul>}
  </div>;
}

export function UpdatesPlansCard() {
  const query = useGetAdminUpdates({ query: { queryKey: getGetAdminUpdatesQueryKey(), staleTime: 0, refetchOnMount: "always" } });
  const [tab, setTab] = useState<"changelog" | "documents">("changelog");

  const tabs = [
    { id: "changelog" as const, label: "Changelog", icon: History },
    { id: "documents" as const, label: "Planned Features & Documents", icon: FileText },
  ];

  return <section className="max-w-4xl space-y-5 p-4 lg:p-6">
    <div>
      <h2 className="text-xl font-semibold text-white">Updates & planned features</h2>
      <p className="mt-1 text-sm text-slate-400">Read-only. The published app identifies release entries included in its running build; preview keeps unconfirmed entries marked as prepared. Dates appear only when recorded. Historical summaries retain their original labels. Planning documents are maintained separately and are not marked completed by publishing.</p>
    </div>
    <div role="tablist" aria-label="Updates views" className="flex gap-1 border-b border-slate-700">
      {tabs.map(({ id, label, icon: Icon }, index) => <button key={id} role="tab" type="button" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
          setTab(tabs[next].id);
          document.getElementById(`tab-${tabs[next].id}`)?.focus();
        }}
        className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${tab === id ? "border-emerald-400 text-emerald-200" : "border-transparent text-slate-400 hover:text-white"}`}><Icon size={14} />{label}</button>)}
    </div>
    <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      {query.isLoading ? <div className="space-y-3" aria-busy="true" aria-label="Loading updates">
        {[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-slate-800/60" />)}
      </div>
        : query.isError || !query.data ? <div role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-5 text-sm text-red-300">
          Could not load updates. <button type="button" onClick={() => query.refetch()} className="ml-1 underline">Retry</button>
        </div>
        : tab === "changelog" ? <Changelog releases={query.data.releases} /> : <Documents documents={query.data.documents} />}
    </div>
  </section>;
}
