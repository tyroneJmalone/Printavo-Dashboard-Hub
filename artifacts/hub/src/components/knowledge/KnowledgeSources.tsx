import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListKnowledgeEntriesQueryKey,
  getListKnowledgeSourcesQueryKey,
  getListKnowledgeSourceDocumentsQueryKey,
  type KnowledgeSourceDocument,
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  ChevronDown,
  Eye,
  FileText,
  FileUp,
  FolderSync,
  Pause,
  Play,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { customFetch } from "../../../../../lib/api-client-react/src/custom-fetch";

const inputClass =
  "bg-[#1e293b] border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#059669]";
const primaryButton =
  "text-xs font-medium px-3 py-1.5 rounded-md bg-[#059669] hover:bg-[#047857] text-white disabled:opacity-50 disabled:cursor-not-allowed";
const ghostButton =
  "text-xs px-2.5 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-50";

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as {
      error?: unknown;
      message?: unknown;
      data?: { error?: unknown; message?: unknown };
    };
    if (typeof value.data?.error === "string") return value.data.error;
    if (typeof value.data?.message === "string") return value.data.message;
    if (typeof value.error === "string") return value.error;
    if (typeof value.message === "string") return value.message;
  }
  return String(error);
}

type DocumentPreview = {
  id: string;
  name: string;
  status: string;
  text: string;
  draftCount: number;
  error: string | null;
};

type RetryDocumentResponse = {
  draftCount: number;
};

type UploadResponse = {
  source?: { id: string };
  documentId: string;
  draftCount: number;
  idempotent?: boolean;
};

