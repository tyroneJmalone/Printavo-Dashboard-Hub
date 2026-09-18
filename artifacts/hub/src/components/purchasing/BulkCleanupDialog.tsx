import React, { useState, useEffect, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Loader2, AlertTriangle, CheckCircle2, XCircle, Info, StopCircle, RefreshCw } from "lucide-react";
import { bulkSetLineItemProductStatus, getGetNeedsOrderingQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export interface SelectedLineItemInfo {
  lineItemId: string;
  orderId: string;
  visualId: number | null;
  label: string;
  color: string;
  description: string;
  inCart: boolean;
}

export type TargetStatus = "unset" | "ordered" | "received";

interface BulkCleanupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  items: SelectedLineItemInfo[];
  targetStatus: TargetStatus | null;
  onSuccess: (updatedIds: string[]) => void;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export function BulkCleanupDialog({ isOpen, onClose, items, targetStatus, onSuccess }: BulkCleanupDialogProps) {
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stopRequested, setStopRequested] = useState(false);
  const stopRequestedRef = useRef(false);
  const inFlightRef = useRef(false);

  useEffect(() => () => {
    // In-app navigation may unmount the dialog without beforeunload.
    // Allow the current request to finish, but never start another batch.
    stopRequestedRef.current = true;
  }, []);
  
  const [results, setResults] = useState<{ id: string; outcome: string; message?: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  const uniqueInvoices = new Set(items.map(i => i.orderId)).size;
  const inCartCount = items.filter(i => i.inCart).length;
  
  useEffect(() => {
    if (isOpen) {
      setRunning(false);
      setProgress(0);
      setStopRequested(false);
      stopRequestedRef.current = false;
      setResults([]);
      setError(null);
    }
  }, [isOpen]);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (running) {
        e.preventDefault();
        e.returnValue = "Bulk cleanup is still running. Are you sure you want to leave?";
        return e.returnValue;
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [running]);

  const handleStart = async () => {
    if (!targetStatus || !items.length || inFlightRef.current) return;
    inFlightRef.current = true;
    stopRequestedRef.current = false;
    
    setRunning(true);
    setError(null);
    setResults([]);
    setProgress(0);
    
    const chunks = chunkArray(items, 5);
    let processedCount = 0;
    
    for (const batch of chunks) {
      if (stopRequestedRef.current) break;
      
      try {
        const res = await bulkSetLineItemProductStatus({
          lineItems: batch.map(i => ({ lineItemId: i.lineItemId, orderId: i.orderId })),
          status: targetStatus
        });
        
        setResults(prev => [
          ...prev,
          ...res.results.map(r => ({
            id: r.lineItemId,
            outcome: r.outcome,
            message: r.message
          }))
        ]);
        
        processedCount += batch.length;
        setProgress(processedCount);
        
        // Invalidate to start hiding successes from the queue immediately
        queryClient.invalidateQueries({ queryKey: getGetNeedsOrderingQueryKey() });
        
      } catch (err) {
        setError(err instanceof Error ? err.message : "Network error interrupted batch");
        setResults(prev => [
          ...prev,
          ...batch.map(i => ({ id: i.lineItemId, outcome: "unknown", message: "Result not confirmed. Check this line in Printavo before trying again." }))
        ]);
        processedCount += batch.length;
        setProgress(processedCount);
        break; 
      }
    }
    
    setRunning(false);
    inFlightRef.current = false;
    
    // Final invalidation to ensure sync
    queryClient.invalidateQueries({ queryKey: getGetNeedsOrderingQueryKey() });
  };
  
  const handleStop = () => {
    setStopRequested(true);
    stopRequestedRef.current = true;
  };
  
  const handleClose = () => {
    if (inFlightRef.current) return; // block accidental close
    const successfulIds = results.filter(r => r.outcome === "updated" || r.outcome === "already_set").map(r => r.id);
    onSuccess(successfulIds);
    onClose();
  };

  const isComplete = !running && results.length > 0;
  const needsAttention = results.some(r => !["updated", "already_set"].includes(r.outcome)) || (isComplete && progress < items.length);
  
  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto bg-[#0f172a] border-slate-700 text-slate-200">
        <DialogHeader>
          <DialogTitle className="text-xl font-bold flex items-center gap-2">
            {targetStatus === "unset" ? "Clear Status" : 
             targetStatus === "ordered" ? "Mark as Ordered" : "Mark as Received"}
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            {running ? "Processing bulk update..." : isComplete ? "Review the results below." : "Review the changes before applying."}
          </DialogDescription>
        </DialogHeader>
        
        {!running && !isComplete && (
          <div className="space-y-4 py-2">
            <div className="flex gap-4 p-3 bg-slate-800/50 rounded-lg border border-slate-700">
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-300">Target</div>
                <div className="text-lg font-bold text-white capitalize">{targetStatus}</div>
              </div>
              <div className="w-px bg-slate-700" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-300">Selected Items</div>
                <div className="text-lg font-bold text-white">{items.length} lines</div>
              </div>
              <div className="w-px bg-slate-700" />
              <div className="flex-1">
                <div className="text-sm font-medium text-slate-300">Affected Orders</div>
                <div className="text-lg font-bold text-white">{uniqueInvoices}</div>
              </div>
            </div>
            
            {inCartCount > 0 && (
              <div className="flex items-start gap-3 p-3 bg-amber-900/20 text-amber-300 border border-amber-900/50 rounded-lg text-sm">
                <AlertTriangle size={18} className="flex-shrink-0 mt-0.5" />
                <div>
                  <strong>{inCartCount} selected {inCartCount === 1 ? "item is" : "items are"} currently in your PO Cart.</strong> 
                  <br />
                  This cleanup will change their Printavo status, but will NOT remove them from your PO cart.
                </div>
              </div>
            )}
            
            <div className="flex items-start gap-3 p-3 bg-blue-900/20 text-blue-300 border border-blue-900/50 rounded-lg text-sm">
              <Info size={18} className="flex-shrink-0 mt-0.5" />
              <div>
                <strong>Important:</strong> This modifies the Printavo line item PRODUCT status only. It does not change the invoice status, does not order goods, and does not delete anything.
                <div className="mt-1">{targetStatus === "unset" ? "Unset clears the needs-ordering flag." : targetStatus === "received" ? "Received is a status change only; it does not record a warehouse receipt." : "Ordered is a status change only; no purchase order will be created or submitted."} Printavo account automations may react to product-status changes.</div>
                <div className="mt-1">Keep this dialog open until finished, and avoid editing these same lines in Printavo while the update runs.</div>
              </div>
            </div>

            <div className="max-h-60 overflow-y-auto border border-slate-700 rounded-lg custom-scrollbar">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-800 sticky top-0 text-slate-300">
                  <tr>
                    <th className="px-3 py-2 font-medium">Invoice</th>
                    <th className="px-3 py-2 font-medium">Style</th>
                    <th className="px-3 py-2 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-slate-900/50">
                  {items.map(item => (
                    <tr key={item.lineItemId}>
                      <td className="px-3 py-2 font-mono whitespace-nowrap">{item.visualId}</td>
                      <td className="px-3 py-2 font-mono">{item.label}<span className="block text-slate-500">Line {item.lineItemId}</span></td>
                      <td className="px-3 py-2 text-slate-400 truncate max-w-[200px]" title={`${item.color} - ${item.description}`}>
                        {item.color ? `${item.color} - ` : ''}{item.description || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {(running || isComplete) && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <div className="flex justify-between text-sm font-medium">
                <span className={running ? "text-blue-400" : needsAttention ? "text-amber-400" : "text-green-400"}>
                  {running ? (stopRequested ? "Stopping after current batch..." : "Updating...") : needsAttention ? "Finished — review results" : "Complete"}
                </span>
                <span className="text-slate-300">{Math.min(progress, items.length)} / {items.length}</span>
              </div>
              <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
                <div 
                  className={`h-full transition-all duration-300 ${running ? (stopRequested ? "bg-amber-500" : "bg-blue-500") : "bg-green-500"}`}
                  style={{ width: `${items.length ? (Math.min(progress, items.length) / items.length) * 100 : 0}%` }}
                />
              </div>
            </div>
            
            {error && (
              <div className="flex items-start gap-2 p-3 bg-red-900/20 text-red-300 border border-red-900/50 rounded-lg text-sm">
                <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
                <div>
                  <strong>Batch Error:</strong> {error}
                  <div className="mt-1 opacity-80">Execution stopped. Check results below for completed items.</div>
                </div>
              </div>
            )}
            
            <div className="max-h-60 overflow-y-auto border border-slate-700 rounded-lg custom-scrollbar">
              <table className="w-full text-xs text-left">
                <thead className="bg-slate-800 sticky top-0 text-slate-300">
                  <tr>
                    <th className="px-3 py-2 font-medium">Item</th>
                    <th className="px-3 py-2 font-medium">Status</th>
                    <th className="px-3 py-2 font-medium">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800 bg-slate-900/50">
                  {items.map((item, idx) => {
                    const res = results.find(r => r.id === item.lineItemId);
                    const isPending = !res && running && idx < progress + 5 && idx >= progress;
                    const isWaiting = !res && !isPending;
                    
                    return (
                      <tr key={item.lineItemId} className={res?.outcome === 'failed' || res?.outcome === 'conflict' ? 'bg-red-900/10' : ''}>
                        <td className="px-3 py-2 font-mono whitespace-nowrap">
                          {item.visualId} / {item.label.substring(0, 10)}
                          <span className="block text-slate-500">Line {item.lineItemId}</span>
                        </td>
                        <td className="px-3 py-2">
                          {res ? (
                            <span className="flex items-center gap-1">
                              {res.outcome === 'updated' || res.outcome === 'already_set' ? (
                                <CheckCircle2 size={12} className="text-green-400" />
                              ) : (
                                <XCircle size={12} className="text-red-400" />
                              )}
                              <span className="capitalize">{res.outcome === "unknown" ? "Needs verification" : res.outcome === "conflict" ? "Not changed" : res.outcome.replace('_', ' ')}</span>
                            </span>
                          ) : isPending ? (
                            <span className="flex items-center gap-1 text-blue-400">
                              <Loader2 size={12} className="animate-spin" /> Pending
                            </span>
                          ) : (
                            <span className="text-slate-500">{running ? "Waiting" : "Not attempted"}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-400">
                          {res?.message || (isWaiting && !running ? "Skipped" : "—")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            
            {isComplete && (
              <div className="flex justify-between items-center bg-slate-800 p-3 rounded-lg border border-slate-700 text-sm">
                <div className="flex flex-wrap gap-4">
                  <div className="text-green-400"><span className="font-bold">{results.filter(r => r.outcome === 'updated').length}</span> Updated</div>
                  <div className="text-slate-400"><span className="font-bold">{results.filter(r => r.outcome === 'already_set').length}</span> Already set</div>
                  <div className="text-red-400"><span className="font-bold">{results.filter(r => r.outcome === 'failed').length}</span> Failed</div>
                  <div className="text-amber-400"><span className="font-bold">{results.filter(r => r.outcome === 'conflict').length}</span> Not changed</div>
                  <div className="text-amber-400"><span className="font-bold">{results.filter(r => r.outcome === 'unknown').length}</span> Need verification</div>
                  <div className="text-slate-500"><span className="font-bold">{items.length - results.length}</span> Not attempted</div>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {!running && !isComplete && (
            <>
              <button
                onClick={handleClose}
                className="px-4 py-2 rounded-lg text-sm font-medium text-slate-300 hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleStart}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold bg-[#10b981] text-white hover:bg-[#059669] transition-colors"
              >
                <RefreshCw size={16} />
                Confirm Batch Update
              </button>
            </>
          )}
          
          {running && (
            <button
              onClick={handleStop}
              disabled={stopRequested}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-colors ${
                stopRequested 
                  ? "bg-slate-700 text-slate-400 cursor-not-allowed" 
                  : "bg-amber-600 text-white hover:bg-amber-700"
              }`}
            >
              <StopCircle size={16} />
              {stopRequested ? "Stopping..." : "Stop After Current Batch"}
            </button>
          )}
          
          {isComplete && (
            <button
              onClick={handleClose}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-slate-700 text-white hover:bg-slate-600 transition-colors"
            >
              Close & Continue
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
