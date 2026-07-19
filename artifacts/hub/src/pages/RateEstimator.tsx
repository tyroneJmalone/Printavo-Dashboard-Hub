import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { AppShell } from "@/components/layout/AppShell";
import { ComparisonTable } from "@/components/shipping/ComparisonTable";
import {
  presetBoxes,
  US_STATES,
  ITEM_WEIGHTS_OZ,
  parseBlockAddress,
} from "@/components/shipping/constants";
import {
  useShippingGetRates,
  type RateResponse,
  type ApiError,
} from "@workspace/api-client-react";
import {
  Package,
  MapPin,
  Truck,
  Scale,
  Ruler,
  Loader2,
  AlertCircle,
  DollarSign,
  Box,
  GitCompareArrows,
  ClipboardPaste,
  FormInput,
  Shirt,
  Calculator,
  HardHat,
} from "lucide-react";

const formSchema = z.object({
  street1: z.string().min(1, "Street address is required"),
  street2: z.string().optional(),
  city: z.string().min(1, "City is required"),
  state: z.string().min(2, "State is required"),
  postalCode: z.string().min(5, "ZIP code is required"),
  country: z.string().default("US"),
  presetId: z.string().optional(),
  length: z.coerce.number().min(0.1, "Required"),
  width: z.coerce.number().min(0.1, "Required"),
  height: z.coerce.number().min(0.1, "Required"),
  weight: z.coerce.number().min(0.1, "Required"),
  weightUnit: z.enum(["pounds", "ounces"]).default("pounds"),
});

type FormValues = z.infer<typeof formSchema>;

const inputCls =
  "w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669] disabled:opacity-50 disabled:cursor-not-allowed placeholder:text-slate-500";
const labelCls = "text-[11px] font-semibold text-slate-300 mb-1 block";
const errCls = "text-[11px] text-red-400 mt-1";

function SectionCard({
  icon,
  title,
  right,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl">
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <h2 className="text-sm font-bold text-white flex items-center gap-2">
          {icon}
          {title}
        </h2>
        {right}
      </div>
      <div className="p-4 space-y-2.5">{children}</div>
    </div>
  );
}

