import { Clock } from "lucide-react";
import type { ShippingRate } from "@workspace/api-client-react";
import { normalizeServiceKey } from "./constants";

function ComparisonRow({
  serviceName,
  ssRate,
  epRate,
}: {
  serviceName: string;
  ssRate?: ShippingRate;
  epRate?: ShippingRate;
}) {
  const diff = ssRate && epRate ? epRate.totalCost - ssRate.totalCost : null;
  const pctDiff =
    ssRate && epRate && ssRate.totalCost > 0
      ? ((epRate.totalCost - ssRate.totalCost) / ssRate.totalCost) * 100
      : null;

  const transitDays = epRate?.transitDays ?? ssRate?.transitDays ?? null;
  const isGroundSaver = serviceName === "UPS Ground Saver";
  const transitLabel =
    transitDays !== null && transitDays !== undefined
      ? `${transitDays} ${transitDays === 1 ? "day" : "days"}`
      : isGroundSaver
        ? "Ground +1 day"
        : null;

  return (
    <div className="grid grid-cols-4 gap-3 items-center py-2.5 border-b border-slate-800/70 last:border-0">
      <div className="col-span-1">
        <p className="text-xs font-medium text-slate-200 truncate">{serviceName}</p>
        {transitLabel ? (
          <p className="text-[10px] text-slate-500 flex items-center gap-0.5 mt-0.5">
            <Clock className="h-2.5 w-2.5" />
            {transitLabel}
          </p>
        ) : (
          <p className="text-[10px] text-slate-500 mt-0.5">–</p>
        )}
      </div>
      <div className="text-center">
        {ssRate ? (
          <span className="text-sm font-semibold text-slate-100">${ssRate.totalCost.toFixed(2)}</span>
        ) : (
          <span className="text-xs text-slate-500">--</span>
        )}
      </div>
      <div className="text-center">
        {epRate ? (
          <span className="text-sm font-semibold text-slate-100">${epRate.totalCost.toFixed(2)}</span>
        ) : (
          <span className="text-xs text-slate-500">--</span>
        )}
      </div>
      <div className="text-center">
        {diff !== null ? (
          <span
            className={`text-xs font-semibold ${
              diff > 0 ? "text-red-500" : diff < 0 ? "text-emerald-500" : "text-slate-500"
            }`}
          >
            {diff > 0 ? "+" : ""}
            {diff.toFixed(2)}
            {pctDiff !== null && (
              <span className="text-[10px] font-normal ml-0.5">
                ({pctDiff > 0 ? "+" : ""}
                {pctDiff.toFixed(1)}%)
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs text-slate-500">--</span>
        )}
      </div>
    </div>
  );
}

export function ComparisonTable({
  ssRates,
  epRates,
  carrierLabel,
}: {
  ssRates: ShippingRate[];
  epRates: ShippingRate[];
  carrierLabel: string;
}) {
  const ssNormalized = ssRates.map((r) => ({ ...r, normalKey: normalizeServiceKey(r.serviceCode) }));
  const epNormalized = epRates.map((r) => ({ ...r, normalKey: normalizeServiceKey(r.serviceCode) }));

  const allKeys = new Set<string>();
  ssNormalized.forEach((r) => allKeys.add(r.normalKey));
  epNormalized.forEach((r) => allKeys.add(r.normalKey));

  if (allKeys.size === 0) return null;

  const ssMap = new Map(ssNormalized.map((r) => [r.normalKey, r]));
  const epMap = new Map(epNormalized.map((r) => [r.normalKey, r]));

  const sortedKeys = Array.from(allKeys).sort((a, b) => {
    const aCost = ssMap.get(a)?.totalCost ?? epMap.get(a)?.totalCost ?? 999;
    const bCost = ssMap.get(b)?.totalCost ?? epMap.get(b)?.totalCost ?? 999;
    return aCost - bCost;
  });

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-white">{carrierLabel} Comparison</h4>
      <div className="rounded-lg border border-slate-800 overflow-hidden">
        <div className="grid grid-cols-4 gap-3 bg-slate-800/50 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          <div>Service</div>
          <div className="text-center">ShipStation</div>
          <div className="text-center">EasyPost</div>
          <div className="text-center">Difference</div>
        </div>
        <div className="px-3">
          {sortedKeys.map((key) => (
            <ComparisonRow key={key} serviceName={key} ssRate={ssMap.get(key)} epRate={epMap.get(key)} />
          ))}
        </div>
      </div>
    </div>
  );
}
