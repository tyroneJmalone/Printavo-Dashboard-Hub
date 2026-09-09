import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListKnowledgeSourcesQueryKey,
  getListKnowledgeSourceDocumentsQueryKey,
  useCreateGoogleDriveKnowledgeSource,
  useDeleteKnowledgeSource,
  useListKnowledgeSourceDocuments,
  useListKnowledgeSources,
  useSyncGoogleDriveKnowledgeSource,
  useUpdateKnowledgeSource,
} from "@workspace/api-client-react";
import { useStaff } from "@/components/auth/StaffGate";
import { useToast } from "@/hooks/use-toast";
import {
  AlertTriangle,
  ChevronDown,
  FileText,
  FileUp,
  FolderSync,
  Pause,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";

const inputClass =
  "bg-[#1e293b] border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#059669]";
const primaryButton =
  "text-xs font-medium px-3 py-1.5 rounded-md bg-[#059669] hover:bg-[#047857] text-white disabled:opacity-50 disabled:cursor-not-allowed";
const ghostButton =
  "text-xs px-2.5 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-50";

function errorMessage(error: unknown): string {
  if (error && typeof error === "object" && "error" in error) return String(error.error);
  return error instanceof Error ? error.message : String(error);
}

export function KnowledgeSources() {
  const { role } = useStaff();
  const isAdmin = role === "admin";
  const qc = useQueryClient();
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [uploadName, setUploadName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [uploading, setUploading] = useState(false);
  const [driveFolder, setDriveFolder] = useState("");
  const [driveName, setDriveName] = useState("");
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);

  const { data: sources = [], isLoading } = useListKnowledgeSources();
  const documents = useListKnowledgeSourceDocuments(openSourceId ?? "", {
    query: {
      queryKey: getListKnowledgeSourceDocumentsQueryKey(openSourceId ?? ""),
      enabled: Boolean(openSourceId),
    },
  });

  const invalidateSources = () =>
    qc.invalidateQueries({ queryKey: getListKnowledgeSourcesQueryKey() });
  const invalidateDocuments = (sourceId: string) =>
    qc.invalidateQueries({ queryKey: getListKnowledgeSourceDocumentsQueryKey(sourceId) });

  const createDrive = useCreateGoogleDriveKnowledgeSource({
    mutation: {
      onSuccess: (source) => {
        setDriveFolder("");
        setDriveName("");
        invalidateSources();
        setOpenSourceId(source.id);
        toast({
          title: "Drive folder connected",
          description: "Use Sync now to import its supported documents as drafts.",
        });
      },
      onError: (error) =>
        toast({ title: "Couldn't connect folder", description: errorMessage(error), variant: "destructive" }),
    },
  });

  const updateSource = useUpdateKnowledgeSource({
    mutation: {
      onSuccess: invalidateSources,
      onError: (error) =>
        toast({ title: "Couldn't update source", description: errorMessage(error), variant: "destructive" }),
    },
  });

  const syncSource = useSyncGoogleDriveKnowledgeSource({
    mutation: {
      onSuccess: (result) => {
        invalidateSources();
        invalidateDocuments(result.sourceId);
        qc.invalidateQueries({ queryKey: ["/api/knowledge/entries"], exact: false });
        toast({
          title: "Drive sync complete",
          description: `${result.documents} supported document${result.documents === 1 ? "" : "s"} checked; ${result.drafts} new draft${result.drafts === 1 ? "" : "s"} created.`,
        });
      },
      onError: (error) =>
        toast({ title: "Drive sync failed", description: errorMessage(error), variant: "destructive" }),
    },
  });

  const deleteSource = useDeleteKnowledgeSource({
    mutation: {
      onSuccess: () => {
        setOpenSourceId(null);
        invalidateSources();
        qc.invalidateQueries({ queryKey: ["/api/knowledge/entries"], exact: false });
        toast({
          title: "Source removed",
          description: "Approved entries were kept and flagged for review.",
        });
      },
      onError: (error) =>
        toast({ title: "Couldn't remove source", description: errorMessage(error), variant: "destructive" }),
    },
  });

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      if (uploadName.trim()) body.append("name", uploadName.trim());
      if (sourceUrl.trim()) body.append("sourceUrl", sourceUrl.trim());
      const response = await fetch("/api/knowledge/sources/upload", {
        method: "POST",
        body,
        credentials: "include",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Upload failed");
      setFile(null);
      setUploadName("");
      setSourceUrl("");
      invalidateSources();
      qc.invalidateQueries({ queryKey: ["/api/knowledge/entries"], exact: false });
      toast({
        title: payload.idempotent ? "Document already imported" : "Document imported",
        description: `${payload.draftCount ?? 0} draft${payload.draftCount === 1 ? "" : "s"} ready for human review.`,
      });
    } catch (error) {
      toast({ title: "Couldn't import document", description: errorMessage(error), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-[#0f172a] p-4">
      <div className="flex items-start gap-3">
        <FolderSync size={17} className="mt-0.5 text-[#10b981]" />
        <div>
          <h2 className="text-sm font-semibold text-slate-100">Source documents</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
            AI extracts focused suggestions, but imports create drafts only. Nothing becomes available to AI until a person reviews and approves it.
          </p>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-950/35 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-300">
            <FileUp size={14} /> Upload a document
          </div>
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md,.csv"
            className="block w-full text-xs text-slate-400 file:mr-3 file:rounded-md file:border-0 file:bg-slate-800 file:px-3 file:py-1.5 file:text-xs file:text-slate-200"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <input className={inputClass} placeholder="Display name (optional)" value={uploadName} onChange={(event) => setUploadName(event.target.value)} />
            <input className={inputClass} placeholder="Reference URL (optional)" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[10px] text-slate-600">PDF, DOCX, TXT, MD, or CSV · 15 MB max</span>
            <button className={primaryButton} disabled={!file || uploading} onClick={upload}>
              {uploading ? "Extracting…" : "Import drafts"}
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/35 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-300">
            <FolderSync size={14} /> Google Drive folder
          </div>
          <input className={`${inputClass} w-full`} placeholder="Paste a Google Drive folder URL or ID" value={driveFolder} onChange={(event) => setDriveFolder(event.target.value)} />
          <div className="mt-2 flex gap-2">
            <input className={`${inputClass} min-w-0 flex-1`} placeholder="Display name (optional)" value={driveName} onChange={(event) => setDriveName(event.target.value)} />
            <button
              className={primaryButton}
              disabled={!driveFolder.trim() || createDrive.isPending}
              onClick={() => createDrive.mutate({ data: { folderId: driveFolder.trim(), name: driveName.trim() || undefined } })}
            >
              {createDrive.isPending ? "Checking…" : "Connect"}
            </button>
          </div>
          <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
            Only the selected folder and its subfolders are read. Sync processes new or changed files and flags deleted sources.
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {isLoading && <div className="text-xs text-slate-500">Loading sources…</div>}
        {sources.filter((source) => source.status !== "deleted").map((source) => {
          const open = openSourceId === source.id;
          const syncing = syncSource.isPending && syncSource.variables?.id === source.id;
          return (
            <div key={source.id} className="overflow-hidden rounded-lg border border-slate-800 bg-slate-950/25">
              <div className="flex flex-wrap items-center gap-2 p-3">
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpenSourceId(open ? null : source.id)}>
                  <ChevronDown size={14} className={`shrink-0 text-slate-500 transition-transform ${open ? "rotate-180" : ""}`} />
                  {source.kind === "google_drive" ? <FolderSync size={14} className="shrink-0 text-blue-400" /> : <FileText size={14} className="shrink-0 text-slate-400" />}
                  <span className="truncate text-sm font-medium text-slate-200">{source.name}</span>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    source.status === "error" ? "bg-red-500/15 text-red-300" :
                    source.status === "paused" ? "bg-amber-500/15 text-amber-300" :
                    source.status === "syncing" ? "bg-blue-500/15 text-blue-300" :
                    "bg-emerald-500/15 text-emerald-300"
                  }`}>{source.status}</span>
                </button>
                {source.kind === "google_drive" && source.status !== "paused" && (
                  <button className={ghostButton} disabled={syncing || source.status === "syncing"} onClick={() => syncSource.mutate({ id: source.id })}>
                    <span className="flex items-center gap-1"><RefreshCw size={12} className={syncing ? "animate-spin" : ""} /> Sync now</span>
                  </button>
                )}
                {source.kind === "google_drive" && (
                  <button
                    className={ghostButton}
                    disabled={updateSource.isPending || source.status === "syncing"}
                    onClick={() => updateSource.mutate({ id: source.id, data: { status: source.status === "paused" ? "active" : "paused" } })}
                  >
                    <span className="flex items-center gap-1">{source.status === "paused" ? <Play size={12} /> : <Pause size={12} />}{source.status === "paused" ? "Resume" : "Pause"}</span>
                  </button>
                )}
                {isAdmin && (
                  <button
                    className="rounded-md p-1.5 text-slate-500 hover:bg-slate-800 hover:text-red-400"
                    title="Remove source and flag its approved entries for review"
                    onClick={() => confirm(`Remove "${source.name}"? Approved entries will be kept but flagged as stale.`) && deleteSource.mutate({ id: source.id })}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
              {source.lastError && (
                <div className="mx-3 mb-3 flex items-start gap-2 rounded-md border border-red-900/40 bg-red-950/25 px-2.5 py-2 text-xs text-red-300">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {source.lastError}
                </div>
              )}
              {open && (
                <div className="border-t border-slate-800 px-3 py-2">
                  {source.sourceUrl && <a href={source.sourceUrl} target="_blank" rel="noreferrer" className="text-[11px] text-blue-400 hover:underline">Open original source</a>}
                  {documents.isLoading && <div className="mt-2 text-xs text-slate-500">Loading documents…</div>}
                  <div className="mt-2 space-y-1">
                    {documents.data?.map((document) => (
                      <div key={document.id} className="flex flex-wrap items-center gap-2 rounded-md bg-slate-900/70 px-2.5 py-2 text-xs">
                        <FileText size={12} className="text-slate-500" />
                        <span className="min-w-0 flex-1 truncate text-slate-300">{document.name}</span>
                        <span className="text-slate-500">{document.draftCount} drafts</span>
                        {document.staleEntryCount > 0 && (
                          <span className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">
                            <AlertTriangle size={10} /> {document.staleEntryCount} stale
                          </span>
                        )}
                        <span className="text-[10px] text-slate-600">{new Date(document.updatedAt).toLocaleString()}</span>
                      </div>
                    ))}
                    {documents.data?.length === 0 && <div className="text-xs text-slate-600">No supported documents imported yet.</div>}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!isLoading && sources.filter((source) => source.status !== "deleted").length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-800 px-3 py-4 text-center text-xs text-slate-600">
            No source documents connected yet.
          </div>
        )}
      </div>
    </section>
  );
}