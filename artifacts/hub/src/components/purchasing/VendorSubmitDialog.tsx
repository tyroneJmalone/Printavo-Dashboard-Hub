import { useEffect, useState } from "react";
import {
  useVendorSubmit,
  getListPoFilesQueryKey,
  type PoFile,
  type VendorSubmitResult,
  type VendorSubmitRequestMode,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { formatNumber } from "@/lib/format";
import {
  Loader2,
  Truck,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  HelpCircle,
  ShieldQuestion,
  MapPin,
} from "lucide-react";

const VENDOR_LABELS: Record<string, string> = {
  sanmar: "SanMar",
  ss: "S&S Activewear",
};

function apiError(err: unknown): string | undefined {
  const e = err as { data?: { error?: string }; message?: string } | undefined;
  return e?.data?.error ?? e?.message;
}

const money = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD" });

function isElectronicVendor(vendor: string): boolean {
  return vendor === "sanmar" || vendor === "ss";
}

export function VendorSubmitButton({ po }: { po: PoFile }) {
  const [open, setOpen] = useState(false);
  if (!isElectronicVendor(po.vendorName)) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-colors"
      >
        <Truck size={13} />
        Order from {VENDOR_LABELS[po.vendorName] ?? po.vendorName}
      </button>
      {open && (
        <VendorSubmitDialog po={po} open={open} onOpenChange={setOpen} />
      )}
    </>
  );
}

