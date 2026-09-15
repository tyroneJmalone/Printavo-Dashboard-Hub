import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListKnowledgeSourcesQueryKey,
  type KnowledgeMergeCandidate,
  useBulkDeleteKnowledgeEntries,
  useCommitKnowledgeMerge,
  useListKnowledgeEntries,
  getListKnowledgeEntriesQueryKey,
  useCreateKnowledgeEntry,
  useUpdateKnowledgeEntry,
  useReviewKnowledgeEntry,
  useDeleteKnowledgeEntry,
  usePreviewKnowledgeMerge,
} from "@workspace/api-client-react";
import { useStaff } from "@/components/auth/StaffGate";
import { AppShell } from "@/components/layout/AppShell";
import { KnowledgeSources } from "@/components/knowledge/KnowledgeSources";
import { KnowledgePlayground } from "@/components/knowledge/KnowledgePlayground";
import { useToast } from "@/hooks/use-toast";
import {
  BookOpen,
  CheckCircle2,
  Archive,
  Trash2,
  Pencil,
  Plus,
  Search,
  Undo2,
  CalendarClock,
  AlertTriangle,
  Sparkles,
} from "lucide-react";

/**
 * Company knowledge base — the staff-reviewed facts the AI context layer
 * serves (policies, pricing rules, turnaround, capabilities). Only
 * APPROVED entries whose effective window covers today are ever given to
 * AI tools; drafts and archived entries are invisible to them.
 */

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-[#0f172a] border border-slate-800 rounded-xl p-4 ${className}`}>{children}</div>;
}

const inputCls =
  "bg-[#1e293b] border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#059669]";
const btnCls =
  "text-xs font-medium px-3 py-1.5 rounded-md bg-[#059669] hover:bg-[#047857] text-white disabled:opacity-50 disabled:cursor-not-allowed";
const btnGhost =
  "text-xs px-2.5 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-50";

const STATUS_BADGE: Record<string, string> = {
  approved: "bg-[#059669]/15 text-[#10b981]",
  draft: "bg-amber-500/15 text-amber-300",
  archived: "bg-slate-800 text-slate-500",
};

type EntryForm = {
  title: string;
  body: string;
  category: string;
  tags: string;
  sourceName: string;
  sourceUrl: string;
  effectiveDate: string;
  expiresDate: string;
};

const EMPTY_FORM: EntryForm = {
  title: "",
  body: "",
  category: "general",
  tags: "",
  sourceName: "",
  sourceUrl: "",
  effectiveDate: "",
  expiresDate: "",
};

const CATEGORY_SUGGESTIONS = ["general", "policy", "pricing", "production", "shipping", "faq"];

