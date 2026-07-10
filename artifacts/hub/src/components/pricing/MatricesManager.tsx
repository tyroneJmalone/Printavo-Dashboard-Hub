import { useState } from "react";
import {
  Copy,
  Download,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDecorationMatrices,
  getListDecorationMatricesQueryKey,
  useUpsertDecorationMatrix,
  useDeleteDecorationMatrix,
  type DecorationMatrix,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiError, starterMatrices, toGrid } from "./matrixGrid";
import { MatrixEditorModal } from "./MatrixEditorModal";
import { ImportMatricesModal } from "./ImportMatricesModal";

const money = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function MatrixPreview({ matrix }: { matrix: DecorationMatrix }) {
  const g = toGrid(matrix.data);
  return (
    <div className="overflow-x-auto border border-slate-800 rounded-lg">
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-slate-900/60">
            <th className="px-2.5 py-1.5 text-left text-[9px] font-bold uppercase tracking-wider text-slate-500 whitespace-nowrap">
              Qty ⁄ {g.xAxisLabel}
            </th>
            {g.columns.map((c, ci) => (
              <th
                key={ci}
                className="px-2.5 py-1.5 text-right text-slate-300 font-semibold whitespace-nowrap"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {g.tiers.map((t, ti) => (
            <tr key={ti} className="border-t border-slate-800">
              <td className="px-2.5 py-1.5 font-mono text-slate-400 whitespace-nowrap">
                ≥ {t}
              </td>
              {g.columns.map((_, ci) => (
                <td
                  key={ci}
                  className="px-2.5 py-1.5 text-right font-mono text-slate-200"
                >
                  ${money(g.costs[ti][ci])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MatricesManager() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useListDecorationMatrices({
    query: { queryKey: getListDecorationMatricesQueryKey() },
  });

  const [editing, setEditing] = useState<DecorationMatrix | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: getListDecorationMatricesQueryKey(),
    });

  const upsert = useUpsertDecorationMatrix();
  const del = useDeleteDecorationMatrix({
    mutation: {
      onSuccess: () => invalidate(),
      onError: (err) =>
        toast({
          title: "Could not delete matrix",
          description: apiError(err) ?? "Delete failed",
          variant: "destructive",
        }),
    },
  });

  const matrices = data?.matrices ?? [];

  const openNew = () => {
    setEditing(null);
    setEditorOpen(true);
  };
  const openEdit = (m: DecorationMatrix) => {
    setEditing(m);
    setEditorOpen(true);
  };

  const duplicate = async (m: DecorationMatrix) => {
    try {
      await upsert.mutateAsync({
        data: { data: { ...m.data, name: `${m.data.name} (copy)` } },
      });
      invalidate();
      toast({ title: "Matrix duplicated" });
    } catch (err) {
      toast({
        title: "Could not duplicate matrix",
        description: apiError(err) ?? "Duplicate failed",
        variant: "destructive",
      });
    }
  };

  const loadStarters = async () => {
    if (
      !window.confirm(
        "Add 2 example matrices (Screen Print and Embroidery)? You can edit or delete them afterward.",
      )
    )
      return;
    let ok = 0;
    for (const data of starterMatrices()) {
      try {
        await upsert.mutateAsync({ data: { data } });
        ok += 1;
      } catch {
        /* reported below */
      }
    }
    invalidate();
    toast({
      title: ok > 0 ? `Added ${ok} starter matri${ok === 1 ? "x" : "ces"}` : "Could not add starters",
      variant: ok > 0 ? "default" : "destructive",
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={openNew}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors"
        >
          <Plus size={14} /> Add matrix
        </button>
        <button
          onClick={() => setImportOpen(true)}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
        >
          <Download size={14} /> Import
        </button>
        <button
          onClick={loadStarters}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
        >
          <Sparkles size={14} /> Load starters
        </button>
      </div>

      {isLoading ? (
        <div className="py-12 flex justify-center">
          <Loader2 className="animate-spin text-[#10b981]" size={24} />
        </div>
      ) : matrices.length === 0 ? (
        <div className="bg-slate-900/40 border border-slate-800 rounded-xl px-6 py-10 text-center">
          <p className="text-sm text-slate-300 font-medium">No matrices yet</p>
          <p className="text-xs text-slate-500 mt-1">
            Add one, load the example starters, or import matrices exported from
            your existing tool.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {matrices.map((m) => (
            <div
              key={m.id}
              className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden flex flex-col"
            >
              <div className="px-4 py-3 border-b border-slate-800 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-white truncate">
                    {m.data.name}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {m.data.xValues.length} column
                    {m.data.xValues.length === 1 ? "" : "s"} · priced by{" "}
                    <span className="text-slate-400">{m.data.xAxisLabel}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => openEdit(m)}
                    className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
                  >
                    <Pencil size={12} /> Edit
                  </button>
                  <button
                    onClick={() => duplicate(m)}
                    disabled={upsert.isPending}
                    className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50"
                    aria-label="Duplicate matrix"
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    onClick={() => {
                      if (
                        window.confirm(`Delete "${m.data.name}"? This can't be undone.`)
                      )
                        del.mutate({ id: m.id });
                    }}
                    disabled={del.isPending}
                    className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1.5 rounded-lg bg-red-500/10 border border-red-500/25 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-50"
                    aria-label="Delete matrix"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
              <div className="p-3">
                <MatrixPreview matrix={m} />
              </div>
            </div>
          ))}
        </div>
      )}

      {editorOpen && (
        <MatrixEditorModal
          matrix={editing}
          onClose={() => setEditorOpen(false)}
        />
      )}
      {importOpen && <ImportMatricesModal onClose={() => setImportOpen(false)} />}
    </div>
  );
}
