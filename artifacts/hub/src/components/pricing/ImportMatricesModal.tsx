import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpsertDecorationMatrix,
  getListDecorationMatricesQueryKey,
  type DecorationMatrixData,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiError, UUID_RE } from "./matrixGrid";

interface ImportItem {
  id?: string;
  data: DecorationMatrixData;
}

function isDataShape(v: unknown): v is DecorationMatrixData {
  return (
    !!v &&
    typeof v === "object" &&
    Array.isArray((v as { xValues?: unknown }).xValues)
  );
}

/** Accept an array, a {matrices:[…]} envelope, a single matrix, or a raw data shape. */
function normalizeImport(parsed: unknown): ImportItem[] {
  let list: unknown[];
  if (Array.isArray(parsed)) list = parsed;
  else if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { matrices?: unknown }).matrices)
  )
    list = (parsed as { matrices: unknown[] }).matrices;
  else list = [parsed];

  const items: ImportItem[] = [];
  for (const el of list) {
    if (!el || typeof el !== "object") continue;
    const rec = el as { id?: unknown; data?: unknown };
    const validId =
      typeof rec.id === "string" && UUID_RE.test(rec.id) ? rec.id : undefined;
    if (isDataShape(rec.data)) {
      items.push({ id: validId, data: rec.data });
    } else if (isDataShape(el)) {
      items.push({ data: el });
    }
  }
  return items;
}

const PLACEHOLDER = `Paste JSON here — e.g.

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
  const [busy, setBusy] = useState(false);
  const upsert = useUpsertDecorationMatrix();

  const doImport = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      toast({
        title: "Invalid JSON",
        description: "That doesn't parse as JSON — check for typos.",
        variant: "destructive",
      });
      return;
    }
    const items = normalizeImport(parsed);
    if (items.length === 0) {
      toast({
        title: "Nothing to import",
        description: "Couldn't find any matrices in that JSON.",
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
            Paste matrices exported from your existing pricing tool. A matrix
            with a matching ID is updated in place; anything else is created
            fresh.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            className="w-full h-64 bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono rounded-lg px-3 py-2.5 focus:outline-none focus:border-[#059669] resize-none custom-scrollbar"
          />
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
            disabled={busy || !text.trim()}
            className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-50"
          >
            {busy && <Loader2 size={13} className="animate-spin" />}
            Import
          </button>
        </footer>
      </div>
    </div>
  );
}
