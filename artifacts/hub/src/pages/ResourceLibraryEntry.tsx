import { useEffect, useMemo } from "react";
import { Link, useParams, useSearch } from "wouter";
import { useGetKnowledgeLibraryEntry, getGetKnowledgeLibraryEntryQueryKey } from "@workspace/api-client-react";
import { AppShell } from "@/components/layout/AppShell";
import { GroupBadge, LIBRARY_REFRESH_MS, formatDate, groupMeta } from "@/components/library/libraryShared";
import { ArrowLeft, AlertTriangle, FileText, Lock, ShieldCheck } from "lucide-react";

export default function ResourceLibraryEntry() {
  const params = useParams<{ id: string }>();
  const id = params.id ?? "";
  const search = useSearch();
  const back = useMemo(() => {
    const from = new URLSearchParams(search).get("from") ?? "";
    return from === "/library" || from.startsWith("/library?") ? from : "/library";
  }, [search]);

  const { data: entry, isLoading, isError, error, refetch } = useGetKnowledgeLibraryEntry(id, {
    query: {
      queryKey: getGetKnowledgeLibraryEntryQueryKey(id),
      enabled: !!id,
      staleTime: 0,
      refetchInterval: LIBRARY_REFRESH_MS,
      refetchOnWindowFocus: true,
      retry: (count, err: any) => err?.status !== 404 && err?.status !== 403 && count < 2,
    },
  });
  const status = (error as any)?.status;
  useEffect(() => {
    document.title = `${!isError && entry ? entry.title : "Resource"} · Resource Library`;
  }, [entry?.title, isError]);
  const paragraphs = useMemo(
    () => (entry?.body ?? "").replace(/\r\n/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
    [entry?.body],
  );
  const meta = groupMeta(entry?.knowledgeGroup);
  const shareable = entry?.knowledgeGroup === "customer_shareable";

  return (
    <AppShell>
      <div className="p-4 lg:p-6 max-w-3xl space-y-4">
        <Link href={back} className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-100" data-testid="link-back-library">
          <ArrowLeft size={13} /> Resource Library
        </Link>

        {isLoading ? (
          <div className="rounded-xl border border-slate-800 bg-[#0f172a] p-6 space-y-3">
            <div className="h-5 w-2/3 rounded bg-slate-800 animate-pulse" />
            <div className="h-3 w-1/3 rounded bg-slate-800/60 animate-pulse" />
            {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-3 rounded bg-slate-800/50 animate-pulse" />)}
          </div>
        ) : isError || !entry ? (
          <div className="rounded-xl border border-slate-800 bg-[#0f172a] p-8 text-center">
            <AlertTriangle className="mx-auto text-slate-500" size={24} />
            <div className="mt-3 text-sm text-slate-200">
              {status === 404 || status === 403 ? "This resource isn't available." : "Couldn't load this resource."}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {status === 404 || status === 403
                ? "It may have been archived, expired, or withdrawn from the library."
                : "Check your connection and try again."}
            </div>
            <div className="mt-4 flex justify-center gap-2">
              {status !== 404 && status !== 403 && (
                <button type="button" onClick={() => refetch()} className="text-xs font-medium px-3 py-1.5 rounded-md bg-[#059669] hover:bg-[#047857] text-white" data-testid="button-retry-entry">Try again</button>
              )}
              <Link href={back} className="text-xs px-3 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:bg-slate-800">Back to library</Link>
            </div>
          </div>
        ) : (
          <article className="rounded-xl border border-slate-800 bg-[#0f172a]">
            <header className="p-5 border-b border-slate-800 space-y-2">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <Link href={`/library?category=${encodeURIComponent(entry.category)}`} className="text-slate-400 hover:text-[#10b981]" data-testid="link-entry-category">
                  {entry.category}
                </Link>
                <GroupBadge group={entry.knowledgeGroup} />
              </div>
              <h1 className="text-xl font-semibold text-white leading-snug" data-testid="text-entry-title">{entry.title}</h1>
              <dl className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-slate-500">
                <div><dt className="inline">Updated </dt><dd className="inline text-slate-300">{formatDate(entry.updatedAt)}</dd></div>
                {entry.approvedAt && <div><dt className="inline">Approved </dt><dd className="inline text-slate-300">{formatDate(entry.approvedAt)}</dd></div>}
                {entry.effectiveDate && <div><dt className="inline">Effective </dt><dd className="inline text-slate-300">{formatDate(entry.effectiveDate)}</dd></div>}
                {entry.expiresDate && <div><dt className="inline">Expires after </dt><dd className="inline text-slate-300">{formatDate(entry.expiresDate)}</dd></div>}
              </dl>
            </header>

            <div className={`mx-5 mt-4 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${meta.cls}`} data-testid="text-usage-disclosure">
              {shareable ? <ShieldCheck size={14} className="mt-0.5 shrink-0" /> : <Lock size={14} className="mt-0.5 shrink-0" />}
              <span>{meta.note}</span>
            </div>

            {entry.sourceStale && (
              <div className="mx-5 mt-2 flex items-start gap-2 rounded-md border border-amber-600/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200" data-testid="text-source-stale">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>The source document has changed since this entry was approved. It may be out of date; confirm with an admin before relying on it.</span>
              </div>
            )}

            <div className="p-5 space-y-3 text-[14px] leading-relaxed text-slate-200" data-testid="text-entry-body">
              {paragraphs.map((p, i) => (
                <p key={i} className="whitespace-pre-wrap break-words">{p}</p>
              ))}
            </div>

            {(entry.tags.length > 0 || entry.sourceName) && (
              <footer className="px-5 py-3 border-t border-slate-800 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px] text-slate-500">
                {entry.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {entry.tags.map((t) => (
                      <Link key={t} href={`/library?q=${encodeURIComponent(t)}`} className="font-mono rounded bg-slate-800 px-1.5 py-0.5 text-slate-300 hover:text-[#10b981]" data-testid={`link-tag-${t}`}>
                        #{t}
                      </Link>
                    ))}
                  </div>
                )}
                {entry.sourceName && (
                  <span className="inline-flex items-center gap-1" title="Reference only. Source documents are not opened from the library.">
                    <FileText size={12} /> Source: <span className="text-slate-400">{entry.sourceName}</span>
                  </span>
                )}
              </footer>
            )}
          </article>
        )}
      </div>
    </AppShell>
  );
}