function VendorSubmitDialog({
  po,
  open,
  onOpenChange,
}: {
  po: PoFile;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [pin, setPin] = useState("");
  const [result, setResult] = useState<VendorSubmitResult | null>(null);
  const [didSubmit, setDidSubmit] = useState(false);

  const submit = useVendorSubmit({
    mutation: {
      onSuccess: (data) => {
        setResult(data);
        if (data.outcome === "submitted") {
          setDidSubmit(true);
          toast({
            title: `PO ${po.poNumber} ordered from ${VENDOR_LABELS[po.vendorName] ?? po.vendorName}`,
            description:
              data.vendorOrder?.vendorOrderNumbers.length
                ? `Vendor order #${data.vendorOrder.vendorOrderNumbers.join(", ")}`
                : "The order was placed.",
          });
        }
      },
      onError: (err) => {
        toast({
          title: "Vendor submit failed",
          description: apiError(err) ?? "The request did not complete",
          variant: "destructive",
        });
      },
    },
  });

  // Run a no-network dry-run preview whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setResult(null);
      setPin("");
      setDidSubmit(false);
      submit.mutate({ id: po.id, data: { mode: "dry_run" } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, po.id]);

  const run = (mode: VendorSubmitRequestMode) => {
    submit.mutate({
      id: po.id,
      data: { mode, adminPin: pin.trim() || undefined },
    });
  };

  const eligibility = result?.eligibility ?? null;
  const preview = result?.preview ?? null;
  const eligible = eligibility?.ok === true;
  const submitted = result?.outcome === "submitted";
  const terminal =
    result?.outcome === "submitted" || result?.outcome === "already_active";

  const vendorLabel = VENDOR_LABELS[po.vendorName] ?? po.vendorName;

  // Defer the PO-list refetch until the dialog closes, so a successful live
  // submit keeps the confirmation (with vendor order #s) on screen instead of
  // the row flipping to "submitted" and unmounting this dialog mid-view.
  const handleClose = (v: boolean) => {
    if (!v && didSubmit) {
      queryClient.invalidateQueries({ queryKey: getListPoFilesQueryKey() });
    }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="bg-[#0f172a] border-slate-800 text-slate-100 max-w-2xl max-h-[90vh] overflow-y-auto custom-scrollbar">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-slate-100">
            <Truck size={17} className="text-emerald-400" />
            Order PO {po.poNumber} from {vendorLabel}
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            Review the order below, then send it to {vendorLabel}. A preview never
            touches the vendor — only a real submit places the order.
          </DialogDescription>
        </DialogHeader>

        {submit.isPending && !result && (
          <div className="flex items-center justify-center py-10 text-slate-500 gap-2">
            <Loader2 size={18} className="animate-spin" /> Building preview…
          </div>
        )}

        {result && (
          <div className="space-y-4">
            <OutcomeBanner result={result} vendorLabel={vendorLabel} />

            {eligibility && !eligible && eligibility.blockers.length > 0 && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
                <div className="text-xs font-semibold text-red-300 mb-1.5 flex items-center gap-1.5">
                  <XCircle size={13} /> Can't order yet
                </div>
                <ul className="text-xs text-red-200/90 space-y-1 list-disc pl-4">
                  {eligibility.blockers.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              </div>
            )}

            {eligibility && eligibility.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
                <div className="text-xs font-semibold text-amber-300 mb-1.5 flex items-center gap-1.5">
                  <AlertTriangle size={13} /> Heads up
                </div>
                <ul className="text-xs text-amber-200/90 space-y-1 list-disc pl-4">
                  {eligibility.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {preview && <PreviewCard preview={preview} />}

            {!terminal && (
              <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-4 space-y-3">
                <div className="text-xs font-semibold text-slate-300">
                  Send to {vendorLabel}
                </div>
                <label className="flex flex-col gap-1.5 text-[11px] text-slate-400 font-semibold uppercase tracking-wide">
                  Admin PIN
                  <input
                    type="password"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    placeholder="Required for a real order"
                    className="bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669] placeholder:text-slate-600 max-w-xs"
                  />
                </label>
                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={() => run("test")}
                    disabled={!eligible || !pin.trim() || submit.isPending}
                    className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 hover:bg-slate-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submit.isPending ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <ShieldQuestion size={13} />
                    )}
                    Send test order
                  </button>
                  <button
                    onClick={() => {
                      if (
                        window.confirm(
                          `Place a REAL order with ${vendorLabel} for PO ${po.poNumber}?\n\n${preview ? `${preview.totalQuantity} units · ${money(preview.totalCost)}` : ""}\n\nThis submits the order to the vendor and locks the PO.`,
                        )
                      )
                        run("live");
                    }}
                    disabled={!eligible || !pin.trim() || submit.isPending}
                    className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {submit.isPending ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Truck size={13} />
                    )}
                    Place live order
                  </button>
                </div>
              </div>
            )}

            {submitted && (
              <div className="flex justify-end">
                <button
                  onClick={() => handleClose(false)}
                  className="text-xs font-semibold px-4 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors"
                >
                  Done
                </button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function OutcomeBanner({
  result,
  vendorLabel,
}: {
  result: VendorSubmitResult;
  vendorLabel: string;
}) {
  const { outcome, mode, message, vendorOrder } = result;

  if (outcome === "submitted") {
    return (
      <Banner tone="success" icon={<CheckCircle2 size={14} />}>
        {mode === "test" ? "Test order accepted" : "Order placed"} with{" "}
        {vendorLabel}
        {vendorOrder?.vendorOrderNumbers.length
          ? ` — vendor order #${vendorOrder.vendorOrderNumbers.join(", ")}`
          : ""}
        .
      </Banner>
    );
  }
  if (outcome === "failed") {
    return (
      <Banner tone="error" icon={<XCircle size={14} />}>
        {message ?? "The vendor rejected the order. Nothing was ordered."}
      </Banner>
    );
  }
  if (outcome === "unknown") {
    return (
      <Banner tone="warn" icon={<HelpCircle size={14} />}>
        {message ??
          "The vendor didn't confirm clearly. Check the vendor portal before re-sending — the order may or may not have gone through."}
      </Banner>
    );
  }
  if (outcome === "already_active" || outcome === "in_progress") {
    return (
      <Banner tone="warn" icon={<AlertTriangle size={14} />}>
        {message ??
          "There's already an active order for this PO — nothing was sent again."}
      </Banner>
    );
  }
  if (outcome === "not_configured") {
    return (
      <Banner tone="warn" icon={<AlertTriangle size={14} />}>
        {message ?? "This vendor isn't set up for electronic ordering."}
      </Banner>
    );
  }
  // preview / ineligible — only surface a message if the server sent one.
  if (message) {
    return (
      <Banner tone="info" icon={<AlertTriangle size={14} />}>
        {message}
      </Banner>
    );
  }
  return null;
}

function Banner({
  tone,
  icon,
  children,
}: {
  tone: "success" | "error" | "warn" | "info";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const cls =
    tone === "success"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
      : tone === "error"
        ? "border-red-500/30 bg-red-500/10 text-red-200"
        : tone === "warn"
          ? "border-amber-500/30 bg-amber-500/10 text-amber-200"
          : "border-sky-500/30 bg-sky-500/10 text-sky-200";
  return (
    <div className={`rounded-lg border px-4 py-3 text-xs flex items-start gap-2 ${cls}`}>
      <span className="mt-0.5 flex-shrink-0">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

function PreviewCard({
  preview,
}: {
  preview: NonNullable<VendorSubmitResult["preview"]>;
}) {
  const shipTo = preview.shipTo;
  return (
    <div className="rounded-lg border border-slate-800 overflow-hidden">
      <div className="px-4 py-3 bg-slate-900/60 border-b border-slate-800 grid grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold flex items-center gap-1">
            <MapPin size={10} /> Ship to
          </div>
          {shipTo ? (
            <div className="text-xs text-slate-300 mt-1 leading-relaxed">
              <div className="font-semibold text-slate-200">{shipTo.companyName}</div>
              {shipTo.attention && <div>Attn: {shipTo.attention}</div>}
              <div>{shipTo.address1}</div>
              {shipTo.address2 && <div>{shipTo.address2}</div>}
              <div>
                {shipTo.city}, {shipTo.state} {shipTo.zip}
              </div>
            </div>
          ) : (
            <div className="text-xs text-amber-300 mt-1">
              No ship-to set — add one in Settings.
            </div>
          )}
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 font-bold">
            Ship method
          </div>
          <div className="text-xs text-slate-300 mt-1">
            {preview.shipMethod ?? "—"}
            {preview.shipMethodVendorCode ? (
              <span className="text-slate-500"> ({preview.shipMethodVendorCode})</span>
            ) : null}
          </div>
          <div className="mt-3 text-[10px] uppercase tracking-wide text-slate-500 font-bold">
            Totals
          </div>
          <div className="text-xs text-slate-300 mt-1">
            {formatNumber(preview.totalQuantity)} units · {money(preview.totalCost)}
          </div>
        </div>
      </div>

      <div className="max-h-56 overflow-y-auto custom-scrollbar">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-slate-900/80 text-slate-500">
            <tr className="text-left">
              <th className="px-3 py-2 font-semibold">Style</th>
              <th className="px-3 py-2 font-semibold">Color</th>
              <th className="px-3 py-2 font-semibold">Size</th>
              <th className="px-3 py-2 font-semibold text-right">Qty</th>
              <th className="px-3 py-2 font-semibold">Warehouse</th>
              <th className="px-3 py-2 font-semibold text-right">Unit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70">
            {preview.lines.map((l, i) => (
              <tr key={i} className="text-slate-300">
                <td className="px-3 py-1.5 font-mono">{l.style}</td>
                <td className="px-3 py-1.5">{l.color}</td>
                <td className="px-3 py-1.5">{l.size}</td>
                <td className="px-3 py-1.5 text-right font-semibold">
                  {formatNumber(l.quantity)}
                </td>
                <td className="px-3 py-1.5 font-mono text-slate-400">
                  {l.warehouseCode}
                </td>
                <td className="px-3 py-1.5 text-right">{money(l.unitCost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
