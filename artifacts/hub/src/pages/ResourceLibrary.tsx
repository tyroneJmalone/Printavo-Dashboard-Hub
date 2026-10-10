import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  useListKnowledgeLibrary,
  getListKnowledgeLibraryQueryKey,
  type ListKnowledgeLibraryParams,
} from "@workspace/api-client-react";
import { AppShell } from "@/components/layout/AppShell";
import { GroupBadge, LIBRARY_PAGE_SIZE, LIBRARY_REFRESH_MS, excerpt, formatDate } from "@/components/library/libraryShared";
import { Library, Search, AlertTriangle, ChevronLeft, ChevronRight, X, RefreshCw } from "lucide-react";

const inputCls =
  "bg-[#1e293b] border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#059669]";

function buildHref(q: string, category: string, page: number) {
  const sp = new URLSearchParams();
  if (q) sp.set("q", q);
  if (category) sp.set("category", category);
  if (page > 1) sp.set("page", String(page));
  const s = sp.toString();
  return s ? `/library?${s}` : "/library";
}

export default function ResourceLibrary() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const sp = useMemo(() => new URLSearchParams(search), [search]);
  const q = sp.get("q") ?? "";
  const category = sp.get("category") ?? "";
  const page = Math.min(33_334, Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1));

  useEffect(() => { document.title = "Resource Library · Printavo Hub"; }, []);

  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);

  // Debounced search writes to the URL (replace, so typing doesn't spam history).
  useEffect(() => {
    const next = draft.trim();
    if (next === q) return;
    const t = setTimeout(() => navigate(buildHref(next, category, 1), { replace: true }), 350);
    return () => clearTimeout(t);
  }, [draft, q, category, navigate]);

  const params = useMemo((): ListKnowledgeLibraryParams => ({
    ...(q ? { q } : {}),
    ...(category ? { category } : {}),
    ...(page > 1 ? { offset: (page - 1) * LIBRARY_PAGE_SIZE } : {}),
  }), [q, category, page]);

  const { data: result, isLoading, isError, refetch, isFetching } = useListKnowledgeLibrary(params, {
    query: {
      queryKey: getListKnowledgeLibraryQueryKey(params),
      staleTime: 0,
      refetchInterval: LIBRARY_REFRESH_MS,
      refetchOnWindowFocus: true,
    },
  });
  // Fail closed on refresh failures (including revoked staff/module access).
  const data = isError ? undefined : result;

  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIBRARY_PAGE_SIZE));
  const categories = useMemo(
    () => [...(data?.categories ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [data?.categories],
  );
  const allCount = categories.reduce((s, c) => s + c.count, 0);
  const returnTo = buildHref(q, category, page);

  const catBtn = (active: boolean) =>
    `w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-[13px] text-left border transition-colors ${
      active ? "bg-[#059669]/10 text-[#10b981] border-[#059669]/20" : "text-slate-400 border-transparent hover:text-slate-100 hover:bg-slate-800"
    }`;

  return (
    <AppShell>
      <div className="p-4 lg:p-6 max-w-6xl space-y-4">
        <div className="flex items-center gap-3">
          <Library size={18} className="text-[#10b981]" />
          <h1 className="text-lg font-semibold text-white">Resource Library</h1>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => refetch()}
            className="p-1.5 rounded-md text-slate-500 hover:text-slate-200 hover:bg-slate-800"
            title="Refresh"
            data-testid="button-refresh-library"
          >
            <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
          </button>
        </div>
        <p className="text-xs text-slate-500 -mt-2">
          Approved, current company resources: policies, handbook, training, SOPs, FAQs, order guides, branding and sales material.
          Check each entry's usage label before sharing anything outside the team.
        </p>

        <div className="relative max-w-xl">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            className={`${inputCls} w-full pl-8 pr-8`}
            placeholder="Search titles, text and tags…"
            aria-label="Search resources"
            value={draft}
            maxLength={200}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") navigate(buildHref(draft.trim(), category, 1), { replace: true }); }}
            data-testid="input-library-search"
          />
          {draft && (
            <button type="button" onClick={() => setDraft("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200" aria-label="Clear search" data-testid="button-clear-search">
              <X size={14} />
            </button>
          )}
        </div>

        <div className="grid gap-4 md:grid-cols-[200px_1fr]">
          <aside className="md:sticky md:top-4 self-start">
            <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 px-2.5 mb-1.5">Categories</div>
            <div className="flex md:flex-col gap-0.5 overflow-x-auto md:overflow-visible pb-1">
              <Link href={buildHref(q, "", 1)} className={catBtn(!category)} data-testid="link-category-all">
                <span className="whitespace-nowrap">All</span>
                {data && !q && <span className="text-[10px] text-slate-500 font-mono">{allCount}</span>}
              </Link>
              {isLoading && !data && Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-7 rounded-md bg-slate-800/50 animate-pulse" />
              ))}
              {categories.map((c) => (
                <Link key={c.name} href={buildHref(q, c.name, 1)} className={catBtn(category === c.name)} data-testid={`link-category-${c.name}`}>
                  <span className="whitespace-nowrap md:whitespace-normal md:break-words min-w-0">{c.name}</span>
                  <span className="text-[10px] text-slate-500 font-mono">{c.count}</span>
                </Link>
              ))}
              {category && data && !categories.some((c) => c.name === category) && (
                <div className={catBtn(true)}><span>{category}</span><span className="text-[10px] font-mono">0</span></div>
              )}
            </div>
          </aside>

          <section className="min-w-0 space-y-2">
            <div className="flex items-center gap-2 text-xs text-slate-500 min-h-[20px]">
              {data && (
                <span data-testid="text-result-count">
                  {total} {total === 1 ? "resource" : "resources"}
                  {category && <> in <span className="text-slate-300">{category}</span></>}
                  {q && <> matching <span className="text-slate-300">"{q}"</span></>}
                </span>
              )}
            </div>

            {isError && !data ? (
              <div className="rounded-xl border border-red-900/50 bg-red-950/20 p-6 text-center">
                <AlertTriangle className="mx-auto text-red-300" size={22} />
                <div className="mt-2 text-sm text-slate-200">Couldn't load the library.</div>
                <button type="button" onClick={() => refetch()} className="mt-3 text-xs font-medium px-3 py-1.5 rounded-md bg-[#059669] hover:bg-[#047857] text-white" data-testid="button-retry-library">
                  Try again
                </button>
              </div>
            ) : isLoading && !data ? (
              <div className="space-y-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="rounded-lg border border-slate-800 bg-[#0f172a] p-4 space-y-2">
                    <div className="h-4 w-1/2 rounded bg-slate-800 animate-pulse" />
                    <div className="h-3 w-full rounded bg-slate-800/60 animate-pulse" />
                    <div className="h-3 w-3/4 rounded bg-slate-800/60 animate-pulse" />
                  </div>
                ))}
              </div>
            ) : data && data.items.length === 0 ? (
              <div className="rounded-xl border border-dashed border-slate-800 p-10 text-center">
                <Library className="mx-auto text-slate-600" size={26} />
                <div className="mt-3 text-sm text-slate-300">
                  {q || category ? "No resources match these filters." : "No approved resources yet."}
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {q || category ? "Try a different search or category." : "Entries appear here once an admin approves them in Settings."}
                </div>
                {(q || category) && (
                  <Link href="/library" className="inline-block mt-3 text-xs px-2.5 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800" data-testid="link-clear-filters">
                    Clear filters
                  </Link>
                )}
              </div>
            ) : (
              <ul className={`divide-y divide-slate-800 rounded-xl border border-slate-800 bg-[#0f172a] overflow-hidden ${isFetching && !isLoading ? "opacity-80" : ""}`}>
                {data?.items.map((e) => (
                  <li key={e.id}>
                    <Link
                      href={`/library/${encodeURIComponent(e.id)}?from=${encodeURIComponent(returnTo)}`}
                      className="block px-4 py-3 hover:bg-slate-800/40 transition-colors"
                      data-testid={`link-resource-${e.id}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-slate-100">{e.title}</span>
                        <GroupBadge group={e.knowledgeGroup} />
                        {e.sourceStale && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-amber-300"><AlertTriangle size={11} /> Source changed</span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-slate-400 line-clamp-2">{excerpt(e.body)}</div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                        <span className="text-slate-400">{e.category}</span>
                        <span>Updated {formatDate(e.updatedAt)}</span>
                        {e.tags.slice(0, 4).map((t) => (
                          <span key={t} className="font-mono text-[10px] text-slate-500">#{t}</span>
                        ))}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}

            {data && total > LIBRARY_PAGE_SIZE && (
              <div className="flex items-center justify-between pt-2 text-xs text-slate-400">
                <span>Page {page} of {pages}</span>
                <div className="flex gap-1.5">
                  {page > 1 ? (
                    <Link href={buildHref(q, category, page - 1)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-700 hover:bg-slate-800" data-testid="link-page-prev">
                      <ChevronLeft size={13} /> Previous
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-800 text-slate-600"><ChevronLeft size={13} /> Previous</span>
                  )}
                  {page < pages ? (
                    <Link href={buildHref(q, category, page + 1)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-700 hover:bg-slate-800" data-testid="link-page-next">
                      Next <ChevronRight size={13} />
                    </Link>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-800 text-slate-600">Next <ChevronRight size={13} /></span>
                  )}
                </div>
              </div>
            )}
            {data && page > pages && total > 0 && (
              <Link href={buildHref(q, category, 1)} className="text-xs text-[#10b981]">Back to first page</Link>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}
