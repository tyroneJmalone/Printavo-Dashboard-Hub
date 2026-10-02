import { useMemo, useRef, useState } from "react";
import {
  EMPTY_STORE_FILTERS,
  filterStores,
  isDateFilterActive,
  isFilterActive,
  matchesText,
  type StoreFilters,
} from "@/lib/chipply-store-filters";
import { Link } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { InvoiceCategories } from "@/components/chipply/InvoiceCategories";
import { DetailedDataImport } from "@/components/chipply/DetailedData";
import {
  useListChipplyStores,
  getListChipplyStoresQueryKey,
  useListDetectedChipplyStores,
  getListDetectedChipplyStoresQueryKey,
  useParseChipplyEmail,
  useParseChipplyFile,
  useCreateChipplyStore,
  useUpdateChipplyStore,
  getGetChipplyStoreQueryKey,
  type ChipplyParsedEmail,
  type ChipplyParsedSalesReport,
  type ChipplyStoreCandidate,
  type ChipplyStore,
  type ChipplyStoreFinancialsInput,
  type CreateChipplyStoreRequest,
  type UpdateChipplyStoreRequest,
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
  Upload,
  FileSpreadsheet,
  RefreshCcw,
  Search,
  X,
  SearchX,
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

/** Total dollars prefills from the sell-price guess (combined + upcharges +
 * fundraising) — editable, since the CSV has no literal "Total Dollars". */
function draftFromSalesReport(sr: ChipplyParsedSalesReport): DraftFields {
  return {
    storeName: sr.storeName ?? "",
    eventId: sr.eventId ?? "",
    orgContact: "",
    storeAdmin: "",
    closedAt: sr.closedAt ?? "",
    numOrders: "",
    numProducts: "",
    totalDollars:
      sr.totalDollarsGuess !== null ? sr.totalDollarsGuess.toFixed(2) : "",
    fundraising: sr.fundraising !== null ? sr.fundraising.toFixed(2) : "",
    pvCustomerId: null,
  };
}

function financialsFromSalesReport(
  sr: ChipplyParsedSalesReport,
): ChipplyStoreFinancialsInput {
  return {
    salesperson: sr.salesperson,
    organizationName: sr.organizationName,
    openedAt: sr.openedAt,
    orgFee: sr.orgFee,
    productCost: sr.productCost,
    productPrice: sr.productPrice,
    processPrice: sr.processPrice,
    combinedPrice: sr.combinedPrice,
    optionFees: sr.optionFees,
    sizeUpcharges: sr.sizeUpcharges,
    tax: sr.tax,
    shipping: sr.shipping,
    handlingFee: sr.handlingFee,
    manualAdjustment: sr.manualAdjustment,
    orderTotal: sr.orderTotal,
    paymentCard: sr.paymentCard,
    paymentKlarna: sr.paymentKlarna,
    paymentEcert: sr.paymentEcert,
    paymentPo: sr.paymentPo,
    paymentPromo: sr.paymentPromo,
    chipplyFee: sr.chipplyFee,
    ccProcessingFee: sr.ccProcessingFee,
  };
}

/** Read an uploaded CSV client-side; enforce the API's size cap up front. */
export async function readCsvFile(file: File): Promise<string> {
  const text = await file.text();
  if (text.trim().length < 10) {
    throw new Error("That file looks empty.");
  }
  if (text.length > 200_000) {
    throw new Error("That file is too large to be a Chipply export.");
  }
  return text;
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
  // File-upload (SalesReport CSV) flow: keeps the full financials block to
  // send along on save, plus banners the paste flow never needs.
  const [source, setSource] = useState<"email" | "file">("email");
  const [financials, setFinancials] =
    useState<ChipplyStoreFinancialsInput | null>(null);
  const [marginNotice, setMarginNotice] = useState(false);
  const [multiRowWarning, setMultiRowWarning] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const parseMutation = useParseChipplyEmail({
    mutation: {
      onSuccess: (data) => {
        setSource("email");
        setFinancials(null);
        setMarginNotice(false);
        setMultiRowWarning(false);
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

  const parseFileMutation = useParseChipplyFile({
    mutation: {
      onSuccess: (data) => {
        if (data.kind === "margin_report") {
          // Margin Reports carry no store identifier — they attach to a
          // specific store from that store's detail page.
          setMarginNotice(true);
          return;
        }
        const sr = data.salesReport;
        if (!sr) {
          toast({
            title: "Couldn't read that file",
            description: "No store row found in the SalesReport.",
            variant: "destructive",
          });
          return;
        }
        setSource("file");
        setMarginNotice(false);
        setFinancials(financialsFromSalesReport(sr));
        setMultiRowWarning(data.namedRowCount > 1);
        setCandidates(data.candidates);
        setExistingStore(data.existingStore);
        const base = draftFromSalesReport(sr);
        // The CSV names its own event id — auto-link the matching invoice
        // batch when one exists.
        const match = sr.eventId
          ? data.candidates.find((c) => c.eventId === sr.eventId)
          : null;
        if (match) {
          setSelectedEventId(match.eventId);
          setDraft({
            ...base,
            eventId: match.eventId,
            pvCustomerId: match.customerId,
          });
        } else {
          setSelectedEventId(null);
          setDraft(base);
        }
        setStep("review");
      },
      onError: (err) =>
        toast({
          title: "Couldn't read that file",
          description: extractError(err),
          variant: "destructive",
        }),
    },
  });

  async function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const fileText = await readCsvFile(file);
      parseFileMutation.mutate({ data: { fileText } });
    } catch (err) {
      toast({
        title: "Couldn't read that file",
        description: err instanceof Error ? err.message : "Unreadable file",
        variant: "destructive",
      });
    }
  }

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

  const updateMutation = useUpdateChipplyStore({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({
          queryKey: getListChipplyStoresQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getListDetectedChipplyStoresQueryKey(),
        });
        queryClient.invalidateQueries({
          queryKey: getGetChipplyStoreQueryKey(data.store.id),
        });
        toast({
          title: "Store updated",
          description: `${data.store.storeName} refreshed from the SalesReport.`,
        });
        handleOpenChange(false);
      },
      onError: (err) =>
        toast({
          title: "Update failed",
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
      setSource("email");
      setFinancials(null);
      setMarginNotice(false);
      setMultiRowWarning(false);
    }
  }

  function setField(key: keyof DraftFields, value: string) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  const saving = createMutation.isPending || updateMutation.isPending;

  function handleSave() {
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

    if (existingStore) {
      // Update mode — refresh the existing store instead of creating a
      // duplicate. Blank fields are OMITTED so values that only live in the
      // closing email (org contact, store admin, # orders…) are retained.
      const body: UpdateChipplyStoreRequest = { storeName: name };
      if (draft.eventId.trim()) body.eventId = draft.eventId.trim();
      if (draft.orgContact.trim()) body.orgContact = draft.orgContact.trim();
      if (draft.storeAdmin.trim()) body.storeAdmin = draft.storeAdmin.trim();
      if (draft.closedAt.trim()) body.closedAt = draft.closedAt.trim();
      if (nums.numOrders !== null) body.numOrders = nums.numOrders;
      if (nums.numProducts !== null) body.numProducts = nums.numProducts;
      if (nums.totalDollars !== null) body.totalDollars = nums.totalDollars;
      if (nums.fundraising !== null) body.fundraising = nums.fundraising;
      if (financials) body.financials = financials;
      if (draft.pvCustomerId) body.pvCustomerId = draft.pvCustomerId;
      updateMutation.mutate({ id: existingStore.id, data: body });
      return;
    }

    const body: CreateChipplyStoreRequest = {
      storeName: name,
      eventId: draft.eventId.trim() || null,
      orgContact: draft.orgContact.trim() || null,
      storeAdmin: draft.storeAdmin.trim() || null,
      closedAt: draft.closedAt.trim() || null,
      ...nums,
      financials,
      pvCustomerId: draft.pvCustomerId,
      rawSource: source === "email" ? emailText.trim() || null : null,
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
              ? 'Paste the full "Web Store Closed" email or upload a SalesReport CSV from the Chipply portal — everything gets read automatically, and you review before saving.'
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
            {marginNotice && (
              <div className="flex items-start gap-2 bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2.5 text-sm text-amber-200">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>
                  That file is a <strong>Margin Report</strong> (per-style
                  costs). It doesn't say which store it belongs to, so upload
                  it from that store's own page instead — open the store and
                  use "Upload margin report".
                </span>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFilePicked}
              className="hidden"
            />
            <DialogFooter className="gap-2">
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={parseFileMutation.isPending}
                className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                {parseFileMutation.isPending ? (
                  <Loader2 size={16} className="animate-spin mr-1.5" />
                ) : (
                  <Upload size={16} className="mr-1.5" />
                )}
                Upload SalesReport CSV
              </Button>
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
              <div className="flex items-start gap-2 bg-emerald-950/40 border border-emerald-800/50 rounded-lg px-3 py-2.5 text-sm text-emerald-200">
                <RefreshCcw size={16} className="mt-0.5 shrink-0" />
                <span>
                  This store is already imported as{" "}
                  <Link
                    href={`/chipply/${existingStore.id}`}
                    className="underline font-semibold"
                    onClick={() => handleOpenChange(false)}
                  >
                    {existingStore.storeName}
                  </Link>
                  {existingStore.eventId ? ` (event ${existingStore.eventId})` : ""}. Saving will{" "}
                  <strong>update it</strong> — no duplicate is created, and
                  fields left blank here keep their current values.
                </span>
              </div>
            )}
            {multiRowWarning && (
              <div className="flex items-start gap-2 bg-amber-950/40 border border-amber-800/50 rounded-lg px-3 py-2.5 text-sm text-amber-200">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>
                  This file listed more than one store — only the first one is
                  shown here. Export one store per SalesReport to import the
                  others.
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

            {financials && (
              <div className="rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2.5">
                <p className="text-[11px] font-semibold text-slate-300 flex items-center gap-1.5 mb-1.5">
                  <FileSpreadsheet size={12} className="text-[#059669]" />
                  SalesReport financials (saved with the store)
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-xs">
                  {(
                    [
                      ["Order total", financials.orderTotal],
                      ["Product cost", financials.productCost],
                      ["Product price", financials.productPrice],
                      ["Chipply fee", financials.chipplyFee],
                      ["CC processing", financials.ccProcessingFee],
                      ["Shipping", financials.shipping],
                      ["Handling", financials.handlingFee],
                      ["Tax", financials.tax],
                      ["Org fee", financials.orgFee],
                    ] as const
                  )
                    .filter(([, v]) => v !== null && v !== undefined)
                    .map(([label, v]) => (
                      <div key={label} className="flex justify-between gap-2">
                        <span className="text-slate-400">{label}</span>
                        <span className="text-slate-200 font-mono">
                          {fmtMoney(v as number)}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}

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
                onClick={handleSave}
                disabled={saving || !draft.storeName.trim()}
                className="bg-[#059669] hover:bg-[#047857] text-white"
              >
                {saving && <Loader2 size={16} className="animate-spin mr-1.5" />}
                {existingStore ? "Update store" : "Save store"}
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
  const [tab, setTab] = useState<"stores" | "detected" | "categories">(() => new URLSearchParams(window.location.search).get("tab") === "categories" ? "categories" : "stores");
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
  const [filters, setFilters] = useState<StoreFilters>(EMPTY_STORE_FILTERS);
  const filterOn = isFilterActive(filters);
  const filteredStores = useMemo(
    () =>
      filterStores(storesQuery.data?.stores ?? [], filters, (r) => ({
        storeName: r.store.storeName,
        eventId: r.store.eventId,
        closedAt: r.store.closedAt,
        pvCustomerCompany: r.store.pvCustomerCompany,
        organizationName: r.store.organizationName,
      })),
    [storesQuery.data, filters],
  );
  // Detected rows have no closed date — only the text search applies there.
  const filteredDetected = useMemo(
    () =>
      (detectedQuery.data?.detected ?? []).filter((d) =>
        matchesText(filters.query, [d.nameGuess, d.customerCompany, d.eventId]),
      ),
    [detectedQuery.data, filters.query],
  );
  function setFilter(k: keyof StoreFilters, v: string) {
    setFilters((f) => ({ ...f, [k]: v }));
  }

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
              Web store totals imported from Chipply closing emails or SalesReport CSVs — kept
              separate from Printavo invoice revenue.
            </p>
          </div>
          <Button
            onClick={() => openImport()}
            className="bg-[#059669] hover:bg-[#047857] text-white"
          >
            <ClipboardPaste size={16} className="mr-1.5" />
            Import store
          </Button>
        </div>

        <DetailedDataImport />

        {stores.length > 0 && (
          <div className="space-y-1.5">
          <p className="text-[11px] text-slate-500" data-testid="text-summary-scope">
            {filterOn
              ? `Imported stores — filtered (${filteredStores.length} of ${stores.length})`
              : "Imported stores — all"}
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {(
              [
                [filterOn ? "Stores (filtered)" : "Stores", String(filteredStores.length)],
                [
                  filterOn ? "Total dollars (filtered)" : "Total dollars",
                  fmtMoney(
                    filteredStores.reduce(
                      (sum, s) => sum + (Number(s.store.totalDollars) || 0),
                      0,
                    ),
                  ),
                ],
                [
                  filterOn ? "Fundraising (filtered)" : "Fundraising",
                  fmtMoney(
                    filteredStores.reduce(
                      (sum, s) => sum + (Number(s.store.fundraising) || 0),
                      0,
                    ),
                  ),
                ],
                [
                  filterOn ? "Linked invoices (filtered)" : "Linked invoices",
                  String(
                    filteredStores.reduce((sum, s) => sum + s.linkedInvoiceCount, 0),
                  ),
                ],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3"
              >
                <p className="text-[11px] uppercase tracking-wide text-slate-500 font-semibold">
                  {label}
                </p>
                <p className="text-lg font-bold text-white mt-0.5">{value}</p>
              </div>
            ))}
          </div>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
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
          <button
            type="button"
            data-testid="button-tab-invoice-categories"
            onClick={() => setTab("categories")}
            className={`px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${tab === "categories" ? "bg-[#059669] text-white" : "bg-slate-800 text-slate-300 hover:text-white"}`}
          >
            Invoice categories
          </button>
        </div>

        {(tab === "stores" || tab === "detected") && stores.length + detected.length > 0 && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 space-y-2" data-testid="panel-store-filters">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-3 items-end">
              <div>
                <label className={labelCls} htmlFor="store-search">Customer or store name</label>
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
                  <input id="store-search" data-testid="input-store-search" className={`${inputCls} pl-8`} value={filters.query} onChange={(e) => setFilter("query", e.target.value)} placeholder="Store, customer, organization, or event #" />
                </div>
              </div>
              {tab === "stores" && (
                <>
                  <div>
                    <label className={labelCls} htmlFor="closed-from">Closed date from</label>
                    <input id="closed-from" type="date" data-testid="input-closed-from" className={inputCls} value={filters.closedFrom} onChange={(e) => setFilter("closedFrom", e.target.value)} />
                  </div>
                  <div>
                    <label className={labelCls} htmlFor="closed-to">Closed date to</label>
                    <input id="closed-to" type="date" data-testid="input-closed-to" className={inputCls} value={filters.closedTo} onChange={(e) => setFilter("closedTo", e.target.value)} />
                  </div>
                </>
              )}
              <Button variant="outline" data-testid="button-clear-filters" disabled={!filterOn} onClick={() => setFilters(EMPTY_STORE_FILTERS)} className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white">
                <X size={14} className="mr-1" /> Clear filters
              </Button>
            </div>
            <p className="text-xs text-slate-400" data-testid="text-filter-count">
              {tab === "stores"
                ? filterOn
                  ? `${filteredStores.length} of ${stores.length} imported stores match${isDateFilterActive(filters) ? " (closed dates inclusive; stores without a closed date are excluded)" : ""}.`
                  : `Showing all ${stores.length} imported stores.`
                : filters.query.trim()
                  ? `${filteredDetected.length} of ${detected.length} detected batches match. Detected batches have no closed date, so only the name search applies here.`
                  : "Detected batches have no closed date — only the name search applies here."}
            </p>
          </div>
        )}

        {tab === "categories" && <InvoiceCategories />}
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
            ) : filteredStores.length === 0 ? (
              <div className="text-center py-16 px-4" data-testid="state-no-matching-stores">
                <SearchX size={32} className="mx-auto text-slate-600 mb-3" />
                <p className="text-slate-300 font-semibold">No imported stores match these filters</p>
                <p className="text-sm text-slate-500 mt-1">Try a broader name or widen the closed date range.</p>
                <Button variant="outline" onClick={() => setFilters(EMPTY_STORE_FILTERS)} className="mt-4 border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white">Clear filters</Button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-xs text-slate-400">
                      <th className="px-4 py-2.5 font-semibold">Store</th>
                      <th className="px-4 py-2.5 font-semibold">Closed date</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Orders</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Total</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Fundraising</th>
                      <th className="px-4 py-2.5 font-semibold">Customer</th>
                      <th className="px-4 py-2.5 font-semibold text-right">Invoices</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStores.map(({ store, linkedInvoiceCount }) => (
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
            ) : filteredDetected.length === 0 ? (
              <p className="text-center py-12 text-sm text-slate-500" data-testid="state-no-matching-detected">
                No detected batches match that search.
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
                    {filteredDetected.map((d) => (
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
