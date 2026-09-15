import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListKnowledgeEntries,
  getListKnowledgeEntriesQueryKey,
  useCreateKnowledgeEntry,
  useUpdateKnowledgeEntry,
  useReviewKnowledgeEntry,
  useDeleteKnowledgeEntry,
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

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getListKnowledgeEntriesQueryKey(), exact: false });

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
