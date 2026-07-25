import { useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import {
  useListChipplyStores,
  getListChipplyStoresQueryKey,
  useListDetectedChipplyStores,
  getListDetectedChipplyStoresQueryKey,
  useParseChipplyEmail,
  useCreateChipplyStore,
  type ChipplyParsedEmail,
  type ChipplyStoreCandidate,
  type ChipplyStore,
  type CreateChipplyStoreRequest,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Store,
  Loader2,
  ClipboardPaste,
  AlertTriangle,
  Link2,
  Radar,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";

const inputCls =
  "w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669] placeholder:text-slate-500";
const labelCls = "text-[11px] font-semibold text-slate-300 mb-1 block";

export function fmtMoney(v: string | number | null): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** closedAt is a plain YYYY-MM-DD — format without Date() timezone math. */
export function fmtDate(v: string | null): string {
  if (!v) return "—";
  const [y, m, d] = v.split("-");
  if (!y || !m || !d) return v;
  return `${Number(m)}/${Number(d)}/${y}`;
}

function extractError(err: unknown): string {
  return (
    (err as { data?: { error?: string } })?.data?.error ??
    "Something went wrong."
  );
}

/** Loose client-side twin of the server's normalizeName. */
export function normalizeStoreName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Parse a numeric form field. Empty → null; unreadable → throws so the
 * user sees an error instead of the value being silently cleared.
 */
export function parseNumField(s: string, label: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`"${s}" isn't a valid number for ${label}`);
  }
  return n;
}

// ── Import dialog ─────────────────────────────────────────────────────

interface DraftFields {
  storeName: string;
  eventId: string;
  orgContact: string;
  storeAdmin: string;
  closedAt: string;
  numOrders: string;
  numProducts: string;
  totalDollars: string;
  fundraising: string;
  pvCustomerId: string | null;
}

function draftFromParse(p: ChipplyParsedEmail): DraftFields {
  return {
    storeName: p.storeName ?? "",
    eventId: "",
    orgContact: p.orgContact ?? "",
    storeAdmin: p.storeAdmin ?? "",
    closedAt: p.closedAt ?? "",
    numOrders: p.numOrders !== null ? String(p.numOrders) : "",
    numProducts: p.numProducts !== null ? String(p.numProducts) : "",
    totalDollars: p.totalDollars !== null ? String(p.totalDollars) : "",
    fundraising: p.fundraising !== null ? String(p.fundraising) : "",
    pvCustomerId: null,
  };
}

