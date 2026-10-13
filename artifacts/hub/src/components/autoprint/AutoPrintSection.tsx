import { useEffect, useId, useState, type ReactNode } from "react";
import { useSearch } from "wouter";
import { ChevronDown } from "lucide-react";

/** Keep children mounted so hiding a section never discards edits or stops polling. */
export function AutoPrintSection({ title, children, id, defaultOpen = true, revealParam, testId }: {
  title: string;
  children: ReactNode;
  id?: string;
  defaultOpen?: boolean;
  revealParam?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const headingId = useId();
  const search = useSearch();
  useEffect(() => {
    const reveal = () => {
      const hash = window.location.hash.slice(1);
      if ((id && hash === id) || (revealParam && new URLSearchParams(search).has(revealParam))) {
        setOpen(true);
      }
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [id, revealParam, search]);
  return (
    <section id={id} data-testid={testId} className="scroll-mt-4 rounded-xl border border-slate-800 bg-[#0f172a]">
      <h2>
        <button type="button" id={headingId} aria-expanded={open} aria-controls={panelId}
          onClick={() => setOpen(value => !value)}
          className="flex w-full items-center gap-3 rounded-xl p-4 text-left text-sm font-semibold text-slate-100 hover:bg-slate-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
          <ChevronDown size={16} aria-hidden="true" className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
          <span className="flex-1">{title}</span>
          <span className="text-xs font-normal text-slate-400">{open ? "Hide" : "Expand"}</span>
        </button>
      </h2>
      <div id={panelId} role="region" aria-labelledby={headingId} hidden={!open}
        className="space-y-3 border-t border-slate-800 p-4">
        {children}
      </div>
    </section>
  );
}
