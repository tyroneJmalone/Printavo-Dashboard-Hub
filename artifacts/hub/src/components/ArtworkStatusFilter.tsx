import { useState } from "react";

export function ArtworkStatusFilter({ options, selected, excluding, onChange }: {
  options: string[];
  selected: string[];
  excluding: boolean;
  onChange: (statuses: string[], excluding: boolean) => void;
}) {
  const [search, setSearch] = useState("");
  const all = [...new Set([...options, ...selected])];
  const visible = all.filter(s => s.toLowerCase().includes(search.trim().toLowerCase()));
  const merch = options.filter(s => /\bmerch\b/i.test(s));
  const button = "rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:border-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-400 disabled:opacity-40";
  return <fieldset className="space-y-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
    <legend className="px-1 text-xs font-semibold text-slate-200">Order statuses</legend>
    <label className="flex items-center gap-2 text-xs text-slate-300">
      Selected statuses
      <select aria-label="Status filter mode" value={excluding ? "exclude" : "include"}
        onChange={e => onChange(selected, e.target.value === "exclude")}
        className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-white">
        <option value="exclude">Exclude</option><option value="include">Include only</option>
      </select>
    </label>
    <button type="button" className={`${button} w-full border-emerald-700 text-emerald-300`}
      disabled={!merch.length} data-testid="artwork-exclude-merch"
      onClick={() => onChange([...new Set([...(excluding ? selected : []), ...merch])], true)}>
      Exclude all MERCH statuses ({merch.length})
    </button>
    <p className="text-[11px] text-slate-400">MERCH matches current status names, not invoice nicknames. This shortcut keeps other exclusions; it replaces an Include-only selection.</p>
    <input type="search" aria-label="Search order statuses" placeholder="Search statuses…" value={search}
      onChange={e => setSearch(e.target.value)} className="w-full rounded border border-slate-600 bg-slate-800 px-2 py-1.5 text-xs text-white" />
    <div className="flex flex-wrap gap-2">
      <button type="button" className={button} disabled={!visible.length}
        onClick={() => onChange([...new Set([...selected, ...visible])], excluding)}>Select shown ({visible.length})</button>
      <button type="button" className={button} disabled={!selected.length} onClick={() => onChange([], excluding)}>Clear selection</button>
    </div>
    <div className="max-h-52 space-y-1 overflow-y-auto rounded border border-slate-700 p-2" role="group" aria-label="Select multiple order statuses">
      {visible.map(s => <label key={s} className="flex cursor-pointer items-start gap-2 rounded p-1 text-xs text-slate-200 hover:bg-slate-800">
        <input type="checkbox" checked={selected.includes(s)} className="mt-0.5 accent-emerald-500"
          onChange={e => onChange(e.target.checked ? [...selected, s] : selected.filter(v => v !== s), excluding)} />
        <span>{s}</span>
      </label>)}
      {!visible.length && <p className="text-xs text-slate-400">{options.length ? "No matching statuses." : "No status options available yet."}</p>}
    </div>
    <p role="status" className="text-xs text-emerald-300">{selected.length ? `${selected.length} statuses ${excluding ? "excluded" : "included"}` : "No status restrictions"}</p>
    {!!selected.length && <details className="text-xs text-slate-300">
      <summary className="cursor-pointer">Review selected statuses</summary>
      <ul className="mt-2 space-y-1">{selected.map(s => <li key={s} className="flex items-start justify-between gap-2">
        <span>{s}</span><button type="button" className="underline" aria-label={`Remove ${s} from status filter`}
          onClick={() => onChange(selected.filter(v => v !== s), excluding)}>Remove</button>
      </li>)}</ul>
    </details>}
  </fieldset>;
}
