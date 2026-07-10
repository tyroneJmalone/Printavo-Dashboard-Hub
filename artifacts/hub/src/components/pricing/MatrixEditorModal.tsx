import { useState } from "react";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpsertDecorationMatrix,
  getListDecorationMatricesQueryKey,
  type DecorationMatrix,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { apiError, fromGrid, toGrid } from "./matrixGrid";

interface EditState {
  name: string;
  xAxisLabel: string;
  columns: string[];
  tiers: string[];
  costs: string[][];
}

function initFrom(matrix: DecorationMatrix | null): EditState {
  if (!matrix) {
    return {
      name: "",
      xAxisLabel: "Colors",
      columns: ["1 Color"],
      tiers: ["24", "48", "72"],
      costs: [["0"], ["0"], ["0"]],
    };
  }
  const g = toGrid(matrix.data);
  const columns = g.columns.length ? g.columns : ["1 Color"];
  const tiers = g.tiers.length ? g.tiers : [24];
  const costs = g.tiers.length ? g.costs : [[0]];
  return {
    name: g.name,
    xAxisLabel: g.xAxisLabel,
    columns,
    tiers: tiers.map(String),
    costs: costs.map((row) => row.map(String)),
  };
}

const inputCls =
  "bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded-lg px-2.5 py-2 focus:outline-none focus:border-[#059669]";