export default function RateEstimator() {
  const [selectedPreset, setSelectedPreset] = useState<string>("custom");
  const [rateData, setRateData] = useState<RateResponse | null>(null);
  const [addressMode, setAddressMode] = useState<"fields" | "paste">("fields");
  const [pasteText, setPasteText] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [itemCounts, setItemCounts] = useState({ teeShirt: 0, sweatshirt: 0, jacket: 0, hat: 0 });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      street1: "",
      street2: "",
      city: "",
      state: "",
      postalCode: "",
      country: "US",
      presetId: "custom",
      length: 0,
      width: 0,
      height: 0,
      weight: 0,
      weightUnit: "pounds",
    },
  });

  const rateMutation = useShippingGetRates({
    mutation: {
      onMutate: () => {
        setRateData(null);
      },
      onSuccess: (data) => {
        setRateData(data);
      },
    },
  });

  function calcTotalOz() {
    return (
      itemCounts.teeShirt * ITEM_WEIGHTS_OZ.teeShirt +
      itemCounts.sweatshirt * ITEM_WEIGHTS_OZ.sweatshirt +
      itemCounts.jacket * ITEM_WEIGHTS_OZ.jacket +
      itemCounts.hat * ITEM_WEIGHTS_OZ.hat
    );
  }

  function updateItemCount(item: keyof typeof itemCounts, value: number) {
    const clamped = Math.max(0, Math.floor(value) || 0);
    const updated = { ...itemCounts, [item]: clamped };
    setItemCounts(updated);
    const totalOz =
      updated.teeShirt * ITEM_WEIGHTS_OZ.teeShirt +
      updated.sweatshirt * ITEM_WEIGHTS_OZ.sweatshirt +
      updated.jacket * ITEM_WEIGHTS_OZ.jacket +
      updated.hat * ITEM_WEIGHTS_OZ.hat;
    if (totalOz > 0) {
      form.setValue("weight", Math.ceil(totalOz / 16));
      form.setValue("weightUnit", "pounds");
    }
  }

  function handlePasteApply() {
    const parsed = parseBlockAddress(pasteText);
    if (!parsed) {
      setParseError(
        "Couldn't parse that address. Try a format like:\n3029 North Belfast Avenue\nAugusta, Maine 04330"
      );
      return;
    }
    setParseError(null);
    form.setValue("street1", parsed.street1);
    form.setValue("street2", parsed.street2);
    form.setValue("city", parsed.city);
    form.setValue("state", parsed.state);
    form.setValue("postalCode", parsed.postalCode);
    setAddressMode("fields");
    setPasteText("");
  }

  function handlePresetChange(presetId: string) {
    setSelectedPreset(presetId);
    form.setValue("presetId", presetId);
    const preset = presetBoxes.find((b) => b.id === presetId);
    if (preset && preset.id !== "custom") {
      form.setValue("length", preset.length);
      form.setValue("width", preset.width);
      form.setValue("height", preset.height);
    }
  }

  function onSubmit(values: FormValues) {
    rateMutation.mutate({
      data: {
        shipTo: {
          street1: values.street1,
          street2: values.street2,
          city: values.city,
          state: values.state,
          postalCode: values.postalCode,
          country: values.country,
        },
        package: {
          presetId: values.presetId,
          length: values.length,
          width: values.width,
          height: values.height,
          weight: values.weight,
          weightUnit: values.weightUnit,
        },
        source: "both",
      },
    });
  }

  const errors = form.formState.errors;
  const isCustom = selectedPreset === "custom";
  const hasResults = rateData !== null;
  const hasShipStation = !!rateData?.shipstation;
  const hasEasyPost = !!rateData?.easypost;

  const apiError = rateMutation.error as ApiError<{ error?: string }> | null;
  const apiErrorMessage =
    (apiError?.data && typeof apiError.data === "object" && apiError.data.error) ||
    apiError?.message ||
    "Something went wrong. Please check your inputs and try again.";

  const numberField = (name: "length" | "width" | "height", placeholder: string) => (
    <div>
      <input
        type="number"
        step="0.01"
        placeholder={placeholder}
        disabled={!isCustom}
        className={inputCls}
        {...form.register(name, {
          setValueAs: (v) => parseFloat(v) || 0,
        })}
      />
      {errors[name] && <p className={errCls}>{errors[name]?.message}</p>}
    </div>
  );

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
              <Truck className="text-[#10b981]" size={24} />
              Rate Estimator
            </h1>
            <p className="text-xs text-slate-400 mt-1">
              Compare live USPS and UPS rates from ShipStation and EasyPost.
            </p>
          </div>
          <div className="hidden sm:flex items-center gap-2 text-xs text-slate-500">
            <MapPin className="h-3.5 w-3.5" />
            <span>Ships from 125 Northeastern Blvd, Nashua, NH 03062</span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-5 gap-6">
            <div className="lg:col-span-2">
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <SectionCard
                  icon={<MapPin className="h-3.5 w-3.5 text-[#10b981]" />}
                  title="Ship To Address"
                  right={
                    <div className="flex items-center gap-1 bg-slate-800 rounded-lg p-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          setAddressMode("fields");
                          setParseError(null);
                        }}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-all ${
                          addressMode === "fields"
                            ? "bg-slate-900 text-white shadow-sm"
                            : "text-slate-400 hover:text-white"
                        }`}
                      >
                        <FormInput className="h-3 w-3" />
                        Fields
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setAddressMode("paste");
                          setParseError(null);
                        }}
                        className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-all ${
                          addressMode === "paste"
                            ? "bg-slate-900 text-white shadow-sm"
                            : "text-slate-400 hover:text-white"
                        }`}
                      >
                        <ClipboardPaste className="h-3 w-3" />
                        Paste
                      </button>
                    </div>
                  }
                >
                  {addressMode === "paste" ? (
                    <div className="space-y-2">
                      <div>
                        <label className={labelCls}>Paste full address</label>
                        <textarea
                          value={pasteText}
                          onChange={(e) => {
                            setPasteText(e.target.value);
                            setParseError(null);
                          }}
                          rows={3}
                          className={`${inputCls} font-mono resize-none`}
                        />
                        <p className="text-[10px] text-slate-500 mt-1">
                          Street on first line, City, State ZIP on last line
                        </p>
                      </div>
                      {parseError && (
                        <div className="flex items-start gap-2 p-2 rounded-md bg-red-500/5 border border-red-500/20">
                          <AlertCircle className="h-3.5 w-3.5 text-red-400 mt-0.5 flex-shrink-0" />
                          <p className="text-xs text-red-400 whitespace-pre-line">{parseError}</p>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={handlePasteApply}
                        disabled={!pasteText.trim()}
                        className="w-full h-8 text-xs font-semibold rounded-lg bg-slate-800 border border-slate-700 text-slate-200 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
                      >
                        <ClipboardPaste className="h-3 w-3" />
                        Parse &amp; Fill Address
                      </button>
                    </div>
                  ) : (
                    <>
                      <div>
                        <label className={labelCls}>Street Address</label>
                        <input placeholder="123 Main St" className={inputCls} {...form.register("street1")} />
                        {errors.street1 && <p className={errCls}>{errors.street1.message}</p>}
                      </div>
                      <div>
                        <label className={labelCls}>Apt / Suite / Unit</label>
                        <input placeholder="Apt 4B (optional)" className={inputCls} {...form.register("street2")} />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className={labelCls}>City</label>
                          <input placeholder="City" className={inputCls} {...form.register("city")} />
                          {errors.city && <p className={errCls}>{errors.city.message}</p>}
                        </div>
                        <div>
                          <label className={labelCls}>State</label>
                          <select className={inputCls} {...form.register("state")}>
                            <option value="">State</option>
                            {US_STATES.map((s) => (
                              <option key={s.code} value={s.code}>
                                {s.code} - {s.name}
                              </option>
                            ))}
                          </select>
                          {errors.state && <p className={errCls}>{errors.state.message}</p>}
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className={labelCls}>ZIP Code</label>
                          <input placeholder="10001" className={inputCls} {...form.register("postalCode")} />
                          {errors.postalCode && <p className={errCls}>{errors.postalCode.message}</p>}
                        </div>
                        <div>
                          <label className={labelCls}>Country</label>
                          <input className={inputCls} disabled {...form.register("country")} />
                        </div>
                      </div>
                    </>
                  )}
                </SectionCard>

                <SectionCard icon={<Box className="h-3.5 w-3.5 text-[#10b981]" />} title="Package Details">
                  <div>
                    <label className={labelCls}>Box Type</label>
                    <select
                      value={selectedPreset}
                      onChange={(e) => handlePresetChange(e.target.value)}
                      className={inputCls}
                    >
                      <option value="custom">Custom Dimensions</option>
                      {presetBoxes
                        .filter((b) => b.id !== "custom")
                        .map((box) => (
                          <option key={box.id} value={box.id}>
                            {box.name} ({box.length}" x {box.width}" x {box.height}")
                          </option>
                        ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-[11px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                      <Ruler className="h-3 w-3" />
                      Dimensions (inches)
                    </label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {numberField("length", "Length")}
                      {numberField("width", "Width")}
                      {numberField("height", "Height")}
                    </div>
                  </div>

                  <div className="border-t border-slate-800 pt-2.5">
                    <label className="text-[11px] font-semibold text-slate-400 mb-1 flex items-center gap-1">
                      <Scale className="h-3 w-3" />
                      Weight (lbs)
                    </label>
                    <input
                      type="number"
                      step="1"
                      placeholder="Weight in lbs"
                      className={inputCls}
                      {...form.register("weight", { setValueAs: (v) => parseFloat(v) || 0 })}
                    />
                    {errors.weight && <p className={errCls}>{errors.weight.message}</p>}
                  </div>
                </SectionCard>

                <SectionCard icon={<Calculator className="h-3.5 w-3.5 text-[#10b981]" />} title="Weight Calculator">
                  <p className="text-[10px] text-slate-500 -mt-0.5">
                    Enter item quantities to auto-calculate weight
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { key: "teeShirt" as const, label: "Tee Shirt", ozPer: 10, icon: <Shirt className="h-3 w-3" /> },
                      { key: "sweatshirt" as const, label: "Sweatshirt", ozPer: 20, icon: <Shirt className="h-3 w-3" /> },
                      { key: "jacket" as const, label: "Jacket", ozPer: 30, icon: <Shirt className="h-3 w-3" /> },
                      { key: "hat" as const, label: "Hat", ozPer: 5, icon: <HardHat className="h-3 w-3" /> },
                    ].map((item) => (
                      <div key={item.key} className="space-y-0.5">
                        <label className="text-[11px] font-medium text-slate-300 flex items-center gap-1">
                          {item.icon}
                          {item.label}
                          <span className="text-[10px] text-slate-500 font-normal">({item.ozPer}oz)</span>
                        </label>
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={itemCounts[item.key] || ""}
                          onChange={(e) => updateItemCount(item.key, parseInt(e.target.value))}
                          className={inputCls}
                        />
                      </div>
                    ))}
                  </div>
                  {calcTotalOz() > 0 && (
                    <div className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-emerald-500/5 border border-emerald-500/20">
                      <span className="text-[11px] font-medium text-slate-200">
                        {calcTotalOz()} oz → {Math.ceil(calcTotalOz() / 16)} lbs
                      </span>
                      <span className="text-[10px] text-slate-500">Rounded up, auto-applied</span>
                    </div>
                  )}
                </SectionCard>

                <button
                  type="submit"
                  disabled={rateMutation.isPending}
                  className="w-full h-10 text-sm font-semibold rounded-lg bg-[#059669] hover:bg-[#047857] text-white disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2 transition-colors"
                >
                  {rateMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Getting Rates...
                    </>
                  ) : (
                    <>
                      <DollarSign className="h-4 w-4" />
                      Get Shipping Rates
                    </>
                  )}
                </button>
              </form>
            </div>

            <div className="lg:col-span-3">
              {!hasResults && !rateMutation.isPending && !rateMutation.isError && (
                <div className="h-full flex items-center justify-center min-h-[400px]">
                  <div className="text-center space-y-4 max-w-sm">
                    <div className="mx-auto w-20 h-20 rounded-2xl bg-emerald-500/10 flex items-center justify-center">
                      <Package className="h-10 w-10 text-[#10b981]" />
                    </div>
                    <div>
                      <h3 className="text-lg font-semibold text-white">Ready to Compare Rates</h3>
                      <p className="text-sm text-slate-400 mt-1">
                        Enter a destination address and package details to see real-time USPS and UPS
                        shipping rates from Mint Printworks.
                      </p>
                    </div>
                    <div className="flex items-center justify-center gap-2 text-xs text-slate-500">
                      <MapPin className="h-3.5 w-3.5" />
                      <span>Shipping from Nashua, NH 03062</span>
                    </div>
                  </div>
                </div>
              )}

              {rateMutation.isPending && (
                <div className="h-full flex items-center justify-center min-h-[400px]">
                  <div className="text-center space-y-4">
                    <div className="mx-auto w-16 h-16 rounded-2xl bg-emerald-500/10 flex items-center justify-center animate-pulse">
                      <Truck className="h-8 w-8 text-[#10b981]" />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-white">Fetching Live Rates</h3>
                      <p className="text-sm text-slate-400 mt-1">
                        Checking ShipStation and EasyPost for the best options...
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {rateMutation.isError && !hasResults && (
                <div className="h-full flex items-center justify-center min-h-[400px]">
                  <div className="text-center space-y-4 max-w-sm">
                    <div className="mx-auto w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center">
                      <AlertCircle className="h-8 w-8 text-red-400" />
                    </div>
                    <div>
                      <h3 className="text-base font-semibold text-white">Unable to Fetch Rates</h3>
                      <p className="text-sm text-slate-400 mt-1">{apiErrorMessage}</p>
                    </div>
                    <button
                      onClick={() => form.handleSubmit(onSubmit)()}
                      className="px-4 h-9 text-sm font-medium rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800"
                    >
                      Try Again
                    </button>
                  </div>
                </div>
              )}

              {hasResults && rateData && (
                <div className="space-y-6">
                  <h2 className="text-base font-semibold text-white flex items-center gap-2">
                    <GitCompareArrows className="h-4 w-4 text-[#10b981]" />
                    Rate Comparison
                  </h2>

                  {hasShipStation && hasEasyPost && (
                    <div className="space-y-6">
                      <ComparisonTable
                        ssRates={rateData.shipstation!.uspsRates}
                        epRates={rateData.easypost!.uspsRates}
                        carrierLabel="USPS"
                      />
                      <ComparisonTable
                        ssRates={rateData.shipstation!.upsRates}
                        epRates={rateData.easypost!.upsRates}
                        carrierLabel="UPS"
                      />
                      {rateData.shipstation!.uspsRates.length === 0 &&
                        rateData.shipstation!.upsRates.length === 0 &&
                        rateData.easypost!.uspsRates.length === 0 &&
                        rateData.easypost!.upsRates.length === 0 && (
                          <div className="text-center py-8 text-slate-500">
                            <Package className="h-8 w-8 mx-auto mb-2 opacity-50" />
                            <p className="text-sm">No rates to compare.</p>
                          </div>
                        )}

                      {[...(rateData.shipstation?.errors || []), ...(rateData.easypost?.errors || [])]
                        .length > 0 && (
                        <div className="flex items-start gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                          <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 flex-shrink-0" />
                          <div className="text-sm text-red-400">
                            {[...(rateData.shipstation?.errors || []), ...(rateData.easypost?.errors || [])].map(
                              (err, i) => (
                                <p key={i}>{err}</p>
                              )
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {(!hasShipStation || !hasEasyPost) && (
                    <div className="text-center py-8 text-slate-500">
                      <AlertCircle className="h-8 w-8 mx-auto mb-2 opacity-50" />
                      <p className="text-sm">Need data from both sources to show comparison table.</p>
                      {[...(rateData.shipstation?.errors || []), ...(rateData.easypost?.errors || [])].map(
                        (err, i) => (
                          <p key={i} className="text-xs text-red-400 mt-1">
                            {err}
                          </p>
                        )
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}