export function ImportEmailDialog({
  open,
  onOpenChange,
  prefill,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** When importing straight from a Detected row, skip the paste step. */
  prefill?: ChipplyStoreCandidate | null;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // The parent remounts this dialog (via key) whenever prefill changes, so
  // initializing from prefill here is safe.
  const [step, setStep] = useState<"paste" | "review">(
    prefill ? "review" : "paste",
  );
  const [emailText, setEmailText] = useState("");
  const [draft, setDraft] = useState<DraftFields | null>(
    prefill
      ? {
          storeName: prefill.nameGuess,
          eventId: prefill.eventId,
          orgContact: "",
          storeAdmin: "",
          closedAt: "",
          numOrders: "",
          numProducts: "",
          totalDollars: "",
          fundraising: "",
          pvCustomerId: prefill.customerId,
        }
      : null,
  );
  const [candidates, setCandidates] = useState<ChipplyStoreCandidate[]>(
    prefill ? [prefill] : [],
  );
  const [existingStore, setExistingStore] = useState<ChipplyStore | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(
    prefill?.eventId ?? null,
  );

  const parseMutation = useParseChipplyEmail({
    mutation: {
      onSuccess: (data) => {
        setDraft(draftFromParse(data.parsed));
        setCandidates(data.candidates);
        setExistingStore(data.existingStore);
        // Auto-select only a single candidate whose name matches exactly —
        // a lone loose prefix variant (e.g. a prior season) needs a
        // deliberate click from staff.
        const only = data.candidates.length === 1 ? data.candidates[0] : null;
        if (
          only &&
          data.parsed.storeName &&
          normalizeStoreName(only.nameGuess) ===
            normalizeStoreName(data.parsed.storeName)
        ) {
          applyCandidate(only, draftFromParse(data.parsed));
        } else {
          setSelectedEventId(null);
        }
        setStep("review");
      },
      onError: (err) =>
        toast({
          title: "Couldn't read that email",
          description: extractError(err),
          variant: "destructive",
        }),
    },
  });

  const createMutation = useCreateChipplyStore({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({
          queryKey: getListChipplyStoresQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getListDetectedChipplyStoresQueryKey(),
        });
        toast({
          title: "Store imported",
          description: `${data.store.storeName} saved${data.store.eventId ? ` and linked to event ${data.store.eventId}` : ""}.`,
        });
        handleOpenChange(false);
      },
      onError: (err) =>
        toast({
          title: "Import failed",
          description: extractError(err),
          variant: "destructive",
        }),
    },
  });

  function applyCandidate(c: ChipplyStoreCandidate, base?: DraftFields) {
    setSelectedEventId(c.eventId);
    setDraft((prev) => {
      const d = base ?? prev;
      if (!d) return d;
      return { ...d, eventId: c.eventId, pvCustomerId: c.customerId };
    });
  }

  function clearCandidate() {
    setSelectedEventId(null);
    setDraft((d) => (d ? { ...d, eventId: "", pvCustomerId: null } : d));
  }

  function handleOpenChange(o: boolean) {
    onOpenChange(o);
    if (!o && !prefill) {
      // Paste-flow instance persists across opens (stable key) — reset it.
      setStep("paste");
      setEmailText("");
      setDraft(null);
      setCandidates([]);
      setExistingStore(null);
      setSelectedEventId(null);
    }
  }

  function setField(key: keyof DraftFields, value: string) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  function handleCreate() {
    if (!draft) return;
    const name = draft.storeName.trim();
    if (!name) {
      toast({ title: "Store name is required", variant: "destructive" });
      return;
    }
    let nums: {
      numOrders: number | null;
      numProducts: number | null;
      totalDollars: number | null;
      fundraising: number | null;
    };
    try {
      nums = {
        numOrders: parseNumField(draft.numOrders, "# Orders"),
        numProducts: parseNumField(draft.numProducts, "# Products"),
        totalDollars: parseNumField(draft.totalDollars, "Total dollars"),
        fundraising: parseNumField(draft.fundraising, "Fundraising"),
      };
    } catch (err) {
      toast({
        title: "Check the numbers",
        description: err instanceof Error ? err.message : "Invalid number",
        variant: "destructive",
      });
      return;
    }
    const body: CreateChipplyStoreRequest = {
      storeName: name,
      eventId: draft.eventId.trim() || null,
      orgContact: draft.orgContact.trim() || null,
      storeAdmin: draft.storeAdmin.trim() || null,
      closedAt: draft.closedAt.trim() || null,
      ...nums,
      pvCustomerId: draft.pvCustomerId,
      rawSource: emailText.trim() || null,
    };
    createMutation.mutate({ data: body });
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-800 text-slate-200 sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-white flex items-center gap-2">
            <ClipboardPaste size={18} className="text-[#059669]" />
            Import Chipply store
          </DialogTitle>
          <DialogDescription className="text-slate-400">
            {step === "paste"
              ? 'Paste the full "Web Store Closed" email — everything gets read automatically, and you review before saving.'
              : "Check the details below, pick the matching Printavo invoices, then save."}
          </DialogDescription>
        </DialogHeader>

        {step === "paste" && (
          <div className="space-y-3">
            <Textarea
              value={emailText}
              onChange={(e) => setEmailText(e.target.value)}
              placeholder={'Paste the whole email here, e.g.\n\nFuel Summer - Web Store Closed\nOrganization Contact: ...\nNumber of Orders: ...\nTotal Dollars: ...'}
              className="min-h-[220px] bg-slate-800 border-slate-700 text-slate-200 placeholder:text-slate-500 font-mono text-xs"
            />
            <DialogFooter>
              <Button
                onClick={() => parseMutation.mutate({ data: { emailText } })}
                disabled={emailText.trim().length < 10 || parseMutation.isPending}
                className="bg-[#059669] hover:bg-[#047857] text-white"
              >
                {parseMutation.isPending ? (
                  <Loader2 size={16} className="animate-spin mr-1.5" />
                ) : (
                  <ArrowRight size={16} className="mr-1.5" />
                )}
                Read email
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === "review" && draft && (
          <div className="space-y-4">
            {existingStore && (
              <div className="flex items-start gap-2 bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2.5 text-sm text-amber-200">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>
                  This store looks like it was already imported as{" "}
                  <Link
                    href={`/chipply/${existingStore.id}`}
                    className="underline font-semibold"
                    onClick={() => handleOpenChange(false)}
                  >
                    {existingStore.storeName}
                  </Link>
                  {existingStore.eventId ? ` (event ${existingStore.eventId})` : ""}. Saving again
                  will create a duplicate.
                </span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className={labelCls}>Store name</label>
                <input
                  className={inputCls}
                  value={draft.storeName}
                  onChange={(e) => setField("storeName", e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls}>Organization contact</label>
                <input
                  className={inputCls}
                  value={draft.orgContact}
                  onChange={(e) => setField("orgContact", e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls}>Store admin</label>
                <input
                  className={inputCls}
                  value={draft.storeAdmin}
                  onChange={(e) => setField("storeAdmin", e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls}>Closed date (YYYY-MM-DD)</label>
                <input
                  className={inputCls}
                  value={draft.closedAt}
                  onChange={(e) => setField("closedAt", e.target.value)}
                  placeholder="2026-07-06"
                />
              </div>
              <div>
                <label className={labelCls}># Orders</label>
                <input
                  className={inputCls}
                  value={draft.numOrders}
                  onChange={(e) => setField("numOrders", e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls}># Products</label>
                <input
                  className={inputCls}
                  value={draft.numProducts}
                  onChange={(e) => setField("numProducts", e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls}>Total dollars</label>
                <input
                  className={inputCls}
                  value={draft.totalDollars}
                  onChange={(e) => setField("totalDollars", e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls}>Fundraising</label>
                <input
                  className={inputCls}
                  value={draft.fundraising}
                  onChange={(e) => setField("fundraising", e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className={labelCls}>
                <span className="flex items-center gap-1.5">
                  <Link2 size={12} />
                  Matching Printavo invoices
                </span>
              </label>
              {candidates.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No matching invoice batches found yet — you can link an event number later from
                  the store page once invoices are created in Printavo.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {candidates.map((c) => {
                    const selected = selectedEventId === c.eventId;
                    return (
                      <button
                        key={c.eventId}
                        type="button"
                        onClick={() => (selected ? clearCandidate() : applyCandidate(c))}
                        className={`w-full text-left rounded-lg border px-3 py-2 text-sm transition-colors ${
                          selected
                            ? "border-[#059669] bg-emerald-950/40"
                            : "border-slate-700 bg-slate-800 hover:border-slate-500"
                        }`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-slate-100">
                            {c.nameGuess}{" "}
                            <span className="text-slate-400 font-normal">
                              — event {c.eventId}
                            </span>
                          </span>
                          {selected && (
                            <CheckCircle2 size={16} className="text-[#059669] shrink-0" />
                          )}
                        </span>
                        <span className="text-xs text-slate-400">
                          {c.invoiceCount} invoice{c.invoiceCount === 1 ? "" : "s"}
                          {c.customerCompany ? ` · ${c.customerCompany}` : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <DialogFooter className="gap-2">
              {!prefill && (
                <Button
                  variant="outline"
                  onClick={() => setStep("paste")}
                  className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
                >
                  Back
                </Button>
              )}
              <Button
                onClick={handleCreate}
                disabled={createMutation.isPending || !draft.storeName.trim()}
                className="bg-[#059669] hover:bg-[#047857] text-white"
              >
                {createMutation.isPending && (
                  <Loader2 size={16} className="animate-spin mr-1.5" />
                )}
                Save store
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Page ──────────────────────────────────────────────────────────────

export default function ChipplyStores() {
  const [tab, setTab] = useState<"stores" | "detected">("stores");
  const [importOpen, setImportOpen] = useState(false);
  const [prefill, setPrefill] = useState<ChipplyStoreCandidate | null>(null);

  const storesQuery = useListChipplyStores();
  const detectedQuery = useListDetectedChipplyStores({
    query: {
      enabled: tab === "detected",
      queryKey: getListDetectedChipplyStoresQueryKey(),
    },
  });

  const stores = storesQuery.data?.stores ?? [];
  const detected = detectedQuery.data?.detected ?? [];

  function openImport(pre?: ChipplyStoreCandidate) {
    setPrefill(pre ?? null);
    setImportOpen(true);
  }

  return (
    <AppShell>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <Store size={20} className="text-[#059669]" />
              Chipply Stores
            </h1>
            <p className="text-sm text-slate-400 mt-0.5">
              Web store totals imported from Chipply closing emails — kept separate from Printavo
              invoice revenue.
            </p>
          </div>
          <Button
            onClick={() => openImport()}
            className="bg-[#059669] hover:bg-[#047857] text-white"
          >
            <ClipboardPaste size={16} className="mr-1.5" />
            Import from email
          </Button>
        </div>

        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => setTab("stores")}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
              tab === "stores"
                ? "bg-[#059669] text-white"
                : "bg-slate-800 text-slate-300 hover:text-white"
            }`}
          >
            Imported ({stores.length})
          </button>
          <button
            type="button"
            onClick={() => setTab("detected")}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors flex items-center gap-1.5 ${
              tab === "detected"
                ? "bg-[#059669] text-white"
                : "bg-slate-800 text-slate-300 hover:text-white"
            }`}
          >
            <Radar size={14} />
            Detected in Printavo
          </button>
        </div>

        {tab === "stores" && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            {storesQuery.isLoading ? (
              <div className="flex items-center justify-center py-16 text-slate-400">
                <Loader2 size={20} className="animate-spin mr-2" /> Loading stores…
              </div>
            ) : stores.length === 0 ? (
              <div className="text-center py-16 px-4">
                <Store size={32} className="mx-auto text-slate-600 mb-3" />
                <p className="text-slate-300 font-semibold">No stores imported yet</p>
                <p className="text-sm text-slate-500 mt-1">
                  Paste a "Web Store Closed" email to bring in your first store, or check the
                  Detected tab for stores found in Printavo invoice names.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-xs text-slate-400">
                      <th className="px-4 py-2.5 font-semibold">Store</th>
                      <th className="px-4 py-2.5 font-semibold">Closed</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Orders</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Total</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Fundraising</th>
                      <th className="px-4 py-2.5 font-semibold">Customer</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Invoices</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stores.map(({ store, linkedInvoiceCount }) => (
                      <tr
                        key={store.id}
                        className="border-b border-slate-800/60 last:border-0 hover:bg-slate-800/40"
                      >
                        <td className="px-4 py-2.5">
                          <Link
                            href={`/chipply/${store.id}`}
                            className="font-semibold text-slate-100 hover:text-[#34d399]"
                          >
                            {store.storeName}
                          </Link>
                          {store.eventId && (
                            <span className="text-xs text-slate-500 ml-2">
                              #{store.eventId}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-slate-300 whitespace-nowrap">
                          {fmtDate(store.closedAt)}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-300">
                          {store.numOrders ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-100 font-semibold whitespace-nowrap">
                          {fmtMoney(store.totalDollars)}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-300 whitespace-nowrap">
                          {fmtMoney(store.fundraising)}
                        </td>
                        <td className="px-4 py-2.5 text-slate-300">
                          {store.pvCustomerCompany ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <span
                            className={`inline-flex items-center gap-1 text-xs font-semibold ${
                              linkedInvoiceCount > 0 ? "text-[#34d399]" : "text-slate-500"
                            }`}
                          >
                            <Link2 size={12} />
                            {linkedInvoiceCount}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {tab === "detected" && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800">
              <p className="text-xs text-slate-400">
                Invoice batches in Printavo whose names start with a Chipply event number but
                don't have an imported store yet. Import one to start tracking its totals.
              </p>
            </div>
            {detectedQuery.isLoading ? (
              <div className="flex items-center justify-center py-16 text-slate-400">
                <Loader2 size={20} className="animate-spin mr-2" /> Scanning invoices…
              </div>
            ) : detected.length === 0 ? (
              <p className="text-center py-12 text-sm text-slate-500">
                Every detected store has been imported. Nice and tidy.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-xs text-slate-400">
                      <th className="px-4 py-2.5 font-semibold">Store name (from invoices)</th>
                      <th className="px-4 py-2.5 font-semibold">Event #</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Invoices</th>
                      <th className="px-4 py-2.5 font-semibold">Customer</th>
                      <th className="px-4 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {detected.map((d) => (
                      <tr
                        key={d.eventId}
                        className="border-b border-slate-800/60 last:border-0 hover:bg-slate-800/40"
                      >
                        <td className="px-4 py-2.5 font-semibold text-slate-100">
                          {d.nameGuess || "(unnamed)"}
                        </td>
                        <td className="px-4 py-2.5 text-slate-400">{d.eventId}</td>
                        <td className="px-4 py-2.5 text-right text-slate-300">
                          {d.invoiceCount}
                        </td>
                        <td className="px-4 py-2.5 text-slate-300">
                          {d.customerCompany ?? "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openImport(d)}
                            className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white h-7 text-xs"
                          >
                            Import
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <ImportEmailDialog
        key={prefill?.eventId ?? "paste"}
        open={importOpen}
        onOpenChange={(o) => {
          setImportOpen(o);
          if (!o) setPrefill(null);
        }}
        prefill={prefill}
      />
    </AppShell>
  );
}
