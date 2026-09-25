import { Fragment, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  useListVendorOrders,
  getListVendorOrdersQueryKey,
  useRefreshVendorOrder,
  refreshVendorOrder,
  refreshVendorOrderCarrier,
  useMarkVendorOrderFailed,
  useGetCarrierTrackingSettings,
  getGetCarrierTrackingSettingsQueryKey,
  useSetCarrierTrackingSettings,
  useRefreshVendorOrderCarrier,
  type VendorOrder,
  type VendorOrderRefreshResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  PackageSearch,
  RefreshCw,
  Loader2,
  ExternalLink,
  AlertTriangle,
  ShieldAlert,
} from "lucide-react";

function apiError(err: unknown): string | undefined {
  return err && typeof err === "object" && "data" in err
    ? (err as { data?: { error?: string } }).data?.error
    : undefined;
}

/** Carrier tracking URL — UPS is what SanMar/S&S actually ship with. */
function trackingUrl(carrier: string | null, trackingNumber: string): string {
  const c = (carrier ?? "").toLowerCase();
  if (c.includes("fedex")) {
    return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`;
  }
  if (c.includes("usps")) {
    return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`;
  }
  // UPS default — also correct for bare "1Z..." numbers with no carrier.
  return `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`;
}

const VENDOR_LABELS: Record<string, string> = { sanmar: "SanMar", ss: "S&S" };

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    submitted: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    unknown: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    failed: "bg-red-500/10 text-red-400 border-red-500/20",
    submitting: "bg-sky-500/10 text-sky-400 border-sky-500/20",
    pending: "bg-slate-500/10 text-slate-400 border-slate-500/20",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border ${styles[status] ?? styles.pending}`}
    >
      {status === "unknown" && <AlertTriangle className="w-3 h-3" />}
      {status}
    </span>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  if (mode === "live") return null;
  return (
    <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide bg-slate-700/60 text-slate-300">
      {mode === "dry_run" ? "preview" : mode}
    </span>
  );
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
    " " +
    d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** Reconcile panel shown under an UNKNOWN row — the manual, PIN-gated release. */
function ReconcilePanel({ order }: { order: VendorOrder }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pin, setPin] = useState("");
  const [note, setNote] = useState("");

  const markFailed = useMarkVendorOrderFailed({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListVendorOrdersQueryKey() });
        toast({
          title: "Order marked failed",
          description: `PO ${order.poNumber} can be submitted again.`,
        });
      },
      onError: (err) => {
        toast({
          title: "Could not mark failed",
          description: apiError(err) ?? "Request failed",
          variant: "destructive",
        });
      },
    },
  });

  return (
    <div className="mx-4 mb-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[13px]">
      <div className="flex items-start gap-2 text-amber-300">
        <ShieldAlert className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <div>
          <div className="font-semibold">This order's outcome is unknown</div>
          <div className="text-amber-200/70 mt-0.5">
            The send was ambiguous (e.g. a timeout) — the vendor may or may not have
            it. Use <span className="font-semibold">Check vendor</span> first: if{" "}
            {VENDOR_LABELS[order.vendor] ?? order.vendor} confirms the PO, it's
            automatically marked submitted. Right after a refresh that finds no
            record, that can still just be vendor lag — only mark it failed once
            you've confirmed with the vendor that no order exists.{" "}
            <span className="font-semibold">
              Marking it failed unlocks this PO for another live submission.
            </span>
          </div>
          {order.lastStatusCheckAt && (
            <div className="text-amber-200/50 mt-1 text-[12px]">
              Last vendor check: {fmtDate(order.lastStatusCheckAt)} — no record found.
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 mt-3">
        <input
          type="password"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          placeholder="Admin PIN"
          className="w-28 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-[13px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/50"
          data-testid={`input-pin-${order.id}`}
        />
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (e.g. vendor confirmed no order exists)"
          className="flex-1 min-w-48 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-[13px] text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/50"
          data-testid={`input-note-${order.id}`}
        />
        <button
          onClick={() => markFailed.mutate({ id: order.id, data: { adminPin: pin, note: note || null } })}
          disabled={!pin || markFailed.isPending}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-[13px] font-medium bg-red-500/10 text-red-400 border border-red-500/30 hover:bg-red-500/20 disabled:opacity-40 disabled:cursor-not-allowed"
          data-testid={`button-mark-failed-${order.id}`}
        >
          {markFailed.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Mark failed &amp; unlock PO
        </button>
      </div>
    </div>
  );
}

export default function VendorTracking() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState("All");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [adminPin, setAdminPin] = useState("");
  const [confirmFees, setConfirmFees] = useState(false);
  const [refreshProgress, setRefreshProgress] = useState<{ done: number; total: number; po: string } | null>(null);
  const [refreshOutcomes, setRefreshOutcomes] = useState<string[]>([]);
  const { data: carrierSettings } = useGetCarrierTrackingSettings();
  const saveCarrierSettings = useSetCarrierTrackingSettings({
    mutation: {
      onSuccess: () => {
        setAdminPin("");
        setConfirmFees(false);
        queryClient.invalidateQueries({ queryKey: getGetCarrierTrackingSettingsQueryKey() });
        toast({ title: "Carrier tracking setting saved" });
      },
      onError: (err) => toast({ title: "Setting not saved", description: apiError(err) ?? "Request failed", variant: "destructive" }),
    },
  });
  const refreshCarrier = useRefreshVendorOrderCarrier({
    mutation: {
      onSuccess: (result) => {
        queryClient.invalidateQueries({ queryKey: getListVendorOrdersQueryKey() });
        toast({ title: result.outcome === "error" ? "Carrier check had errors" : "Carrier tracking checked", description: result.message ?? undefined, variant: result.outcome === "error" ? "destructive" : undefined });
      },
      onError: (err) => toast({ title: "Carrier check failed", description: apiError(err) ?? "Request failed", variant: "destructive" }),
    },
  });

  const { data, isLoading } = useListVendorOrders(undefined, {
    query: { queryKey: getListVendorOrdersQueryKey() },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListVendorOrdersQueryKey() });

  const refreshOne = useRefreshVendorOrder({
    mutation: {
      onSuccess: (result: VendorOrderRefreshResult) => {
        invalidate();
        if (result.outcome === "reconciled") {
          toast({ title: "Order confirmed", description: result.message ?? undefined });
        } else if (result.outcome === "no_vendor_record") {
          toast({
            title: "No vendor record yet",
            description: result.message ?? undefined,
          });
        } else if (result.outcome === "error" || result.outcome === "not_configured") {
          toast({
            title: "Vendor check failed",
            description: result.message ?? undefined,
            variant: "destructive",
          });
        } else if (result.message) {
          toast({ title: "Status checked", description: result.message });
        } else {
          toast({ title: "Status updated" });
        }
      },
      onError: (err) => {
        toast({
          title: "Refresh failed",
          description: apiError(err) ?? "Request failed",
          variant: "destructive",
        });
      },
    },
  });

  const orders = data?.orders ?? [];
  const visible = orders.filter((o) => {
    if (!showAll && o.mode === "dry_run") return false;
    const statuses = o.tracking.map((t) => t.carrierStatus);
    if (filter === "In transit") return statuses.includes("TRANSIT") || statuses.includes("PRE_TRANSIT");
    if (filter === "Arriving today") return o.tracking.some((t) => t.eta && new Date(t.eta).toDateString() === new Date().toDateString() && t.carrierStatus !== "DELIVERED");
    if (filter === "Known delivered") return statuses.length > 0 && statuses.every((s) => s === "DELIVERED");
    if (filter === "Exceptions") return o.status === "unknown" || o.status === "failed" || o.tracking.some((t) => t.carrierStatus === "FAILURE" || t.carrierStatus === "RETURNED" || !!t.carrierError);
    return true;
  });
  const activeCount = orders.filter(
    (o) => o.mode === "live" && (o.status === "submitted" || o.status === "unknown") && !o.archived,
  ).length;

  // Individual requests avoid one long batch exceeding the proxy deadline.
  // Vendor failures must not prevent checking previously known shipments.
  const refreshActive = async () => {
    const active = orders.filter((o) => o.mode === "live" && (o.status === "submitted" || o.status === "unknown") && !o.archived);
    if (!active.length || refreshProgress) return;
    const outcomes: string[] = [];
    let carrierPaused = false;
    setRefreshOutcomes([]);
    setRefreshProgress({ done: 0, total: active.length, po: active[0].poNumber });
    try {
      for (const [index, order] of active.entries()) {
        let latest = order;
        let vendorText: string;
        try {
          const result = await refreshVendorOrder(order.id);
          latest = result.vendorOrder ?? order;
          vendorText = `Vendor: ${result.outcome}${result.message ? ` — ${result.message}` : ""}`;
        } catch (err) {
          vendorText = `Vendor: failed — ${apiError(err) ?? (err instanceof Error ? err.message : "Request failed")}`;
        }
        let carrierText = "Carrier: disabled";
        if (carrierSettings?.enabled) {
          carrierText = carrierPaused ? "Carrier: paused (Shippo account blocked)" : latest.status !== "submitted" || !latest.tracking.length
            ? "Carrier: no submitted shipments known"
            : "Carrier: not checked";
          if (!carrierPaused && latest.status === "submitted" && latest.tracking.length) {
            try {
              const result = await refreshVendorOrderCarrier(order.id);
              carrierText = `Carrier: ${result.outcome}${result.message ? ` — ${result.message}` : ""}`;
              if (result.message?.startsWith("Shippo account blocked:")) carrierPaused = true;
            } catch (err) {
              carrierText = `Carrier: failed — ${apiError(err) ?? (err instanceof Error ? err.message : "Request failed")}`;
            }
          }
        }
        outcomes.push(`PO ${order.poNumber} · ${vendorText} · ${carrierText}`);
        setRefreshOutcomes([...outcomes]);
        setRefreshProgress({ done: index + 1, total: active.length, po: active[index + 1]?.poNumber ?? "" });
        invalidate();
      }
      toast({ title: "Active checks finished", description: `${active.length} orders checked. See per-order outcomes below.` });
    } finally {
      setRefreshProgress(null);
    }
  };

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold text-slate-100 flex items-center gap-2">
                <PackageSearch className="w-5 h-5 text-[#10b981]" />
                Order Tracking
              </h1>
              <p className="text-[13px] text-slate-400 mt-0.5">
                Electronic vendor orders with live SanMar / S&amp;S status and tracking.
                Checks are read-only — they never place or change orders.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-[12px] text-slate-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                  className="accent-[#059669]"
                  data-testid="checkbox-show-all"
                />
                Show previews
              </label>
              <button
                onClick={() => { void refreshActive(); }}
                disabled={!!refreshProgress || activeCount === 0}
                className="inline-flex items-center gap-2 px-3 py-2 rounded-md text-[13px] font-medium bg-[#059669]/10 text-[#10b981] border border-[#059669]/30 hover:bg-[#059669]/20 disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="button-refresh-all"
              >
                {refreshProgress ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                {refreshProgress
                  ? `Checking ${refreshProgress.done}/${refreshProgress.total} · PO ${refreshProgress.po}`
                  : `Refresh active (${activeCount})`}
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {refreshOutcomes.length > 0 && (
            <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900/70 p-3 text-xs text-slate-300" role="status">
              <div className="font-semibold text-slate-100 mb-1">Refresh outcomes {refreshProgress ? `(${refreshProgress.done}/${refreshProgress.total})` : ""}</div>
              {refreshOutcomes.some((line) => line.includes("Shippo account blocked:")) && (
                <div className="mb-2 text-amber-300">
                  Shippo needs a valid payment method before carrier checks can resume.{" "}
                  <a href="https://goshippo.com/user/billing/" target="_blank" rel="noopener noreferrer" className="underline">Open Shippo billing</a>
                </div>
              )}
              {refreshOutcomes.map((line, index) => <div key={index} className="py-0.5">{line}</div>)}
            </div>
          )}
          <div className="mb-4 rounded-lg border border-slate-700 bg-slate-900/70 p-4 text-[12px] text-slate-300">
            <div className="font-semibold text-slate-100">Carrier tracking · {carrierSettings?.enabled ? "Enabled" : "Off by default"}</div>
            <p className="mt-1">Vendor checks are free of Shippo tracking requests. External tracking via Shippo may incur usage fees. <a className="text-emerald-400 underline" href="https://support.goshippo.com/hc/en-us/articles/360003855652-Shippo-Subscription-Plan-Overview" target="_blank" rel="noopener noreferrer">Published pricing</a>: $0.02 per unique tracking number created outside Shippo (about $2 per 100), subject to your account terms. Only an admin can enable this.</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <input type="password" value={adminPin} onChange={(e) => setAdminPin(e.target.value)} placeholder="Admin PIN" aria-label="Carrier opt-in admin PIN" className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5" />
              {!carrierSettings?.enabled && <label className="flex items-center gap-2"><input type="checkbox" checked={confirmFees} onChange={(e) => setConfirmFees(e.target.checked)} /> I understand and authorize Shippo usage fees</label>}
              <button type="button" disabled={!adminPin || (!carrierSettings?.enabled && !confirmFees) || saveCarrierSettings.isPending} onClick={() => saveCarrierSettings.mutate({ data: { enabled: !carrierSettings?.enabled, adminPin, confirmFees: carrierSettings?.enabled ? false : confirmFees } })} className="rounded border border-emerald-500/40 px-3 py-1.5 text-emerald-400 disabled:opacity-40">{carrierSettings?.enabled ? "Disable paid tracking" : "Enable paid tracking"}</button>
            </div>
          </div>
          <div className="mb-4 text-xs text-slate-500">Shipment counts and delivery filters cover only packages the vendor has reported so far; they do not confirm the whole PO is complete.</div>
          <div className="mb-4 flex flex-wrap gap-2" aria-label="Shipment filters">
            {["All", "In transit", "Arriving today", "Known delivered", "Exceptions"].map((f) => (
              <button key={f} onClick={() => setFilter(f)} className={`rounded px-3 py-1.5 text-xs border ${filter === f ? "border-emerald-500 text-emerald-300 bg-emerald-500/10" : "border-slate-700 text-slate-400"}`}>{f}</button>
            ))}
          </div>
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading orders…
            </div>
          ) : visible.length === 0 ? (
            <div className="text-center py-16 text-slate-500 text-[14px]">
              No vendor orders yet. Submit a PO electronically from the PO Log and it
              will show up here.
            </div>
          ) : (
            <div className="rounded-lg border border-slate-800 overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="bg-slate-900/80 text-slate-400 text-left text-[11px] uppercase tracking-wider">
                    <th className="px-4 py-2.5 font-semibold">PO #</th>
                    <th className="px-4 py-2.5 font-semibold">Vendor</th>
                    <th className="px-4 py-2.5 font-semibold">Status</th>
                    <th className="px-4 py-2.5 font-semibold">Vendor status</th>
                    <th className="px-4 py-2.5 font-semibold">Order #</th>
                    <th className="px-4 py-2.5 font-semibold">Tracking</th>
                    <th className="px-4 py-2.5 font-semibold">Submitted</th>
                    <th className="px-4 py-2.5 font-semibold">Last check</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {visible.map((o) => {
                    const refreshable =
                      o.mode === "live" &&
                      (o.status === "submitted" || o.status === "unknown");
                    const isRefreshing =
                      refreshOne.isPending && refreshOne.variables?.id === o.id;
                    return (
                      <Fragment key={o.id}>
                        <tr
                          className={`border-t border-slate-800/80 ${
                            o.status === "unknown"
                              ? "bg-amber-500/[0.04]"
                              : "bg-[#0b1220]"
                          }`}
                          data-testid={`row-vendor-order-${o.id}`}
                        >
                          <td className="px-4 py-3 font-semibold text-slate-200">
                            {o.poNumber}
                          </td>
                          <td className="px-4 py-3 text-slate-300">
                            {VENDOR_LABELS[o.vendor] ?? o.vendor}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-1.5">
                              <StatusBadge status={o.status} />
                              <ModeBadge mode={o.mode} />
                            </div>
                          </td>
                          <td className="px-4 py-3 text-slate-300">
                            {o.vendorStatus ?? "—"}
                          </td>
                          <td className="px-4 py-3 text-slate-400">
                            {o.vendorOrderNumbers.length
                              ? o.vendorOrderNumbers.join(", ")
                              : "—"}
                          </td>
                          <td className="px-4 py-3">
                             {o.tracking.length === 0 ? (
                              <span className="text-slate-500">—</span>
                            ) : (
                              <div className="flex flex-col gap-1">
                                {o.tracking.map((t) => (
                                  <a
                                    key={t.trackingNumber}
                                    href={trackingUrl(t.carrier, t.trackingNumber)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="inline-flex items-center gap-1 text-[#10b981] hover:underline"
                                    data-testid={`link-tracking-${t.trackingNumber}`}
                                  >
                                    {t.trackingNumber}
                                    <ExternalLink className="w-3 h-3" />
                                    {t.carrier && (
                                      <span className="text-slate-500 text-[11px]">
                                        {t.carrier}
                                        {t.shipMethod ? ` ${t.shipMethod}` : ""}
                                      </span>
                                    )}
                                  </a>
                                ))}
                                 <span className="text-[11px] text-slate-400">
                                   {o.tracking.filter((t) => t.carrierStatus === "DELIVERED").length}/{o.tracking.length} known shipments delivered
                                   {o.tracking.some((t) => t.carrierStatus === "DELIVERED") && o.tracking.some((t) => t.carrierStatus !== "DELIVERED") ? " · Some known shipments still pending" : ""}
                                 </span>
                                 <button type="button" onClick={() => setExpanded((ids) => ids.includes(o.id) ? ids.filter((id) => id !== o.id) : [...ids, o.id])} className="text-left text-xs text-emerald-400 hover:underline">{expanded.includes(o.id) ? "Hide shipments" : `View ${o.tracking.length} shipment${o.tracking.length === 1 ? "" : "s"}`}</button>
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-slate-400 whitespace-nowrap">
                            {fmtDate(o.submittedAt)}
                          </td>
                          <td className="px-4 py-3 text-slate-500 whitespace-nowrap">
                            {fmtDate(o.lastStatusCheckAt)}
                          </td>
                          <td className="px-4 py-3 text-right">
                            {refreshable && (
                               <div className="flex flex-col gap-1 items-end">
                              <button
                                onClick={() => refreshOne.mutate({ id: o.id })}
                                disabled={refreshOne.isPending || !!refreshProgress}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[12px] font-medium text-slate-300 border border-slate-700 hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                                data-testid={`button-refresh-${o.id}`}
                              >
                                {isRefreshing ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <RefreshCw className="w-3.5 h-3.5" />
                                )}
                                Check vendor
                              </button>
                               {carrierSettings?.enabled && o.tracking.length > 0 && <button type="button" disabled={refreshCarrier.isPending} onClick={() => refreshCarrier.mutate({ id: o.id })} className="text-emerald-400 hover:underline disabled:opacity-40 text-xs">Check carriers</button>}
                               </div>
                            )}
                          </td>
                        </tr>
                        {expanded.includes(o.id) && o.tracking.length > 0 && (
                          <tr className="bg-slate-900/50"><td colSpan={9} className="p-4">
                            <div className="grid gap-3 md:grid-cols-2">
                              {o.tracking.map((t) => <div key={t.trackingNumber} className="rounded border border-slate-700 p-3 text-xs text-slate-300">
                                <div className="font-semibold text-slate-100">{t.carrier ?? "Carrier unknown"} · {t.trackingNumber}</div>
                                <div className="mt-1">Carrier: {t.carrierStatus?.replace("_", " ") ?? "Not checked"} {t.carrierStatusDetails ? `· ${t.carrierStatusDetails}` : ""}</div>
                                <div>Actual origin (carrier): {t.origin ?? "Not reported"}</div>
                                <div>Estimated arrival (carrier): {fmtDate(t.eta ?? null)}</div>
                                <div>Delivered (carrier): {fmtDate(t.deliveredAt ?? null)}</div>
                                <div>Shipped (vendor): {fmtDate(t.shipmentDate)}</div>
                                <div>Latest carrier event: {fmtDate(t.carrierStatusDate ?? null)}{t.carrierLocation ? ` · ${t.carrierLocation}` : ""}</div>
                                <div className="text-slate-500">Carrier last checked: {fmtDate(t.carrierCheckedAt ?? null)}</div>
                                {t.carrierError && <div className="text-amber-400">Last check failed: {t.carrierError} · showing last known data</div>}
                                {t.carrierHistory && t.carrierHistory.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-emerald-400">Carrier history</summary>
                                  <ul className="mt-1 space-y-1 border-l border-slate-700 pl-3">
                                    {t.carrierHistory.map((event, index) => <li key={`${event.date}-${index}`}>{fmtDate(event.date)} · {event.status}{event.details ? ` · ${event.details}` : ""}{event.location ? ` · ${event.location}` : ""}</li>)}
                                  </ul>
                                </details>}
                              </div>)}
                            </div>
                          </td></tr>
                        )}
                        {o.status === "unknown" && (
                          <tr className="bg-[#0b1220]">
                            <td colSpan={9} className="p-0">
                              <ReconcilePanel order={o} />
                            </td>
                          </tr>
                        )}
                        {o.status === "failed" && o.error && (
                          <tr className="bg-[#0b1220]">
                            <td colSpan={9} className="px-4 pb-3 pt-0">
                              <div className="text-[12px] text-red-400/70 truncate" title={o.error}>
                                {o.error}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
