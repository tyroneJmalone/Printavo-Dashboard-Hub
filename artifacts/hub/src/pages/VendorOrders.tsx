import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { PrintavoOrderLink } from "@/components/PrintavoOrderLink";
import { useGetNeedsOrdering, triggerPoll, getSyncStatus, type NeedsOrderingOrder, type NeedsOrderingLineItem } from "@workspace/api-client-react";
import { formatNumber, formatDate } from "@/lib/format";
import { usePoCart, guessVendor, type CartItem } from "@/stores/poCart";
import { CartDrawer } from "@/components/purchasing/CartDrawer";
import { useToast } from "@/hooks/use-toast";
import { Truck, Loader2, RefreshCw, PackageSearch, Layers, Boxes, CalendarClock, ShoppingCart, Plus, Check, AlertTriangle } from "lucide-react";

function statusPill(name: string | null): string {
  if (!name) return "Unknown";
  const idx = name.indexOf(" - ");
  return idx >= 0 ? name.slice(idx + 3).trim() : name;
}

/** Stale-flag rule: warn (never block) when the row looks already handled. */
function staleWarning(order: NeedsOrderingOrder, li: NeedsOrderingLineItem): string | null {
  if (li.items <= 0) return "0 pieces on this line — verify in Printavo";
  const s = (order.statusName ?? "").toLowerCase();
  if (s.includes("picked up") || s.includes("complete") || s.includes("delivered")) {
    return `Order status is "${statusPill(order.statusName)}" — may already be done`;
  }
  return null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A forced sync runs 1-3 minutes server-side (throttled Printavo crawl), far
 * longer than proxies keep an HTTP response open, so POST /sync/poll returns
 * "Poll started" immediately and we watch GET /sync/status until the run
 * leaves the "running" state.
 */
async function watchSyncUntilDone(): Promise<{ ok: boolean; error: string | null }> {
  const start = Date.now();
  const deadline = start + 6 * 60_000;
  let runId: number | null = null;
  while (Date.now() < deadline) {
    await sleep(4000);
    try {
      const status = await getSyncStatus();
      const run = status.lastIncremental;
      if (run?.status === "running") {
        runId = run.id;
        continue;
      }
      if (runId !== null && run?.id === runId) {
        return { ok: run.status === "completed", error: run.error ?? null };
      }
      // Never observed it running after 30s: either it finished within our
      // first 4s check, or it never actually started. Trust the run record
      // (allowing a little client/server clock skew) instead of assuming
      // success.
      if (runId === null && Date.now() - start > 30_000) {
        if (run?.finishedAt && new Date(run.startedAt).getTime() >= start - 60_000) {
          return { ok: run.status === "completed", error: run.error ?? null };
        }
        return { ok: false, error: "The sync never started — check the Dashboard sync panel." };
      }
    } catch {
      // Transient status-fetch hiccup — keep watching until the deadline.
    }
  }
  return { ok: false, error: "Timed out waiting for the sync to finish" };
}

function buildCartItem(order: NeedsOrderingOrder, li: NeedsOrderingLineItem): CartItem {
  const sizes =
    li.sizes.length > 0
      ? li.sizes.map((s) => ({
          size: s.size,
          qty: s.count,
          unitCost: null,
          sku: null,
          inventoryKey: null,
          sizeIndex: null,
        }))
      : [{ size: "OSFA", qty: li.items > 0 ? li.items : 0, unitCost: null, sku: null, inventoryKey: null, sizeIndex: null }];
  return {
    key: li.id,
    printavoLineItemId: li.id,
    printavoOrderId: order.orderId,
    visualId: order.visualId,
    styleNumber: li.itemNumber ?? "",
    color: li.color,
    description: li.description,
    brand: li.brand,
    vendor: guessVendor(li.brand),
    vendorCatalogColor: null,
    vendorStyleId: null,
    resolved: false,
    sizes,
    inventory: null,
    warehouseCode: null,
    warehouseName: null,
    warehouseManual: false,
  };
}

export default function VendorOrders() {
  const { toast } = useToast();
  const { data, isLoading, isFetching, refetch } = useGetNeedsOrdering();
  const cartItems = usePoCart((s) => s.items);
  const addItem = usePoCart((s) => s.addItem);
  const removeItem = usePoCart((s) => s.removeItem);
  const [cartOpen, setCartOpen] = useState(false);
  const inCart = new Set(cartItems.map((i) => i.key));

  const [syncing, setSyncing] = useState(false);

  /**
   * Forced refresh: trigger a Printavo incremental poll (new/changed orders +
   * their line-item details), wait for it to finish, then re-run the
   * needs-ordering scan. Safe to spam — the server no-ops with a message if
   * a sync is already running.
   */
  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      const res = await triggerPoll();
      if (!res.ran) {
        // ran:false covers several cases the server reports as 200: another
        // sync busy, seed not done, creds missing, or an actual poll failure.
        const failed = res.message.startsWith("Poll failed");
        void refetch();
        toast({
          title: failed ? "Printavo sync failed" : "Sync not run",
          description: res.message,
          ...(failed ? { variant: "destructive" as const } : {}),
        });
        return;
      }
      if (res.stats !== null) {
        // Finished within the server's grace window — already done.
        void refetch();
        toast({ title: "Synced with Printavo", description: res.message });
        return;
      }
      toast({
        title: "Syncing with Printavo",
        description: "Pulling the latest orders — usually takes a minute or two.",
      });
      const outcome = await watchSyncUntilDone();
      void refetch();
      if (outcome.ok) {
        toast({
          title: "Synced with Printavo",
          description: "Latest Printavo changes pulled — list refreshed.",
        });
      } else {
        toast({
          title: "Printavo sync failed",
          description: outcome.error ?? "Check the Dashboard sync panel.",
          variant: "destructive",
        });
      }
    } catch (err) {
      // Still re-read the local scan — it may have data from the scheduler.
      void refetch();
      toast({
        title: "Printavo sync failed",
        description: err instanceof Error ? err.message : "Check the Dashboard sync panel.",
        variant: "destructive",
      });
    } finally {
      setSyncing(false);
    }
  }

  const refreshing = syncing || isFetching;

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
                <Truck className="text-[#10b981]" size={24} />
                Vendor Orders
              </h1>
              <p className="text-xs text-slate-400 mt-1">Line items flagged "needs ordering" in Printavo, refreshed by the 5-minute sync</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleSync()}
                disabled={refreshing}
                title="Pull the latest orders from Printavo now, then re-scan for items needing ordering"
                className="flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 transition-colors disabled:opacity-50"
              >
                <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
                {syncing ? "Syncing with Printavo…" : "Sync now"}
              </button>
              <button
                onClick={() => setCartOpen(true)}
                className="relative flex items-center gap-2 text-xs font-bold px-3.5 py-2 rounded-lg bg-[#059669] text-white hover:bg-[#047857] transition-colors"
              >
                <ShoppingCart size={14} />
                PO Cart
                {cartItems.length > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-white text-[#059669] text-[10px] font-black rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
                    {cartItems.length}
                  </span>
                )}
              </button>
            </div>
          </div>

          {!isLoading && data && (
            <div className="grid grid-cols-3 gap-4 mt-5">
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1 flex items-center gap-1.5"><PackageSearch size={13} /> Orders Needing Purchase</div>
                <div className="text-2xl font-bold text-white">{formatNumber(data.totalOrders)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1 flex items-center gap-1.5"><Layers size={13} /> Line Items</div>
                <div className="text-2xl font-bold text-white">{formatNumber(data.totalLineItems)}</div>
              </div>
              <div className="bg-slate-900/50 rounded-lg border border-slate-800 p-4">
                <div className="text-xs text-slate-400 font-medium mb-1 flex items-center gap-1.5"><Boxes size={13} /> Total Pieces</div>
                <div className="text-2xl font-bold text-[#10b981]">{formatNumber(data.totalPieces)}</div>
              </div>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5 custom-scrollbar">
          {isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="animate-spin text-[#10b981]" size={32} />
            </div>
          ) : !data || data.orders.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-slate-500">
              <PackageSearch size={40} className="mb-3 opacity-50" />
              <div className="text-sm font-medium">Nothing needs ordering right now</div>
              <div className="text-xs mt-1">Line items marked "needs ordering" in Printavo will appear here within ~5 minutes.</div>
            </div>
          ) : (
            data.orders.map((order) => (
              <div key={order.orderId} className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-800 flex flex-wrap items-center justify-between gap-3 bg-slate-900/60">
                  <div className="flex items-center gap-4">
                    <div>
                      <div className="text-base font-bold text-white">
                        <PrintavoOrderLink orderId={order.orderId} visualId={order.visualId} />
                      </div>
                      <div className="text-xs text-slate-500">{order.nickname || "—"}</div>
                    </div>
                    <div className="h-8 w-px bg-slate-800" />
                    <div>
                      <div className="text-sm font-medium text-slate-200">{order.customerCompany || order.contactName || "—"}</div>
                      <div className="text-xs text-slate-500">{order.contactName && order.customerCompany ? order.contactName : ""}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="text-xs text-slate-400 flex items-center gap-1.5">
                      <CalendarClock size={13} />
                      <span>Prod due {formatDate(order.productionDueAt)}</span>
                    </div>
                    <span className="inline-flex items-center px-2 py-1 rounded text-[11px] font-bold bg-slate-800 text-slate-300 border border-slate-700">
                      {statusPill(order.statusName)}
                    </span>
                  </div>
                </div>
                <table className="w-full text-sm text-left">
                  <thead className="text-[11px] text-slate-400 bg-slate-900/80 uppercase tracking-wider">
                    <tr>
                      <th className="px-5 py-2.5 font-semibold">Style</th>
                      <th className="px-5 py-2.5 font-semibold">Color</th>
                      <th className="px-5 py-2.5 font-semibold">Description</th>
                      <th className="px-5 py-2.5 font-semibold">Sizes</th>
                      <th className="px-5 py-2.5 font-semibold text-right">Qty</th>
                      <th className="px-5 py-2.5 font-semibold text-right">Cart</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800">
                    {order.lineItems.map((li) => {
                      const warn = staleWarning(order, li);
                      const added = inCart.has(li.id);
                      return (
                        <tr key={li.id} className="hover:bg-slate-800/30 transition-colors">
                          <td className="px-5 py-3">
                            <div className="font-mono font-semibold text-slate-200">{li.itemNumber || "—"}</div>
                            <div className="text-[11px] text-slate-500">{li.brand || ""}</div>
                          </td>
                          <td className="px-5 py-3 text-slate-300">{li.color || "—"}</td>
                          <td className="px-5 py-3 text-slate-400 max-w-[280px]">
                            <div className="truncate">{li.description || "—"}</div>
                            {warn && (
                              <div className="flex items-center gap-1 text-[11px] text-amber-400 mt-0.5">
                                <AlertTriangle size={11} className="flex-shrink-0" />
                                {warn}
                              </div>
                            )}
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex flex-wrap gap-1">
                              {li.sizes.length === 0 ? (
                                <span className="text-slate-600 text-xs">—</span>
                              ) : (
                                li.sizes.map((s, i) => (
                                  <span key={i} className="text-[10px] font-mono bg-slate-800 border border-slate-700 text-slate-300 px-1.5 py-0.5 rounded">
                                    {s.size}×{s.count}
                                  </span>
                                ))
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3 text-right font-mono font-bold text-[#10b981]">{formatNumber(li.items)}</td>
                          <td className="px-5 py-3 text-right">
                            <button
                              onClick={() => {
                                if (added) {
                                  removeItem(li.id);
                                } else {
                                  addItem(buildCartItem(order, li));
                                  setCartOpen(true);
                                }
                              }}
                              className={`inline-flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-md border transition-colors ${
                                added
                                  ? "bg-[#059669]/10 text-[#10b981] border-[#059669]/30 hover:bg-[#059669]/20"
                                  : "bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700"
                              }`}
                            >
                              {added ? <Check size={12} /> : <Plus size={12} />}
                              {added ? "Added" : "Add"}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))
          )}
        </div>
      </div>
      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
    </AppShell>
  );
}
