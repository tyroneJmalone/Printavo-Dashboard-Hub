import { useMemo, useState } from "react";
import { Link } from "wouter";
import type { ChipplyStore } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ClipboardPaste, FileSpreadsheet, Search, ArrowRight, Compass } from "lucide-react";

export function GuidedSetupStart({ open, onOpenChange, stores, onNewFromEmail, onNewFromDetailed }: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  stores: ChipplyStore[];
  onNewFromEmail: () => void;
  onNewFromDetailed: () => void;
}) {
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return stores
      .filter((s) => !s.archived || t)
      .filter((s) => !t || s.storeName.toLowerCase().includes(t) || (s.eventId ?? "").includes(t))
      .slice(0, 12);
  }, [stores, q]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-800 text-slate-200 sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2"><Compass size={18} className="text-[#059669]" />Guided Chipply Setup</DialogTitle>
          <DialogDescription className="text-slate-400">
            Nine checks that line up Chipply's numbers with the Printavo invoices. Optional, resumable, and shared with the team.
          </DialogDescription>
        </DialogHeader>
        <div className="grid sm:grid-cols-[1fr_1.4fr] gap-4">
          <div className="space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">New store</p>
            <button data-testid="button-guide-new-email" onClick={onNewFromEmail} className="w-full text-left rounded-lg border border-slate-700 bg-slate-800 hover:border-[#059669] px-3 py-3 transition-colors">
              <span className="flex items-center gap-2 font-semibold text-slate-100"><ClipboardPaste size={15} className="text-[#059669]" />Closing email or SalesReport</span>
              <span className="text-xs text-slate-400">Uses the normal Import store review.</span>
            </button>
            <button data-testid="button-guide-new-detailed" onClick={onNewFromDetailed} className="w-full text-left rounded-lg border border-slate-700 bg-slate-800 hover:border-[#059669] px-3 py-3 transition-colors">
              <span className="flex items-center gap-2 font-semibold text-slate-100"><FileSpreadsheet size={15} className="text-[#059669]" />Detailed data export</span>
              <span className="text-xs text-slate-400">CSV / XLSX row-level export.</span>
            </button>
            <p className="text-[11px] text-slate-500">After saving, the guide opens for that store.</p>
          </div>
          <div className="space-y-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Existing store</p>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input data-testid="input-guide-store-search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Store name or event #" className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg pl-8 pr-3 py-2 focus:outline-none focus:border-[#059669] placeholder:text-slate-500" />
            </div>
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {stores.length === 0 && <p className="text-xs text-slate-500 py-4 text-center">No stores imported yet. Start with a new store.</p>}
              {stores.length > 0 && matches.length === 0 && <p className="text-xs text-slate-500 py-4 text-center">No store matches "{q}".</p>}
              {matches.map((s) => (
                <Link key={s.id} data-testid={`link-guide-store-${s.id}`} href={`/chipply/${s.id}/setup`} onClick={() => onOpenChange(false)} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-800/50 hover:border-slate-500 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block font-semibold text-slate-100 truncate">{s.storeName}</span>
                    <span className="block text-xs text-slate-400">{s.eventId ? `Event ${s.eventId}` : "No event linked"}{s.archived ? " · archived" : ""}</span>
                  </span>
                  <ArrowRight size={14} className="text-slate-500 shrink-0" />
                </Link>
              ))}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
