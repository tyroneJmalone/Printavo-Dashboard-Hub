import { useState, useEffect } from "react";
import { useSearch } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { MatricesManager } from "@/components/pricing/MatricesManager";
import { QuoteCalculator } from "@/components/pricing/QuoteCalculator";
import { Calculator, Grid3x3 } from "lucide-react";

type Tab = "calculator" | "matrices";

export default function PriceCalculator() {
  const [tab, setTab] = useState<Tab>("calculator");
  
  const searchString = useSearch();
  const params = new URLSearchParams(searchString);
  const costParam = params.get("garmentCost") || "";
  const labelParam = params.get("label") || "";
  
  const [initialGarmentCost, setInitialGarmentCost] = useState(costParam);
  const [initialLabel, setInitialLabel] = useState(labelParam);

  useEffect(() => {
    if (costParam || labelParam) {
       window.history.replaceState({}, '', '/price-calculator');
    }
  }, [costParam, labelParam]);

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
            <QuoteCalculator 
               onGoToMatrices={() => setTab("matrices")} 
               initialGarmentCost={initialGarmentCost}
               initialLabel={initialLabel}
            />
          ) : (
            <MatricesManager />
          )}
        </div>
      </div>
    </AppShell>
  );
}
