import { useMemo, useRef, useState } from "react";
import { FileUp, Loader2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpsertDecorationMatrix,
  getListDecorationMatricesQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiError } from "./matrixGrid";
import { parseImportText } from "./importParse";

const PLACEHOLDER = `Upload a file above, or paste an export here.

CSV from the old app (id,name,data,…) works as-is. JSON also works — e.g.

[
  {
    "id": "…optional…",
    "data": {
      "name": "Screen Print",
      "xAxisLabel": "Colors",
      "xValues": [
        { "label": "1 Color", "breaks": [{ "qty": 24, "decorationCost": 3.5 }] }
      ]
    }
  }
]`;

export function ImportMatricesModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const upsert = useUpsertDecorationMatrix();

  const parsed = useMemo(() => parseImportText(text), [text]);

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    try {
      const content = await file.text();
      setText(content);
      setFileName(file.name);
    } catch {
      toast({
        title: "Couldn't read file",
        description: "Try again, or paste the file contents instead.",
        variant: "destructive",
      });
    }
  };

  const doImport = async () => {
    const items = parsed.items;
    if (items.length === 0) {
      toast({
        title: "Nothing to import",
        description:
          "Couldn't find any matrices — expected a CSV export (id,name,data columns) or matrix JSON.",
        variant: "destructive",
      });
      return;
    }
    setBusy(true);
    let ok = 0;
    let lastErr: unknown;
    for (const it of items) {
      try {
        await upsert.mutateAsync({ data: it });
        ok += 1;
      } catch (err) {
        lastErr = err;
      }
    }
    setBusy(false);
    queryClient.invalidateQueries({
      queryKey: getListDecorationMatricesQueryKey(),
    });
    const failed = items.length - ok;
    toast({
      title: ok > 0 ? `Imported ${ok} matri${ok === 1 ? "x" : "ces"}` : "Import failed",
      description:
        failed > 0
          ? `${failed} could not be imported${
              apiError(lastErr) ? ` — ${apiError(lastErr)}` : "."
            }`
          : undefined,
      variant: failed > 0 ? "destructive" : "default",
    });
    if (ok > 0) onClose();
  };

  const previewNames = parsed.items.map(
    (it) => it.data.name?.trim() || "(unnamed)",
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[#0f172a] border border-slate-800 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        <header className="flex items-center justify-between px-5 py-4 border-b border-slate-800 flex-shrink-0">
          <h2 className="text-base font-bold text-white">Import matrices</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-5 space-y-3 custom-scrollbar">
          <p className="text-xs text-slate-400 leading-relaxed">
            Upload a CSV exported from your old pricing tool (or paste CSV/JSON
            below). A matrix with a matching ID is updated in place, so
            re-importing the same file is safe and won't create duplicates.
          </p>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.json,.txt,text/csv,application/json,text/plain"
              className="hidden"
              onChange={(e) => {
                void onFileChosen(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
            >
              <FileUp size={13} />
              Choose file…
            </button>
            {fileName && (
              <span className="text-xs text-slate-400 truncate">{fileName}</span>
            )}
          </div>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setFileName(null);
            }}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            className="w-full h-56 bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-3 py-2.5 focus:outline-none focus:border-[#059669] resize-none custom-scrollbar"
          />
          {text.trim() && (
            <p
              className={`text-xs leading-relaxed ${
                parsed.items.length > 0 ? "text-[#10b981]" : "text-amber-400"
              }`}
            >
              {parsed.items.length > 0
                ? `Found ${parsed.items.length} matri${
                    parsed.items.length === 1 ? "x" : "ces"
                  }${parsed.format ? ` (${parsed.format.toUpperCase()})` : ""}: ${previewNames
                    .slice(0, 6)
                    .join(", ")}${previewNames.length > 6 ? "…" : ""}`
                : "No matrices recognized yet — expected a CSV export with id,name,data columns, or matrix JSON."}
            </p>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800 flex-shrink-0">
          <button
            onClick={onClose}
            className="text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={doImport}
            disabled={busy || parsed.items.length === 0}
            className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-50"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            Import{parsed.items.length > 0 ? ` ${parsed.items.length}` : ""}
          </button>
        </footer>
      </div>
    </div>
  );
}
