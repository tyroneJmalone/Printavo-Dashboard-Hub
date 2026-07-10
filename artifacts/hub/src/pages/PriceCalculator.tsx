import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { MatricesManager } from "@/components/pricing/MatricesManager";
import { Calculator, Grid3x3, ArrowRight } from "lucide-react";

type Tab = "calculator" | "matrices";

export default function PriceCalculator() {
  const [tab, setTab] = useState<Tab>("calculator");

  const tabCls = (active: boolean) =>
    `flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border transition-colors ${
      active
        ? "bg-[#059669]/10 border-[#059669]/30 text-[#10b981]"
        : "bg-transparent border-transparent text-slate-400 hover:text-slate-100 hover:bg-slate-800"
    }`;

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
            <Calculator className="text-[#10b981]" size={24} />
            Price Calculator
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Quote garment + decoration pricing using your saved decoration
            matrices.
          </p>
          <div className="flex items-center gap-2 mt-4">
            <button
              onClick={() => setTab("calculator")}
              className={tabCls(tab === "calculator")}
            >
              <Calculator size={14} /> Calculator
            </button>
            <button
              onClick={() => setTab("matrices")}
              className={tabCls(tab === "matrices")}
            >
              <Grid3x3 size={14} /> Pricing Matrices
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          {tab === "calculator" ? (
            <div className="bg-slate-900/40 border border-slate-800 rounded-xl px-6 py-12 text-center max-w-2xl mx-auto">
              <Calculator className="mx-auto text-slate-600 mb-3" size={36} />
              <p className="text-sm text-slate-300 font-medium">
                The quote calculator is coming next.
              </p>
              <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">
                First, set up your decoration pricing matrices — the per-piece
                decoration costs the calculator will use.
              </p>
              <button
                onClick={() => setTab("matrices")}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors mt-4"
              >
                Set up pricing matrices <ArrowRight size={14} />
              </button>
            </div>
          ) : (
            <MatricesManager />
          )}
        </div>
      </div>
    </AppShell>
  );
}