export function MatrixEditorModal({
  matrix,
  onClose,
}: {
  matrix: DecorationMatrix | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [st, setSt] = useState<EditState>(() => initFrom(matrix));

  const upsert = useUpsertDecorationMatrix({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({
          queryKey: getListDecorationMatricesQueryKey(),
        });
        toast({ title: matrix ? "Matrix updated" : "Matrix created" });
        onClose();
      },
      onError: (err) =>
        toast({
          title: "Could not save matrix",
          description: apiError(err) ?? "Save failed",
          variant: "destructive",
        }),
    },
  });

  const setCell = (ti: number, ci: number, v: string) =>
    setSt((s) => {
      const costs = s.costs.map((r) => [...r]);
      costs[ti][ci] = v;
      return { ...s, costs };
    });
  const setCol = (ci: number, v: string) =>
    setSt((s) => {
      const columns = [...s.columns];
      columns[ci] = v;
      return { ...s, columns };
    });
  const setTier = (ti: number, v: string) =>
    setSt((s) => {
      const tiers = [...s.tiers];
      tiers[ti] = v;
      return { ...s, tiers };
    });
  const addColumn = () =>
    setSt((s) => ({
      ...s,
      columns: [...s.columns, `Column ${s.columns.length + 1}`],
      costs: s.costs.map((r) => [...r, "0"]),
    }));
  const removeColumn = (ci: number) =>
    setSt((s) =>
      s.columns.length <= 1
        ? s
        : {
            ...s,
            columns: s.columns.filter((_, i) => i !== ci),
            costs: s.costs.map((r) => r.filter((_, i) => i !== ci)),
          },
    );
  const addTier = () =>
    setSt((s) => ({
      ...s,
      tiers: [...s.tiers, ""],
      costs: [...s.costs, s.columns.map(() => "0")],
    }));
  const removeTier = (ti: number) =>
    setSt((s) =>
      s.tiers.length <= 1
        ? s
        : {
            ...s,
            tiers: s.tiers.filter((_, i) => i !== ti),
            costs: s.costs.filter((_, i) => i !== ti),
          },
    );

  const fail = (title: string, description: string) => {
    toast({ title, description, variant: "destructive" });
  };

  const save = () => {
    if (!st.name.trim()) return fail("Name required", "Give the matrix a name.");
    if (!st.xAxisLabel.trim())
      return fail("Axis label required", 'Name what the columns represent (e.g. "Colors").');
    if (st.columns.some((c) => !c.trim()))
      return fail("Column labels required", "Every column needs a label.");
    const tierNums = st.tiers.map((t) => Number(t));
    if (tierNums.some((n) => !Number.isFinite(n) || n < 1 || !Number.isInteger(n)))
      return fail("Check quantities", "Every tier needs a whole quantity of 1 or more.");
    if (new Set(tierNums).size !== tierNums.length)
      return fail("Duplicate quantities", "Each quantity tier must be unique.");
    if (st.costs.some((r) => r.some((v) => !v.trim())))
      return fail("Check costs", "Every cost cell needs a value. Enter 0 for a free location.");
    const costNums = st.costs.map((r) => r.map((v) => Number(v)));
    if (costNums.some((r) => r.some((n) => !Number.isFinite(n) || n < 0)))
      return fail("Check costs", "Costs must be zero or a positive number.");

    const data = fromGrid({
      name: st.name,
      xAxisLabel: st.xAxisLabel,
      columns: st.columns,
      tiers: tierNums,
      costs: costNums,
    });
    upsert.mutate({ data: { id: matrix?.id, data } });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-[#0f172a] border border-slate-800 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl">
        <header className="flex items-center justify-between px-5 py-4 border-b border-slate-800 flex-shrink-0">
          <h2 className="text-base font-bold text-white">
            {matrix ? "Edit matrix" : "New matrix"}
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5 space-y-4 custom-scrollbar">
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-[11px] text-slate-400 font-semibold flex-1 min-w-[220px]">
              Matrix name
              <input
                value={st.name}
                onChange={(e) => setSt((s) => ({ ...s, name: e.target.value }))}
                placeholder="e.g. Screen Print — by Colors"
                className={inputCls}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-slate-400 font-semibold w-48">
              Columns represent
              <input
                value={st.xAxisLabel}
                onChange={(e) =>
                  setSt((s) => ({ ...s, xAxisLabel: e.target.value }))
                }
                placeholder="Colors, Stitches…"
                className={inputCls}
              />
            </label>
          </div>

          <div className="overflow-x-auto border border-slate-800 rounded-lg">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-slate-900/70">
                  <th className="p-2 text-left text-[10px] font-bold uppercase tracking-wider text-slate-500 sticky left-0 bg-slate-900/70 z-10 whitespace-nowrap">
                    Qty ⁄ {st.xAxisLabel.trim() || "Column"}
                  </th>
                  {st.columns.map((c, ci) => (
                    <th key={ci} className="p-2 min-w-[130px]">
                      <div className="flex items-center gap-1">
                        <input
                          value={c}
                          onChange={(e) => setCol(ci, e.target.value)}
                          className={`${inputCls} w-full`}
                        />
                        <button
                          onClick={() => removeColumn(ci)}
                          disabled={st.columns.length <= 1}
                          className="text-slate-500 hover:text-red-400 disabled:opacity-30 transition-colors flex-shrink-0"
                          aria-label="Remove column"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {st.tiers.map((t, ti) => (
                  <tr key={ti} className="border-t border-slate-800">
                    <td className="p-2 sticky left-0 bg-[#0f172a] z-10">
                      <div className="flex items-center gap-1">
                        <span className="text-slate-500">≥</span>
                        <input
                          type="number"
                          min={1}
                          value={t}
                          onChange={(e) => setTier(ti, e.target.value)}
                          className={`${inputCls} w-20`}
                        />
                        <button
                          onClick={() => removeTier(ti)}
                          disabled={st.tiers.length <= 1}
                          className="text-slate-500 hover:text-red-400 disabled:opacity-30 transition-colors"
                          aria-label="Remove tier"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                    {st.columns.map((_, ci) => (
                      <td key={ci} className="p-1">
                        <div className="relative">
                          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500 text-xs">
                            $
                          </span>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={st.costs[ti][ci]}
                            onChange={(e) => setCell(ti, ci, e.target.value)}
                            className={`${inputCls} w-full pl-5`}
                          />
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={addTier}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
            >
              <Plus size={13} /> Add quantity tier
            </button>
            <button
              onClick={addColumn}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
            >
              <Plus size={13} /> Add column
            </button>
          </div>

          <p className="text-[11px] text-slate-500 leading-relaxed">
            Each cell is the decoration cost per piece at that quantity. When an
            order lands between tiers, the highest tier at or below the order
            quantity is used; below the smallest tier, the smallest tier's cost
            applies.
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-4 border-t border-slate-800 flex-shrink-0">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={upsert.isPending}
            className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-50"
          >
            {upsert.isPending && <Loader2 size={13} className="animate-spin" />}
            {matrix ? "Save changes" : "Create matrix"}
          </button>
        </footer>
      </div>
    </div>
  );
}