export default function KnowledgeBase() {
  const { role } = useStaff();
  const isAdmin = role === "admin";
  const qc = useQueryClient();
  const { toast } = useToast();

  const [statusFilter, setStatusFilter] = useState<"" | "draft" | "approved" | "archived">("");
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState<EntryForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EntryForm>(EMPTY_FORM);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [mergePreview, setMergePreview] = useState<{
    token: string;
    entryIds: string[];
    entries: NonNullable<typeof entries>;
    candidate: KnowledgeMergeCandidate;
    conflicts: string[];
  } | null>(null);
  const [mergeCandidate, setMergeCandidate] = useState<KnowledgeMergeCandidate | null>(null);

  const params = useMemo(
    () => ({
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(search.trim() ? { q: search.trim() } : {}),
    }),
    [statusFilter, search],
  );
  const { data: entries, isLoading } = useListKnowledgeEntries(params, {
    query: { queryKey: getListKnowledgeEntriesQueryKey(params) },
  });

  useEffect(() => {
    setSelectedIds(new Set());
    setMergePreview(null);
    setMergeCandidate(null);
  }, [statusFilter, search]);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListKnowledgeEntriesQueryKey(), exact: false });
  const invalidateSourceData = () => {
    qc.invalidateQueries({ queryKey: getListKnowledgeSourcesQueryKey() });
    qc.invalidateQueries({
      predicate: (query) =>
        typeof query.queryKey[0] === "string" &&
        query.queryKey[0].startsWith("/api/knowledge/sources/"),
    });
  };
  const invalidateKnowledgeData = () => {
    invalidate();
    invalidateSourceData();
  };

  const createEntry = useCreateKnowledgeEntry({
    mutation: {
      onSuccess: () => {
        setForm(EMPTY_FORM);
        setShowCreate(false);
        invalidate();
        toast({ title: "Entry created as draft", description: "Approve it to make it visible to AI tools." });
      },
      onError: (err: any) =>
        toast({ title: "Couldn't create entry", description: err?.error ?? String(err), variant: "destructive" }),
    },
  });
  const updateEntry = useUpdateKnowledgeEntry({
    mutation: {
      onSuccess: (updated) => {
        setEditingId(null);
        invalidate();
        toast({
          title: "Entry saved",
          description:
            updated.reviewStatus === "draft"
              ? "Content changed, so it went back to draft — re-approve to serve it to AI tools."
              : undefined,
        });
      },
      onError: (err: any) =>
        toast({ title: "Couldn't save entry", description: err?.error ?? String(err), variant: "destructive" }),
    },
  });
  const reviewEntry = useReviewKnowledgeEntry({
    mutation: {
      onSuccess: (updated) => {
        invalidate();
        toast({
          title:
            updated.reviewStatus === "approved"
              ? "Entry approved — now live for AI tools"
              : updated.reviewStatus === "archived"
                ? "Entry archived"
                : "Entry moved back to draft",
        });
      },
    },
  });
  const deleteEntry = useDeleteKnowledgeEntry({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Entry deleted" });
      },
    },
  });
  const bulkDeleteEntries = useBulkDeleteKnowledgeEntries({
    mutation: {
      onSuccess: (result) => {
        setSelectedIds(new Set());
        invalidateKnowledgeData();
        toast({
          title: `${result.selectedCount} entr${result.selectedCount === 1 ? "y" : "ies"} deleted`,
          description: result.approvedCount
            ? `${result.approvedCount} approved entr${result.approvedCount === 1 ? "y was" : "ies were"} permanently removed.`
            : undefined,
        });
      },
      onError: (err: any) =>
        toast({
          title: "Couldn't delete selected entries",
          description: err?.error ?? String(err),
          variant: "destructive",
        }),
    },
  });
  const previewMerge = usePreviewKnowledgeMerge({
    mutation: {
      onSuccess: (result) => {
        setMergePreview(result);
        setMergeCandidate(result.candidate);
      },
      onError: (err: any) =>
        toast({
          title: "Couldn't generate merge preview",
          description: err?.error ?? String(err),
          variant: "destructive",
        }),
    },
  });
  const commitMerge = useCommitKnowledgeMerge({
    mutation: {
      onSuccess: (result) => {
        setSelectedIds(new Set());
        setMergePreview(null);
        setMergeCandidate(null);
        invalidateKnowledgeData();
        toast({
          title: "Merged draft saved",
          description: `${result.deletedEntryIds.length} original entries were replaced; ${result.sourceLinkCount} source links preserved. Review and approve the new draft when ready.`,
        });
      },
      onError: (err: any) => {
        setMergePreview(null);
        setMergeCandidate(null);
        toast({
          title: "Merge was not saved",
          description: err?.error ?? String(err),
          variant: "destructive",
        });
      },
    },
  });

  const visibleEntries = entries ?? [];
  const selectedEntries = visibleEntries.filter((entry) => selectedIds.has(entry.id));
  const selectedApprovedCount = selectedEntries.filter((entry) => entry.reviewStatus === "approved").length;
  const allVisibleSelected = visibleEntries.length > 0 && visibleEntries.every((entry) => selectedIds.has(entry.id));
  const mergeApprovedCount =
    mergePreview?.entries.filter((entry) => entry.reviewStatus === "approved").length ?? 0;
  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleEntries.forEach((entry) => next.delete(entry.id));
      else visibleEntries.forEach((entry) => next.add(entry.id));
      return next;
    });
  };
  const requestBulkDelete = () => {
    if (!selectedEntries.length || bulkDeleteEntries.isPending) return;
    const approvedWarning =
      selectedApprovedCount > 0
        ? `\n\nWARNING: ${selectedApprovedCount} approved entr${selectedApprovedCount === 1 ? "y is" : "ies are"} currently live for AI tools and will be permanently removed.`
        : "";
    if (
      confirm(
        `Permanently delete ${selectedEntries.length} selected entr${selectedEntries.length === 1 ? "y" : "ies"}? This cannot be undone.${approvedWarning}`,
      )
    ) {
      bulkDeleteEntries.mutate({
        data: {
          entryIds: selectedEntries.map((entry) => entry.id),
          snapshots: selectedEntries.map((entry) => ({
            id: entry.id,
            updatedAt: new Date(entry.updatedAt).toISOString(),
            reviewStatus: entry.reviewStatus,
          })),
          confirm: true,
        },
      });
    }
  };
  const requestMergePreview = () => {
    if (selectedEntries.length < 2 || previewMerge.isPending || commitMerge.isPending) return;
    setMergePreview(null);
    setMergeCandidate(null);
    previewMerge.mutate({ data: { entryIds: selectedEntries.map((entry) => entry.id) } });
  };
  const requestMergeCommit = () => {
    if (!mergePreview || !mergeCandidate || commitMerge.isPending) return;
    if (
      confirm(
        `Save this edited draft as one replacement and permanently delete ${mergePreview.entryIds.length} originals?${mergeApprovedCount ? ` ${mergeApprovedCount} approved original${mergeApprovedCount === 1 ? " is" : "s are"} live for AI and will be replaced by a draft.` : ""} Originals remain untouched until you confirm.`,
      )
    ) {
      commitMerge.mutate({
        data: {
          token: mergePreview.token,
          entryIds: mergePreview.entryIds,
          candidate: mergeCandidate,
        },
      });
    }
  };

  const startEdit = (e: NonNullable<typeof entries>[number]) => {
    setEditingId(e.id);
    setEditForm({
      title: e.title,
      body: e.body,
      category: e.category,
      tags: e.tags.join(", "),
      sourceName: e.sourceName,
      sourceUrl: e.sourceUrl,
      effectiveDate: e.effectiveDate ?? "",
      expiresDate: e.expiresDate ?? "",
    });
  };

  const formToPayload = (f: EntryForm) => ({
    title: f.title.trim(),
    body: f.body.trim(),
    category: f.category.trim() || "general",
    tags: f.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20),
    sourceName: f.sourceName.trim(),
    sourceUrl: f.sourceUrl.trim(),
    effectiveDate: f.effectiveDate || null,
    expiresDate: f.expiresDate || null,
  });

  const entryFields = (f: EntryForm, set: (next: EntryForm) => void) => (
    <div className="space-y-2">
      <input
        className={`${inputCls} w-full`}
        placeholder="Title — e.g. Standard turnaround time"
        value={f.title}
        onChange={(e) => set({ ...f, title: e.target.value })}
      />
      <textarea
        className={`${inputCls} w-full min-h-[110px] leading-relaxed`}
        placeholder="The fact itself, written exactly as it should be quoted. This text is served verbatim to AI tools."
        value={f.body}
        onChange={(e) => set({ ...f, body: e.target.value })}
      />
      <div className="flex flex-wrap gap-2">
        <input
          className={`${inputCls} w-36`}
          placeholder="Category"
          list="kb-categories"
          value={f.category}
          onChange={(e) => set({ ...f, category: e.target.value })}
        />
        <datalist id="kb-categories">
          {CATEGORY_SUGGESTIONS.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <input
          className={`${inputCls} flex-1 min-w-[180px]`}
          placeholder="Tags, comma-separated"
          value={f.tags}
          onChange={(e) => set({ ...f, tags: e.target.value })}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <label className="text-[11px] text-slate-500">
          Effective from
          <input
            type="date"
            className={`${inputCls} block mt-0.5`}
            value={f.effectiveDate}
            onChange={(e) => set({ ...f, effectiveDate: e.target.value })}
          />
        </label>
        <label className="text-[11px] text-slate-500">
          Expires after
          <input
            type="date"
            className={`${inputCls} block mt-0.5`}
            value={f.expiresDate}
            onChange={(e) => set({ ...f, expiresDate: e.target.value })}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          className={`${inputCls} w-52`}
          placeholder="Source name (staff-only note)"
          value={f.sourceName}
          onChange={(e) => set({ ...f, sourceName: e.target.value })}
        />
        <input
          className={`${inputCls} flex-1 min-w-[180px]`}
          placeholder="Source URL (staff-only note)"
          value={f.sourceUrl}
          onChange={(e) => set({ ...f, sourceUrl: e.target.value })}
        />
      </div>
      <div className="text-[11px] text-slate-500">
        Source fields are reference breadcrumbs for staff only — AI tools never see them. The entry text above is the
        canonical fact.
      </div>
    </div>
  );

  return (
    <AppShell>
      <div className="p-4 lg:p-6 space-y-4 max-w-4xl">
        <div className="flex items-center gap-3">
          <BookOpen size={18} className="text-[#10b981]" />
          <h1 className="text-lg font-semibold text-white">Knowledge Base</h1>
          <div className="flex-1" />
          <button className={btnCls} onClick={() => setShowCreate((v) => !v)}>
            <span className="flex items-center gap-1.5">
              <Plus size={13} /> New entry
            </span>
          </button>
        </div>
        <div className="text-xs text-slate-500 -mt-2">
          Company facts served to AI assistants (email drafting, chat, quoting). Only <b>approved</b> entries within
          their effective dates are visible to AI — drafts and archived entries are not.
        </div>

        <KnowledgeSources />

        <KnowledgePlayground />

        {showCreate && (
          <Card>
            <div className="text-sm font-semibold text-slate-200 mb-3">New entry (starts as draft)</div>
            {entryFields(form, setForm)}
            <div className="flex gap-2 mt-3">
              <button
                className={btnCls}
                disabled={createEntry.isPending || form.title.trim().length < 3 || !form.body.trim()}
                onClick={() => createEntry.mutate({ data: formToPayload(form) })}
              >
                Create draft
              </button>
              <button className={btnGhost} onClick={() => setShowCreate(false)}>
                Cancel
              </button>
            </div>
          </Card>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {(["", "approved", "draft", "archived"] as const).map((s) => (
            <button
              key={s || "all"}
              className={`text-xs px-2.5 py-1.5 rounded-md border ${
                statusFilter === s
                  ? "border-[#059669]/40 bg-[#059669]/10 text-[#10b981]"
                  : "border-slate-800 text-slate-400 hover:text-slate-200 hover:bg-slate-800"
              }`}
              onClick={() => setStatusFilter(s)}
            >
              {s === "" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
          <div className="flex-1" />
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              className={`${inputCls} pl-8 w-56`}
              placeholder="Search entries…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {isAdmin && visibleEntries.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleAllVisible}
                className="accent-emerald-500"
                aria-label="Select all visible knowledge entries"
              />
              Select visible ({visibleEntries.length})
            </label>
            {selectedEntries.length > 0 && (
              <>
                <span className="text-xs text-slate-500">
                  {selectedEntries.length} selected
                  {selectedApprovedCount > 0 && ` · ${selectedApprovedCount} approved`}
                </span>
                <div className="flex-1" />
                <button
                  className={btnGhost}
                  disabled={selectedEntries.length < 2 || previewMerge.isPending || commitMerge.isPending}
                  onClick={requestMergePreview}
                >
                  <span className="flex items-center gap-1">
                    <Sparkles size={12} /> {previewMerge.isPending ? "Generating…" : "AI merge preview"}
                  </span>
                </button>
                <button
                  className="text-xs font-medium px-3 py-1.5 rounded-md border border-red-900/60 bg-red-950/30 text-red-300 hover:bg-red-900/40 disabled:opacity-50 disabled:cursor-not-allowed"
                  disabled={bulkDeleteEntries.isPending}
                  onClick={requestBulkDelete}
                >
                  <span className="flex items-center gap-1">
                    <Trash2 size={12} /> {bulkDeleteEntries.isPending ? "Deleting…" : "Delete selected"}
                  </span>
                </button>
              </>
            )}
          </div>
        )}

        {mergePreview && mergeCandidate && (
          <Card className="border-emerald-800/60 bg-emerald-950/10">
            <div className="flex items-start gap-2">
              <Sparkles size={16} className="mt-0.5 shrink-0 text-emerald-400" />
              <div>
                <div className="text-sm font-semibold text-slate-100">AI merge preview</div>
                <div className="mt-0.5 text-xs leading-relaxed text-slate-400">
                  Review and edit this candidate before saving. The {mergePreview.entries.length} originals remain unchanged
                  until you confirm; the replacement will always start as a draft.
                </div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {mergePreview.entries.map((entry) => (
                <span key={entry.id} className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-300">
                  {entry.title}
                </span>
              ))}
            </div>
            {mergePreview.conflicts.length > 0 && (
              <div className="mt-3 rounded-md border border-amber-700/40 bg-amber-500/10 p-2.5 text-xs text-amber-200">
                <div className="flex items-center gap-1.5 font-semibold">
                  <AlertTriangle size={13} /> Conflicts requiring review
                </div>
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {mergePreview.conflicts.map((conflict, index) => <li key={`${conflict}-${index}`}>{conflict}</li>)}
                </ul>
              </div>
            )}
            {mergeApprovedCount > 0 && (
              <div className="mt-3 flex items-start gap-1.5 rounded-md border border-red-800/50 bg-red-950/25 p-2.5 text-xs leading-relaxed text-red-200">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                <span>
                  {mergeApprovedCount} approved original{mergeApprovedCount === 1 ? " is" : "s are"} currently live for
                  AI tools. They will be removed only after confirmation, and the replacement will remain a draft until
                  separately approved.
                </span>
              </div>
            )}
            <div className="mt-3 space-y-2">
              <input
                className={`${inputCls} w-full`}
                value={mergeCandidate.title}
                onChange={(event) => setMergeCandidate({ ...mergeCandidate, title: event.target.value })}
                aria-label="Merged draft title"
              />
              <textarea
                className={`${inputCls} min-h-[180px] w-full leading-relaxed`}
                value={mergeCandidate.body}
                onChange={(event) => setMergeCandidate({ ...mergeCandidate, body: event.target.value })}
                aria-label="Merged draft body"
              />
              <div className="flex flex-wrap gap-2">
                <input
                  className={`${inputCls} w-36`}
                  value={mergeCandidate.category}
                  onChange={(event) => setMergeCandidate({ ...mergeCandidate, category: event.target.value })}
                  placeholder="Category"
                  aria-label="Merged draft category"
                />
                <input
                  className={`${inputCls} min-w-[180px] flex-1`}
                  value={mergeCandidate.tags.join(", ")}
                  onChange={(event) =>
                    setMergeCandidate({
                      ...mergeCandidate,
                      tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean),
                    })
                  }
                  placeholder="Tags, comma-separated"
                  aria-label="Merged draft tags"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <label className="text-[11px] text-slate-500">
                  Effective from
                  <input
                    type="date"
                    className={`${inputCls} mt-0.5 block`}
                    value={mergeCandidate.effectiveDate ?? ""}
                    onChange={(event) =>
                      setMergeCandidate({ ...mergeCandidate, effectiveDate: event.target.value || null })
                    }
                  />
                </label>
                <label className="text-[11px] text-slate-500">
                  Expires after
                  <input
                    type="date"
                    className={`${inputCls} mt-0.5 block`}
                    value={mergeCandidate.expiresDate ?? ""}
                    onChange={(event) =>
                      setMergeCandidate({ ...mergeCandidate, expiresDate: event.target.value || null })
                    }
                  />
                </label>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className={btnCls}
                disabled={
                  commitMerge.isPending ||
                  mergeCandidate.title.trim().length < 3 ||
                  !mergeCandidate.body.trim() ||
                  !mergeCandidate.category.trim()
                }
                onClick={requestMergeCommit}
              >
                {commitMerge.isPending ? "Saving replacement…" : "Confirm save replacement"}
              </button>
              <button
                className={btnGhost}
                disabled={commitMerge.isPending}
                onClick={() => {
                  setMergePreview(null);
                  setMergeCandidate(null);
                }}
              >
                Cancel preview
              </button>
            </div>
          </Card>
        )}

        <div className="space-y-2">
          {isLoading && <div className="text-sm text-slate-500">Loading…</div>}
          {entries?.map((e) => (
            <Card key={e.id} className="!p-3.5">
              {editingId === e.id ? (
                <>
                  {entryFields(editForm, setEditForm)}
                  <div className="flex gap-2 mt-3">
                    <button
                      className={btnCls}
                      disabled={updateEntry.isPending || editForm.title.trim().length < 3 || !editForm.body.trim()}
                      onClick={() => updateEntry.mutate({ id: e.id, data: formToPayload(editForm) })}
                    >
                      Save
                    </button>
                    <button className={btnGhost} onClick={() => setEditingId(null)}>
                      Cancel
                    </button>
                    {e.reviewStatus === "approved" && (
                      <span className="text-[11px] text-amber-400 self-center">
                        Saving content changes sends this back to draft for re-approval.
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    {isAdmin && (
                      <input
                        type="checkbox"
                        checked={selectedIds.has(e.id)}
                        onChange={() => toggleSelected(e.id)}
                        className="accent-emerald-500"
                        aria-label={`Select ${e.title}`}
                      />
                    )}
                    <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded font-bold ${STATUS_BADGE[e.reviewStatus] ?? ""}`}>
                      {e.reviewStatus}
                    </span>
                    <span className="text-sm font-semibold text-slate-100">{e.title}</span>
                    <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">{e.category}</span>
                    {(e.effectiveDate || e.expiresDate) && (
                      <span className="flex items-center gap-1 text-[10px] text-slate-500">
                        <CalendarClock size={11} />
                        {e.effectiveDate ?? "…"} → {e.expiresDate ?? "no expiry"}
                      </span>
                    )}
                    <div className="flex-1" />
                    {e.reviewStatus !== "approved" && (
                      <button
                        className={btnGhost}
                        title="Approve — makes this entry live for AI tools"
                        disabled={reviewEntry.isPending}
                        onClick={() => reviewEntry.mutate({ id: e.id, data: { action: "approve" } })}
                      >
                        <span className="flex items-center gap-1 text-[#10b981]">
                          <CheckCircle2 size={12} /> Approve
                        </span>
                      </button>
                    )}
                    {e.reviewStatus === "approved" && (
                      <button
                        className={btnGhost}
                        title="Archive — removes from AI without deleting"
                        disabled={reviewEntry.isPending}
                        onClick={() => reviewEntry.mutate({ id: e.id, data: { action: "archive" } })}
                      >
                        <span className="flex items-center gap-1">
                          <Archive size={12} /> Archive
                        </span>
                      </button>
                    )}
                    {e.reviewStatus === "archived" && (
                      <button
                        className={btnGhost}
                        disabled={reviewEntry.isPending}
                        onClick={() => reviewEntry.mutate({ id: e.id, data: { action: "redraft" } })}
                      >
                        <span className="flex items-center gap-1">
                          <Undo2 size={12} /> Restore draft
                        </span>
                      </button>
                    )}
                    <button className={btnGhost} onClick={() => startEdit(e)}>
                      <span className="flex items-center gap-1">
                        <Pencil size={12} /> Edit
                      </span>
                    </button>
                    {isAdmin && (
                      <button
                        className="p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-slate-800"
                        title="Delete permanently (admin)"
                        onClick={() => {
                          if (confirm(`Delete "${e.title}" permanently?`)) deleteEntry.mutate({ id: e.id });
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                  <div className="text-sm text-slate-300 mt-2 whitespace-pre-wrap leading-relaxed">{e.body}</div>
                   {e.sourceStale && (
                     <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-700/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-300">
                       <CalendarClock size={12} className="mt-0.5 shrink-0" />
                       The linked source changed or was removed. Review this approved text before relying on it.
                     </div>
                   )}
                  <div className="text-[11px] text-slate-600 mt-2 flex flex-wrap gap-x-4 gap-y-0.5">
                    {e.tags.length > 0 && <span>tags: {e.tags.join(", ")}</span>}
                    {e.sourceName && <span>source: {e.sourceName}</span>}
                    {e.approvedByEmail && e.reviewStatus === "approved" && (
                      <span>
                        approved by {e.approvedByEmail}
                        {e.approvedAt ? ` on ${new Date(e.approvedAt).toLocaleDateString()}` : ""}
                      </span>
                    )}
                    <span>updated {new Date(e.updatedAt).toLocaleString()}</span>
                  </div>
                </>
              )}
            </Card>
          ))}
          {entries && entries.length === 0 && (
            <Card>
              <div className="text-sm text-slate-500">
                No entries{statusFilter || search ? " match the current filter" : " yet — add the first company fact above"}.
              </div>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}
