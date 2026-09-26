import { useEffect, useState } from "react";
import { Link, useSearch } from "wouter";
import { AppShell, SettingsEmbed } from "@/components/layout/AppShell";
import { canOpenSettingsSection, resolveSettingsSection, settingsHref, settingsSections, type SettingsGroup } from "./settingsNavigation";
import KnowledgeBase from "./KnowledgeBase";
import AiContext from "./AiContext";
import VoiceProfiles from "./VoiceProfiles";
import EmailAccess from "./EmailAccess";
import EmailActivitySettings from "./EmailActivitySettings";
import PrintQueueRules from "./PrintQueueRules";
import AutoPrint from "./AutoPrint";
import StatusRules from "./StatusRules";
import {
  useGetVendorShipTo,
  useSetVendorShipTo,
  getGetVendorShipToQueryKey,
  type VendorShipTo,
  VendorShipToDefaultShipMethod,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useStaff } from "@/components/auth/StaffGate";
import { StaffAccessCard } from "@/components/settings/StaffAccessCard";
import { ModuleAccessCard } from "@/components/settings/ModuleAccessCard";
import { AdminPinCard } from "@/components/settings/AdminPinCard";
import { Settings as SettingsIcon, Loader2, Truck, Save } from "lucide-react";

function apiError(err: unknown): string | undefined {
  const e = err as { data?: { error?: string }; message?: string } | undefined;
  return e?.data?.error ?? e?.message;
}

const SHIP_METHOD_LABELS: Record<string, string> = {
  GROUND: "Ground",
  "2DAY": "2-Day Air",
  OVERNIGHT: "Overnight",
};

type ShipToForm = {
  companyName: string;
  attention: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  zip: string;
  email: string;
  residential: boolean;
  defaultShipMethod: VendorShipTo["defaultShipMethod"];
};

const EMPTY_FORM: ShipToForm = {
  companyName: "",
  attention: "",
  address1: "",
  address2: "",
  city: "",
  state: "",
  zip: "",
  email: "",
  residential: false,
  defaultShipMethod: "GROUND",
};

function toForm(s: VendorShipTo): ShipToForm {
  return {
    companyName: s.companyName,
    attention: s.attention ?? "",
    address1: s.address1,
    address2: s.address2 ?? "",
    city: s.city,
    state: s.state,
    zip: s.zip,
    email: s.email ?? "",
    residential: s.residential,
    defaultShipMethod: s.defaultShipMethod,
  };
}

const inputCls =
  "bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669] placeholder:text-slate-600";
const labelCls =
  "flex flex-col gap-1.5 text-[11px] text-slate-400 font-semibold uppercase tracking-wide";

