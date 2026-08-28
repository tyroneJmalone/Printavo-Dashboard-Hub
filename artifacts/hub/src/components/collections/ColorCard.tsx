import { Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PaletteColorSuggestion, PaletteStyleSuggestion } from "@workspace/api-client-react";
import { InventoryDisplay } from "./InventoryDisplay";

interface ColorCardProps {
  styleSuggestion: PaletteStyleSuggestion;
  color: PaletteColorSuggestion;
  isSelected: boolean;
  onToggle: () => void;
}

export function ColorCard({ styleSuggestion, color, isSelected, onToggle }: ColorCardProps) {
  const safeStyleKey = `${styleSuggestion.vendor}-${styleSuggestion.styleName}`.replace(/[^a-zA-Z0-9]/g, '-');
  const safeColorName = color.colorName.replace(/[^a-zA-Z0-9]/g, '-');

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-xl border transition-all h-full w-full overflow-hidden",
        isSelected
          ? "border-emerald-500/50 bg-emerald-500/5 shadow-[0_0_20px_rgba(16,185,129,0.05)] ring-1 ring-emerald-500/20"
          : "border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/80"
      )}
    >
      <button
        type="button"
        aria-pressed={isSelected}
        onClick={onToggle}
        className="relative flex flex-1 flex-col p-3 text-left group"
        data-testid={`card-color-${safeStyleKey}-${safeColorName}`}
      >
        <div className="flex gap-3 w-full mb-3">
        {color.swatchImage || color.productImage ? (
          <img
            src={color.swatchImage || color.productImage || ''}
            alt={color.colorName}
            className="w-12 h-12 rounded-lg object-cover shadow-sm bg-slate-950 border border-slate-800 flex-shrink-0"
          />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center text-[9px] text-slate-500 text-center leading-none p-1 flex-shrink-0">
            No Image
          </div>
        )}
        <div className="flex-1 min-w-0 pr-8">
          <h4 className="text-sm font-bold text-slate-200 truncate" title={color.colorName}>
            {color.colorName}
          </h4>
          <div className="mt-1 flex items-center gap-1.5">
            <div
              className="w-2.5 h-2.5 rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.1)] flex-shrink-0"
              style={{ backgroundColor: color.matchedCustomer.hex || '#000' }}
            />
            <span className="text-[10px] text-slate-400 truncate" title={color.matchedCustomer.name}>
              {color.matchedCustomer.role}
            </span>
          </div>
        </div>
        </div>

        <div className={cn(
          "absolute right-3 top-3 w-5 h-5 rounded-full border flex items-center justify-center transition-colors shadow-sm",
          isSelected ? "bg-emerald-500 border-emerald-500 text-white" : "border-slate-700 bg-slate-900/50 group-hover:border-slate-500"
        )}>
          {isSelected && <Check size={12} strokeWidth={3} />}
        </div>

      <div className="space-y-2 flex-1 flex flex-col justify-end w-full">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" className="text-[9px] uppercase tracking-wider py-0 px-1.5 h-4 bg-slate-950 border-slate-800 text-slate-400">
            {color.matchMethod.replace('_', ' ')}
          </Badge>
          <Badge variant="outline" className={cn(
            "text-[9px] uppercase tracking-wider py-0 px-1.5 h-4 border",
            color.confidence === 'high' ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" :
            color.confidence === 'medium' ? "text-amber-400 border-amber-500/30 bg-amber-500/10" :
            "text-slate-400 border-slate-700 bg-slate-800"
          )}>
            {color.confidence}
          </Badge>
          <div className="ml-auto text-[10px] font-mono font-bold flex items-center">
            Score: <span className={cn(
              "ml-1 px-1 rounded",
              color.score >= 80 ? "text-emerald-400 bg-emerald-500/10" :
              color.score >= 50 ? "text-amber-400 bg-amber-500/10" :
              "text-red-400 bg-red-500/10"
            )}>{color.score}</span>
          </div>
        </div>

        <p className="text-[10px] leading-relaxed text-slate-400">{color.reason}</p>

        {color.evidence && (
          <div className="bg-slate-950/50 p-2 rounded border border-slate-800/50 text-[9px] space-y-1 mt-1">
            <div className="flex justify-between text-slate-500">
              <span>Status: <strong className={color.evidence.status === 'measured' ? 'text-emerald-400/80' : 'text-amber-400/80'}>{color.evidence.status}</strong></span>
              {color.deltaE != null && <span>&Delta;E: <strong className="text-slate-300">{color.deltaE.toFixed(1)}</strong></span>}
            </div>
            {color.evidence.rgb && (
              <div className="flex items-center gap-1.5 pt-0.5">
                <div className="w-2.5 h-2.5 rounded-sm border border-slate-700" style={{ backgroundColor: `rgb(${color.evidence.rgb.join(',')})` }} />
                <span className="text-slate-400 font-mono">rgb({color.evidence.rgb.join(',')})</span>
              </div>
            )}
            {color.evidence.method && <div className="text-slate-500 truncate" title={color.evidence.method}>{color.evidence.method.replaceAll('_', ' ')}</div>}
          </div>
        )}

        <div className="flex justify-between text-[9px] border-t border-slate-800/50 pt-2 mt-1 px-0.5">
          <div className="flex flex-col">
            <span className="text-slate-500 font-medium">Garment PMS</span>
            <span className={cn("font-mono mt-0.5", color.garmentPantoneCode ? "text-slate-300" : "text-slate-600")}>
              {color.garmentPantoneCode ?? "Not provided."}
            </span>
          </div>
          {color.matchedCustomer.pantoneCode && (
            <div className="flex flex-col text-right">
              <span className="text-slate-500 font-medium">Brand PMS</span>
              <span className="font-mono mt-0.5 text-slate-300">{color.matchedCustomer.pantoneCode}</span>
            </div>
          )}
        </div>
      </div>
      </button>
      <div className="px-3 pb-3">
        <InventoryDisplay
          vendor={styleSuggestion.vendor}
          styleName={styleSuggestion.styleName}
          styleId={styleSuggestion.styleId}
          colorName={color.colorName}
          sizes={styleSuggestion.sizes}
        />
      </div>
    </div>
  );
}