function DocumentTextDialog({
  document,
  open,
  onOpenChange,
}: {
  document: KnowledgeSourceDocument | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !document) return;

    let cancelled = false;
    setLoading(true);
    setPreview(null);
    setPreviewError(null);

    customFetch<DocumentPreview>(
      `/api/knowledge/documents/${encodeURIComponent(document.id)}/preview`,
      { method: "GET", responseType: "json" },
    )
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((error: unknown) => {
        if (!cancelled) setPreviewError(errorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [document?.id, open]);

  if (!document) return null;

  const status = preview?.status ?? document.status;
  const draftCount = preview?.draftCount ?? document.draftCount;
  const ingestionError = preview?.error || document.lastError;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(85vh,680px)] w-[calc(100%-2rem)] max-w-3xl flex-col gap-3 overflow-hidden border-slate-800 bg-slate-950 p-4 text-slate-100 sm:p-5"
        data-testid={`dialog-document-preview-${document.id}`}
      >
        <DialogHeader className="shrink-0 pr-7">
          <DialogTitle className="flex items-center gap-2 text-sm text-slate-100">
            <FileText size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
            <span className="min-w-0 break-words">{preview?.name ?? document.name}</span>
          </DialogTitle>
          <DialogDescription className="text-left text-xs text-slate-500">
            Extracted source text for review. Imports create drafts; approve those drafts before Test knowledge base can retrieve them.
          </DialogDescription>
        </DialogHeader>

        <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11px] text-slate-400" data-testid={`metadata-document-preview-${document.id}`}>
          <span className="rounded bg-slate-800 px-2 py-1">
            Status: <strong className="font-medium text-slate-200">{status}</strong>
          </span>
          <span className="rounded bg-slate-800 px-2 py-1">
            Drafts: <strong className="font-medium text-slate-200">{draftCount}</strong>
          </span>
          <span className="max-w-full break-all rounded bg-slate-800 px-2 py-1">{document.mimeType}</span>
          <span className="rounded bg-slate-800 px-2 py-1">
            Updated {new Date(document.updatedAt).toLocaleString()}
          </span>
        </div>

        {ingestionError && (
          <div
            className="flex shrink-0 items-start gap-2 rounded-md border border-red-900/50 bg-red-950/30 px-2.5 py-2 text-xs leading-relaxed text-red-200"
            data-testid={`error-document-ingestion-${document.id}`}
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-300" aria-hidden="true" />
            <span>
              <strong className="font-semibold">Ingestion error:</strong> {ingestionError}
            </span>
          </div>
        )}

        <div
          className="min-h-0 flex-1 overflow-y-auto rounded-md border border-slate-800 bg-slate-900/70 p-3"
          data-testid={`text-document-preview-${document.id}`}
        >
          {loading && <div className="text-xs text-slate-400" data-testid={`loading-document-preview-${document.id}`}>Loading extracted text…</div>}
          {!loading && previewError && (
            <div className="flex items-start gap-2 text-xs leading-relaxed text-red-300" data-testid={`error-document-preview-${document.id}`}>
              <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>Couldn’t load extracted text: {previewError}</span>
            </div>
          )}
          {!loading && !previewError && !preview?.text.trim() && (
            <div className="text-xs leading-relaxed text-slate-500" data-testid={`empty-document-preview-${document.id}`}>
              No extracted text is available for this document.
            </div>
          )}
          {!loading && !previewError && preview?.text.trim() && (
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-slate-300" data-testid={`content-document-preview-${document.id}`}>
              {preview.text}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
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
  const [previewDocument, setPreviewDocument] = useState<KnowledgeSourceDocument | null>(null);
  const [retryingDocumentId, setRetryingDocumentId] = useState<string | null>(null);

  const {
    data: sources = [],
    isLoading,
    isError: sourcesIsError,
    error: sourcesError,
  } = useListKnowledgeSources();
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
  const invalidateKnowledgeEntries = () =>
    qc.invalidateQueries({ queryKey: getListKnowledgeEntriesQueryKey(), exact: false });

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

  const retryDocument = async (document: KnowledgeSourceDocument) => {
    const hasExistingDrafts = document.draftCount > 0;
    if (
      hasExistingDrafts &&
      !window.confirm(
        `Regenerate the ${document.draftCount} existing draft${document.draftCount === 1 ? "" : "s"} for "${document.name}"? Only unapproved, document-only drafts can be replaced; approved or shared entries will be preserved.`,
      )
    ) {
      return;
    }
    setRetryingDocumentId(document.id);
    try {
      const result = await customFetch<RetryDocumentResponse>(
        `/api/knowledge/documents/${encodeURIComponent(document.id)}/retry`,
        { method: "POST", responseType: "json" },
      );
      const documentsKey = getListKnowledgeSourceDocumentsQueryKey(document.sourceId);
      await invalidateDocuments(document.sourceId);
      await qc.refetchQueries({ queryKey: documentsKey, type: "active" });
      await invalidateKnowledgeEntries();
      toast({
        title: document.draftCount > 0 ? "Drafts regenerated" : "Document retried",
        description: `${result.draftCount} draft${result.draftCount === 1 ? "" : "s"} ready for human review.`,
      });
    } catch (error) {
      toast({ title: "Couldn't retry document", description: errorMessage(error), variant: "destructive" });
    } finally {
      setRetryingDocumentId(null);
    }
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      if (uploadName.trim()) body.append("name", uploadName.trim());
      if (sourceUrl.trim()) body.append("sourceUrl", sourceUrl.trim());
      const payload = await customFetch<UploadResponse>("/api/knowledge/sources/upload", {
        method: "POST",
        body,
        responseType: "json",
      });
      setFile(null);
      setUploadName("");
      setSourceUrl("");
      await invalidateSources();
      if (payload.source?.id) {
        setOpenSourceId(payload.source.id);
        const documentsKey = getListKnowledgeSourceDocumentsQueryKey(payload.source.id);
        await invalidateDocuments(payload.source.id);
        await qc.refetchQueries({ queryKey: documentsKey, type: "active" });
      }
      await invalidateKnowledgeEntries();
      toast({
        title: payload.idempotent ? "Document already imported" : "Document imported",
        description: `${payload.draftCount ?? 0} draft${payload.draftCount === 1 ? "" : "s"} ready for human review. Approve drafts before Test knowledge base can retrieve them.`,
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
            AI extracts focused suggestions, but imports create drafts only. Approve drafts in the knowledge entries list before Test knowledge base can retrieve them; there is no automatic approval.
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
             <button className={primaryButton} data-testid="button-import-knowledge-drafts" disabled={!file || uploading} onClick={upload}>
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
        {sourcesIsError && (
          <div className="flex items-start gap-2 rounded-md border border-red-900/40 bg-red-950/25 px-2.5 py-2 text-xs text-red-300" data-testid="error-knowledge-sources">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>Couldn’t load source documents: {errorMessage(sourcesError)}</span>
          </div>
        )}
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
                   {documents.isError && (
                     <div className="mt-2 flex items-start gap-2 rounded-md border border-red-900/40 bg-red-950/25 px-2.5 py-2 text-xs text-red-300" data-testid={`error-source-documents-${source.id}`}>
                       <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                       <span>Couldn’t load documents: {errorMessage(documents.error)}</span>
                     </div>
                   )}
                  <div className="mt-2 space-y-1">
                    {documents.data?.map((document) => (
                       <div key={document.id} className="rounded-md bg-slate-900/70 px-2.5 py-2 text-xs" data-testid={`row-source-document-${document.id}`}>
                         <div className="flex flex-wrap items-center gap-2">
                           <FileText size={12} className="text-slate-500" aria-hidden="true" />
                           <span className="min-w-0 flex-1 truncate text-slate-300">{document.name}</span>
                           <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                             document.status === "error" ? "bg-red-500/15 text-red-300" :
                             document.status === "processing" ? "bg-blue-500/15 text-blue-300" :
                             document.status === "stale" ? "bg-amber-500/15 text-amber-300" :
                             "bg-emerald-500/15 text-emerald-300"
                           }`} data-testid={`status-document-${document.id}`}>{document.status}</span>
                           <span className="text-slate-500" data-testid={`draft-count-document-${document.id}`}>{document.draftCount} drafts</span>
                           {document.staleEntryCount > 0 && (
                             <span className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">
                               <AlertTriangle size={10} aria-hidden="true" /> {document.staleEntryCount} stale
                             </span>
                           )}
                           <span className="text-[10px] text-slate-600">{new Date(document.updatedAt).toLocaleString()}</span>
                           {isAdmin && (
                             <button
                               className={ghostButton}
                               data-testid={`button-view-document-text-${document.id}`}
                               onClick={() => setPreviewDocument(document)}
                             >
                               <span className="flex items-center gap-1"><Eye size={12} aria-hidden="true" /> View text</span>
                             </button>
                           )}
                            {isAdmin && document.status !== "deleted" && (document.status === "error" || document.lastError || document.status === "active" || document.status === "stale") && (
                             <button
                               className={ghostButton}
                               data-testid={`button-retry-document-${document.id}`}
                               disabled={retryingDocumentId === document.id}
                               onClick={() => void retryDocument(document)}
                             >
                                <span className="flex items-center gap-1"><RefreshCw size={12} className={retryingDocumentId === document.id ? "animate-spin" : ""} aria-hidden="true" /> {retryingDocumentId === document.id ? "Regenerating…" : document.draftCount > 0 ? "Regenerate drafts" : "Retry"}</span>
                             </button>
                           )}
                         </div>
                         {document.lastError && (
                           <div className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed text-red-300" data-testid={`error-document-${document.id}`}>
                             <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                             <span><strong className="font-semibold">Ingestion error:</strong> {document.lastError}</span>
                           </div>
                         )}
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
      <DocumentTextDialog
        document={previewDocument}
        open={Boolean(previewDocument)}
        onOpenChange={(open) => {
          if (!open) setPreviewDocument(null);
        }}
      />
    </section>
  );
}