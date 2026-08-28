import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, RefreshCw } from "lucide-react";
import { useVendorInventory, VendorInventoryRequestVendor } from "@workspace/api-client-react";

interface InventoryDisplayProps {
  vendor: string;
  styleName: string;
  styleId?: string | null;
  colorName: string;
  sizes: string[];
}

export function InventoryDisplay({ vendor, styleName, styleId, colorName, sizes }: InventoryDisplayProps) {
  const invMut = useVendorInventory();
  const [hasChecked, setHasChecked] = useState(false);

  const handleCheck = (e: React.MouseEvent) => {
    e.stopPropagation();
    setHasChecked(true);
    invMut.mutate({
      data: {
        vendor: vendor as VendorInventoryRequestVendor,
        style: styleName,
        styleId: styleId || null,
        catalogColor: colorName,
        sizes: sizes.slice(0, 20)
      }
    });
  };

  if (!hasChecked && !invMut.isPending) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={handleCheck}
        className="w-full text-[10px] h-6 mt-3 bg-slate-900 hover:bg-slate-800 border-slate-700 text-slate-300"
      >
        Check Live Inventory
      </Button>
    );
  }

  if (invMut.isPending) {
    return (
      <div className="text-[10px] text-slate-500 text-center mt-3 flex items-center justify-center gap-1.5 h-6">
        <Loader2 className="w-3 h-3 animate-spin" /> Checking...
      </div>
    );
  }

  if (invMut.isError || !invMut.data) {
    return (
      <div className="mt-3 flex items-center justify-between gap-2 rounded border border-red-500/20 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-300">
        <span>Inventory unavailable</span>
        <Button variant="ghost" size="sm" onClick={handleCheck} className="h-5 px-1.5 text-[9px] text-red-300 hover:bg-red-500/10">
          <RefreshCw className="mr-1 h-2.5 w-2.5" /> Retry
        </Button>
      </div>
    );
  }

  const result = invMut.data;
  return (
    <div className="mt-3 rounded border border-slate-800/50 bg-slate-950/80 p-2 text-[10px]">
      <div className="mb-2 flex items-start justify-between gap-2 px-0.5 text-slate-500">
        <span className="font-medium">Stock by size and warehouse</span>
        <span className="text-right text-[9px] text-slate-600">
          {result.cached ? 'Cached' : 'Live'}<br />
          {new Date(result.fetchedAt).toLocaleString()}
        </span>
      </div>
      <div className="space-y-1.5">
        {result.sizes.map(s => {
          const total = s.warehouses.reduce((acc, w) => acc + w.qty, 0);
          const capped = s.warehouses.some(w => w.capped);
          return (
            <div key={s.size} className="rounded border border-slate-800 bg-slate-900 px-2 py-1.5">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-bold text-slate-300">{s.size}</span>
                <span className={total > 0 ? "font-mono text-emerald-400" : "font-mono text-slate-500"}>
                  {s.found ? `${total}${capped ? '+' : ''} total` : 'Not found'}
                </span>
              </div>
              {s.warehouses.length > 0 ? (
                <div className="grid grid-cols-1 gap-0.5">
                  {s.warehouses.map(warehouse => (
                    <div key={warehouse.code} className="flex justify-between gap-2 text-[9px] text-slate-500">
                      <span className="truncate" title={`${warehouse.name} (${warehouse.code})`}>{warehouse.name}</span>
                      <span className="shrink-0 font-mono text-slate-300">{warehouse.qty}{warehouse.capped ? '+' : ''}</span>
                    </div>
                  ))}
                </div>
              ) : s.found ? (
                <div className="text-[9px] text-slate-600">No warehouse stock reported</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