function GeneralShipping() {
  const { toast } = useToast();
  const me = useStaff();
  const queryClient = useQueryClient();
  // Ship-to lives under /purchasing — don't fetch (or render) it for staff
  // whose Purchasing module is switched off, or the call just 403s.
  const canPurchasing =
    me.role === "admin" || me.enabledModules.includes("purchasing");
  const { data, isLoading } = useGetVendorShipTo({
    query: { queryKey: getGetVendorShipToQueryKey(), enabled: canPurchasing },
  });

  const [form, setForm] = useState<ShipToForm>(EMPTY_FORM);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!hydrated && data) {
      if (data.shipTo) setForm(toForm(data.shipTo));
      setHydrated(true);
    }
  }, [data, hydrated]);

  const save = useSetVendorShipTo({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetVendorShipToQueryKey() });
        toast({
          title: "Ship-to address saved",
          description: "New vendor orders will ship to this address.",
        });
      },
      onError: (err) => {
        toast({
          title: "Could not save address",
          description: apiError(err) ?? "Save failed",
          variant: "destructive",
        });
      },
    },
  });

  const set = <K extends keyof ShipToForm>(key: K, value: ShipToForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const requiredMissing =
    !form.companyName.trim() ||
    !form.address1.trim() ||
    !form.city.trim() ||
    !form.state.trim() ||
    !form.zip.trim();

  const onSave = (e: React.FormEvent) => {
    e.preventDefault();
    if (requiredMissing) return;
    const payload: VendorShipTo = {
      companyName: form.companyName.trim(),
      attention: form.attention.trim() || null,
      address1: form.address1.trim(),
      address2: form.address2.trim() || null,
      city: form.city.trim(),
      state: form.state.trim(),
      zip: form.zip.trim(),
      email: form.email.trim() || null,
      residential: form.residential,
      defaultShipMethod: form.defaultShipMethod,
    };
    save.mutate({ data: payload });
  };

  return (
        <div className="p-4 lg:p-6">
          {!canPurchasing ? null : isLoading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 size={22} className="animate-spin text-slate-500" />
            </div>
          ) : (
            <form
              onSubmit={onSave}
              className="max-w-2xl bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden"
            >
              <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-2.5">
                <Truck size={16} className="text-sky-400" />
                <div>
                  <div className="text-sm font-semibold text-slate-100">
                    Ship-to address
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Where SanMar and S&amp;S ship your electronic orders.
                  </div>
                </div>
              </div>

              <div className="p-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className={`${labelCls} sm:col-span-2`}>
                  Company name
                  <input
                    className={inputCls}
                    value={form.companyName}
                    onChange={(e) => set("companyName", e.target.value)}
                    placeholder="Mint Printworks"
                  />
                </label>
                <label className={labelCls}>
                  Attention (optional)
                  <input
                    className={inputCls}
                    value={form.attention}
                    onChange={(e) => set("attention", e.target.value)}
                    placeholder="Receiving"
                  />
                </label>
                <label className={labelCls}>
                  Email (optional)
                  <input
                    className={inputCls}
                    type="email"
                    value={form.email}
                    onChange={(e) => set("email", e.target.value)}
                    placeholder="orders@mintprint.com"
                  />
                </label>
                <label className={`${labelCls} sm:col-span-2`}>
                  Address line 1
                  <input
                    className={inputCls}
                    value={form.address1}
                    onChange={(e) => set("address1", e.target.value)}
                    placeholder="123 Main St"
                  />
                </label>
                <label className={`${labelCls} sm:col-span-2`}>
                  Address line 2 (optional)
                  <input
                    className={inputCls}
                    value={form.address2}
                    onChange={(e) => set("address2", e.target.value)}
                    placeholder="Suite 100"
                  />
                </label>
                <label className={labelCls}>
                  City
                  <input
                    className={inputCls}
                    value={form.city}
                    onChange={(e) => set("city", e.target.value)}
                  />
                </label>
                <div className="grid grid-cols-2 gap-4">
                  <label className={labelCls}>
                    State
                    <input
                      className={inputCls}
                      value={form.state}
                      onChange={(e) => set("state", e.target.value.toUpperCase())}
                      maxLength={2}
                      placeholder="CA"
                    />
                  </label>
                  <label className={labelCls}>
                    ZIP
                    <input
                      className={inputCls}
                      value={form.zip}
                      onChange={(e) => set("zip", e.target.value)}
                      placeholder="90001"
                    />
                  </label>
                </div>
                <label className={labelCls}>
                  Default ship method
                  <select
                    className={inputCls}
                    value={form.defaultShipMethod}
                    onChange={(e) =>
                      set(
                        "defaultShipMethod",
                        e.target.value as ShipToForm["defaultShipMethod"],
                      )
                    }
                  >
                    {(
                      Object.keys(
                        VendorShipToDefaultShipMethod,
                      ) as (keyof typeof VendorShipToDefaultShipMethod)[]
                    ).map((m) => (
                      <option key={m} value={m}>
                        {SHIP_METHOD_LABELS[m] ?? m}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2.5 text-xs text-slate-300 font-medium sm:col-span-2 mt-1">
                  <input
                    type="checkbox"
                    checked={form.residential}
                    onChange={(e) => set("residential", e.target.checked)}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-800 accent-[#059669]"
                  />
                  This is a residential address
                </label>
              </div>

              <div className="px-5 py-4 border-t border-slate-800 flex items-center justify-between">
                <span className="text-[11px] text-slate-500">
                  {requiredMissing
                    ? "Company, address, city, state and ZIP are required."
                    : "Ready to save."}
                </span>
                <button
                  type="submit"
                  disabled={requiredMissing || save.isPending}
                  className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {save.isPending ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Save size={13} />
                  )}
                  Save address
                </button>
              </div>
            </form>
          )}
        </div>
  );
}

const GROUPS: { id: SettingsGroup; label: string }[] = [
  { id: "access", label: "Access" },
  { id: "connections", label: "Connections / Integrations" },
  { id: "rules", label: "Rules / Automations" },
];

export default function Settings() {
  const me = useStaff();
  // Subscribe to search changes: switching subsections does not change the pathname.
  const search = useSearch();
  const requested = resolveSettingsSection(search);
  const available = settingsSections.filter((section) =>
    canOpenSettingsSection(section, me.role, me.enabledModules)
  );
  const requestedGroup = new URLSearchParams(search).get("group");
  const active = available.find((section) => section.id === requested?.id) ??
    available.find((section) => section.group === requestedGroup) ?? available[0];
  const group = active?.group ?? "access";
  const sectionHref = (id: string) => settingsHref(id, search);
  const accessDenied = requested && !available.some((section) => section.id === requested.id);

  const content = () => {
    switch (active?.id) {
      case "staff-access": return <StaffAccessCard />;
      case "module-access": return <ModuleAccessCard />;
      case "admin-pin": return <AdminPinCard />;
      case "ai-connections": return <AiContext />;
      case "knowledge-base": return <KnowledgeBase />;
      case "email-access": return <EmailAccess />;
      case "voice-profiles": return <VoiceProfiles />;
      case "email-tracker": return <EmailActivitySettings />;
      case "print-queue-rules": return <PrintQueueRules />;
      case "auto-print": return <AutoPrint />;
      case "purchasing-status-rules": return <StatusRules />;
      case "shipping-address": return <GeneralShipping />;
      default: return <p className="p-6 text-slate-400">No settings are available for your account.</p>;
    }
  };

  return (
    <AppShell>
      <div className="min-h-full">
        <header className="border-b border-slate-800 px-4 lg:px-6 py-4 flex items-center gap-2.5">
          <SettingsIcon size={18} className="text-emerald-400" />
          <h1 className="text-lg font-semibold text-white">Settings</h1>
        </header>
        <nav aria-label="Settings groups" className="flex flex-wrap gap-2 border-b border-slate-800 px-4 lg:px-6 py-3">
          {GROUPS.filter(({ id }) => available.some((section) => section.group === id)).map(({ id, label }) => {
            const first = available.find((section) => section.group === id)!;
            return <Link key={id} href={sectionHref(first.id)} aria-current={group === id ? "page" : undefined}
              className={`rounded-lg px-3 py-2 text-xs font-semibold ${group === id ? "bg-emerald-600/20 text-emerald-300" : "bg-slate-900 text-slate-400 hover:text-white"}`}>{label}</Link>;
          })}
        </nav>
        <div className="flex flex-col md:flex-row">
          <nav aria-label="Settings sections" className="flex md:flex-col flex-wrap md:flex-nowrap gap-1 border-b md:border-b-0 md:border-r border-slate-800 p-3 md:w-52 md:shrink-0">
            {available.filter((section) => section.group === group).map((section) =>
              <Link key={section.id} href={sectionHref(section.id)} aria-current={active?.id === section.id ? "page" : undefined}
                className={`rounded-md px-3 py-2 text-xs font-medium ${active?.id === section.id ? "bg-emerald-600/15 text-emerald-300" : "text-slate-400 hover:bg-slate-800 hover:text-white"}`}>{section.label}</Link>
            )}
          </nav>
          <div className="flex-1 min-w-0">
            {accessDenied
              ? <div role="alert" className="p-6 text-sm text-amber-300">You don't have access to this settings section.</div>
              : <SettingsEmbed value={true}>{content()}</SettingsEmbed>}
          </div>
        </div>
        {available.some((section) => section.id === "shipping-address") && (
          <div className="border-t border-slate-800 px-4 lg:px-6 py-3 text-xs text-slate-500">
            General · <Link href={sectionHref("shipping-address")} className="text-slate-300 hover:text-emerald-300">Shipping address</Link>
          </div>
        )}
      </div>
    </AppShell>
  );
}
