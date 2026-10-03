import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { DetailedStoreData } from "@/components/chipply/DetailedData";
import { ThreadLinks } from "@/components/merchPipeline/ThreadLinks";
import {
  useGetChipplyStore,
  getGetChipplyStoreQueryKey,
  getListChipplyStoresQueryKey,
  getListDetectedChipplyStoresQueryKey,
  useUpdateChipplyStore,
  useParseChipplyFile,
  useReplaceChipplyStoreStyles,
  useListDirectoryCustomers,
  getListDirectoryCustomersQueryKey,
  type ChipplyStore,
  type ChipplyParsedMarginRow,
  type UpdateChipplyStoreRequest,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney, fmtDate, parseNumField, readCsvFile } from "./ChipplyStores";
import {
  Store,
  Loader2,
  ArrowLeft,
  Pencil,
  X,
  Archive,
  ArchiveRestore,
  Link2,
  Shirt,
  ExternalLink,
  Upload,
  FileSpreadsheet,
  UserCog,
  Search,
  CheckCircle2,
  Compass,
} from "lucide-react";

const inputCls =
  "w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669] placeholder:text-slate-500";
const labelCls = "text-[11px] font-semibold text-slate-300 mb-1 block";

function extractError(err: unknown): string {
  return (
    (err as { data?: { error?: string } })?.data?.error ??
    "Something went wrong."
  );
}

interface EditFields {
  storeName: string;
  eventId: string;
  orgContact: string;
  storeAdmin: string;
  closedAt: string;
  numOrders: string;
  numProducts: string;
  totalDollars: string;
  fundraising: string;
  notes: string;
}

function editFromStore(s: ChipplyStore): EditFields {
  return {
    storeName: s.storeName,
    eventId: s.eventId ?? "",
    orgContact: s.orgContact ?? "",
    storeAdmin: s.storeAdmin ?? "",
    closedAt: s.closedAt ?? "",
    numOrders: s.numOrders !== null ? String(s.numOrders) : "",
    numProducts: s.numProducts !== null ? String(s.numProducts) : "",
    totalDollars: s.totalDollars ?? "",
    fundraising: s.fundraising ?? "",
    notes: s.notes ?? "",
  };
}

/** Money formatter that keeps nulls null so the financials grid can drop
 * missing fields entirely instead of rendering "—". */
function fmtOpt(v: string | null): string | null {
  return v === null ? null : fmtMoney(v);
}

/** Decoration method token embedded in invoice nicknames
 * ("553498 Fuel Summer EMB: …"). Token vocabulary surveyed across all shell
 * nicknames: EMB / HEAT / PRINT dominate, SCREEN / SP / DTF / ENGRAVED rare.
 * Keep in sync with the SQL mapping in the customer-profile method query. */
const METHOD_LABELS: Record<string, string> = {
  EMB: "Embroidery",
  SP: "Screen Printing",
  PRINT: "Screen Printing",
  SCREEN: "Screen Printing",
  DTF: "Heat Applied Graphics",
  HEAT: "Heat Applied Graphics",
  ENGRAVED: "Engraving",
};

const METHOD_TOKEN = /\b(EMB|SP|DTF|HEAT|PRINT|SCREEN|ENGRAVED)\b/i;
const METHOD_TOKEN_BEFORE_COLON =
  /\b(EMB|SP|DTF|HEAT|PRINT|SCREEN|ENGRAVED)\b(?=\s*:)/i;

export function decodeMethod(nickname: string | null): string | null {
  if (!nickname) return null;
  const m =
    nickname.match(METHOD_TOKEN_BEFORE_COLON) ?? nickname.match(METHOD_TOKEN);
  return m ? (METHOD_LABELS[m[1].toUpperCase()] ?? null) : null;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
      <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
        {label}
      </p>
      <p className="text-lg font-bold text-white mt-0.5">{value}</p>
    </div>
  );
}

export default function ChipplyStoreDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<EditFields | null>(null);

  const detailQuery = useGetChipplyStore(id, {
    query: { enabled: !!id, queryKey: getGetChipplyStoreQueryKey(id) },
  });
  const store = detailQuery.data?.store;
  const setupParams = new URLSearchParams(window.location.search);
  const fromSetup = setupParams.get("setup") === "1";
  const setupSection = setupParams.get("section");
  const sectionDone = useRef(false);
  const invoices = detailQuery.data?.invoices ?? [];
  const styles = detailQuery.data?.styles ?? [];
  const marginStyles = detailQuery.data?.marginStyles ?? [];

  // Margin report upload → preview → confirm replace
  const marginFileRef = useRef<HTMLInputElement>(null);
  const [marginPreview, setMarginPreview] = useState<
    ChipplyParsedMarginRow[] | null
  >(null);

  // Customer reassignment
  const [reassignOpen, setReassignOpen] = useState(false);
  const [customerSearch, setCustomerSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(customerSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [customerSearch]);
  const customerParams = { search: debouncedSearch, limit: 8 };
  const customersQuery = useListDirectoryCustomers(customerParams, {
    query: {
      enabled: reassignOpen && debouncedSearch.length >= 2,
      queryKey: getListDirectoryCustomersQueryKey(customerParams),
    },
  });
  const customerResults = customersQuery.data?.customers ?? [];

  const updateMutation = useUpdateChipplyStore({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetChipplyStoreQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListChipplyStoresQueryKey() });
        queryClient.invalidateQueries({
          queryKey: getListDetectedChipplyStoresQueryKey(),
        });
        queryClient.invalidateQueries({
          predicate: (q) =>
            typeof q.queryKey[0] === "string" &&
            q.queryKey[0].startsWith("/api/customers"),
        });
        setEditing(false);
        toast({ title: "Store updated" });
      },
      onError: (err) =>
        toast({
          title: "Update failed",
          description: extractError(err),
          variant: "destructive",
        }),
    },
  });

  const parseFileMutation = useParseChipplyFile({
    mutation: {
      onSuccess: (data) => {
        if (data.kind !== "margin_report") {
          toast({
            title: "That's a SalesReport",
            description:
              "Import SalesReport CSVs from the Chipply Stores page — this panel only takes Margin Reports.",
            variant: "destructive",
          });
          return;
        }
        if (!data.marginRows || data.marginRows.length === 0) {
          toast({
            title: "No styles found",
            description: "The Margin Report had no product rows to import.",
            variant: "destructive",
          });
          return;
        }
        setMarginPreview(data.marginRows);
      },
      onError: (err) =>
        toast({
          title: "Couldn't read that file",
          description: extractError(err),
          variant: "destructive",
        }),
    },
  });

  const replaceStylesMutation = useReplaceChipplyStoreStyles({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({
          queryKey: getGetChipplyStoreQueryKey(id),
        });
        setMarginPreview(null);
        toast({
          title: "Margin report saved",
          description: `${data.styles.length} style${data.styles.length === 1 ? "" : "s"} imported.`,
        });
      },
      onError: (err) =>
        toast({
          title: "Import failed",
          description: extractError(err),
          variant: "destructive",
        }),
    },
  });

  async function handleMarginFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
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

  function reassignCustomer(pvCustomerId: string | null) {
    updateMutation.mutate({ id, data: { pvCustomerId } });
    setReassignOpen(false);
    setCustomerSearch("");
  }

  useEffect(() => {
    if (!store || sectionDone.current || !fromSetup || !setupSection) return;
    sectionDone.current = true;
    if (setupSection === "identity") { setFields(editFromStore(store)); setEditing(true); }
    if (setupSection === "customer") setReassignOpen(true);
    setTimeout(() => document.getElementById(`section-${setupSection}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }, [store, fromSetup, setupSection]);

  function startEdit() {
    if (!store) return;
    setFields(editFromStore(store));
    setEditing(true);
  }

  function setField(key: keyof EditFields, value: string) {
    setFields((f) => (f ? { ...f, [key]: value } : f));
  }

  function handleSave() {
    if (!fields) return;
    const name = fields.storeName.trim();
    if (!name) {
      toast({ title: "Store name is required", variant: "destructive" });
      return;
    }
    let nums: Pick<
      UpdateChipplyStoreRequest,
      "numOrders" | "numProducts" | "totalDollars" | "fundraising"
    >;
    try {
      nums = {
        numOrders: parseNumField(fields.numOrders, "# Orders"),
        numProducts: parseNumField(fields.numProducts, "# Products"),
        totalDollars: parseNumField(fields.totalDollars, "Total dollars"),
        fundraising: parseNumField(fields.fundraising, "Fundraising"),
      };
    } catch (err) {
      toast({
        title: "Check the numbers",
        description: err instanceof Error ? err.message : "Invalid number",
        variant: "destructive",
      });
      return;
    }
    const body: UpdateChipplyStoreRequest = {
      storeName: name,
      eventId: fields.eventId.trim() || null,
      orgContact: fields.orgContact.trim() || null,
      storeAdmin: fields.storeAdmin.trim() || null,
      closedAt: fields.closedAt.trim() || null,
      ...nums,
      notes: fields.notes.trim() || null,
    };
    updateMutation.mutate({ id, data: body });
  }

  function toggleArchive() {
    if (!store) return;
    updateMutation.mutate({ id, data: { archived: !store.archived } });
  }

  if (detailQuery.isLoading) {
    return (
      <AppShell>
        <div className="flex items-center justify-center py-24 text-slate-400">
          <Loader2 size={20} className="animate-spin mr-2" /> Loading store…
        </div>
      </AppShell>
    );
  }

  if (!store) {
    return (
      <AppShell>
        <div className="max-w-3xl mx-auto px-4 py-16 text-center">
          <p className="text-slate-300 font-semibold">Store not found</p>
          <Link href="/chipply" className="text-sm text-[#34d399] hover:underline mt-2 inline-block">
            Back to Chipply stores
          </Link>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="px-6 pt-4"><ThreadLinks storeId={id} suggestedSearch={detailQuery.data?.store?.storeName ?? ""} /></div>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
        {fromSetup && (
          <div data-testid="banner-return-setup" className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-lg border border-[#059669] bg-emerald-950/90 px-3 py-2 text-sm text-emerald-100">
            <Compass size={15} />
            <span className="flex-1">Opened from Guided Setup. Save your change here, then return; your place in the guide is kept.</span>
            <Link href={`/chipply/${id}/setup`} data-testid="link-return-setup" className="font-semibold underline">Return to setup</Link>
          </div>
        )}
        <div id="section-identity">
          <Link
            href="/chipply"
            className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 mb-2"
          >
            <ArrowLeft size={13} /> Chipply Stores
          </Link>
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2">
                <Store size={20} className="text-[#059669]" />
                {store.storeName}
                {store.archived && (
                  <span className="text-[10px] font-bold uppercase tracking-wide bg-slate-800 text-slate-400 rounded px-1.5 py-0.5">
                    Archived
                  </span>
                )}
              </h1>
              <p className="text-sm text-slate-400 mt-0.5">
                {store.eventId ? `Chipply event #${store.eventId}` : "No Chipply event number linked yet"}
                {store.pvCustomerCompany && (
                  <>
                    {" · "}
                    {store.pvCustomerId ? (
                      <Link
                        href={`/customers/${store.pvCustomerId}`}
                        className="text-[#34d399] hover:underline"
                      >
                        {store.pvCustomerCompany}
                      </Link>
                    ) : (
                      store.pvCustomerCompany
                    )}
                  </>
                )}
              </p>
            </div>
            <div className="flex gap-2">
              <Link
                href={`/chipply/${id}/setup`}
                data-testid="link-continue-setup"
                className="inline-flex items-center rounded-md border border-[#059669] px-3 h-9 text-sm text-[#34d399] hover:bg-emerald-950/50"
              >
                <Compass size={14} className="mr-1.5" /> Continue setup
              </Link>
              {!editing && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={startEdit}
                  className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
                >
                  <Pencil size={14} className="mr-1.5" /> Edit
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={toggleArchive}
                disabled={updateMutation.isPending}
                className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                {store.archived ? (
                  <>
                    <ArchiveRestore size={14} className="mr-1.5" /> Restore
                  </>
                ) : (
                  <>
                    <Archive size={14} className="mr-1.5" /> Archive
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>

        <DetailedStoreData storeId={id} />

        {!editing ? (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Total dollars" value={fmtMoney(store.totalDollars)} />
              <StatCard label="Fundraising" value={fmtMoney(store.fundraising)} />
              <StatCard
                label="Orders"
                value={store.numOrders !== null ? String(store.numOrders) : "—"}
              />
              <StatCard
                label="Products"
                value={store.numProducts !== null ? String(store.numProducts) : "—"}
              />
            </div>
            <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-[11px] font-semibold text-slate-400">Closed</p>
                <p className="text-slate-200">{fmtDate(store.closedAt)}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold text-slate-400">Organization contact</p>
                <p className="text-slate-200">{store.orgContact ?? "—"}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold text-slate-400">Store admin</p>
                <p className="text-slate-200">{store.storeAdmin ?? "—"}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold text-slate-400">Notes</p>
                <p className="text-slate-200 whitespace-pre-wrap">{store.notes ?? "—"}</p>
              </div>
            </div>

            {store.orderTotal !== null && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
                <p className="text-sm font-bold text-white flex items-center gap-2 mb-0.5">
                  <FileSpreadsheet size={15} className="text-[#059669]" />
                  SalesReport financials
                </p>
                <p className="text-xs text-slate-500 mb-2.5">
                  From the Chipply SalesReport CSV. Order total includes
                  shipping, handling and tax — it is not the same as Total
                  dollars (sell price).
                </p>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-1.5 text-sm">
                  {(
                    [
                      ["Opened", store.openedAt ? fmtDate(store.openedAt) : null],
                      ["Salesperson", store.salesperson],
                      ["Organization", store.organizationName],
                      ["Order total", fmtOpt(store.orderTotal)],
                      ["Product cost", fmtOpt(store.productCost)],
                      ["Product price", fmtOpt(store.productPrice)],
                      ["Process price", fmtOpt(store.processPrice)],
                      ["Combined price", fmtOpt(store.combinedPrice)],
                      ["Option fees", fmtOpt(store.optionFees)],
                      ["Size upcharges", fmtOpt(store.sizeUpcharges)],
                      ["Tax", fmtOpt(store.tax)],
                      ["Shipping", fmtOpt(store.shipping)],
                      ["Handling", fmtOpt(store.handlingFee)],
                      ["Manual adjustment", fmtOpt(store.manualAdjustment)],
                      ["Org fee", fmtOpt(store.orgFee)],
                      ["Chipply fee", fmtOpt(store.chipplyFee)],
                      ["CC processing", fmtOpt(store.ccProcessingFee)],
                      ["Paid by card", fmtOpt(store.paymentCard)],
                      ["Paid by Klarna", fmtOpt(store.paymentKlarna)],
                      ["Paid by e-cert", fmtOpt(store.paymentEcert)],
                      ["Paid by PO", fmtOpt(store.paymentPo)],
                      ["Promo codes", fmtOpt(store.paymentPromo)],
                    ] as const
                  )
                    .filter(([, v]) => v !== null)
                    .map(([label, v]) => (
                      <div key={label} className="flex justify-between gap-3">
                        <span className="text-slate-400 text-xs pt-0.5">{label}</span>
                        <span className="text-slate-200 font-mono text-xs pt-0.5">{v}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </>
        ) : (
          fields && (
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                <div className="col-span-2">
                  <label className={labelCls}>Store name</label>
                  <input
                    className={inputCls}
                    value={fields.storeName}
                    onChange={(e) => setField("storeName", e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}>Chipply event #</label>
                  <input
                    className={inputCls}
                    value={fields.eventId}
                    onChange={(e) => setField("eventId", e.target.value)}
                    placeholder="553498"
                  />
                </div>
                <div>
                  <label className={labelCls}>Organization contact</label>
                  <input
                    className={inputCls}
                    value={fields.orgContact}
                    onChange={(e) => setField("orgContact", e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}>Store admin</label>
                  <input
                    className={inputCls}
                    value={fields.storeAdmin}
                    onChange={(e) => setField("storeAdmin", e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}>Closed date (YYYY-MM-DD)</label>
                  <input
                    className={inputCls}
                    value={fields.closedAt}
                    onChange={(e) => setField("closedAt", e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}># Orders</label>
                  <input
                    className={inputCls}
                    value={fields.numOrders}
                    onChange={(e) => setField("numOrders", e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}># Products</label>
                  <input
                    className={inputCls}
                    value={fields.numProducts}
                    onChange={(e) => setField("numProducts", e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}>Total dollars</label>
                  <input
                    className={inputCls}
                    value={fields.totalDollars}
                    onChange={(e) => setField("totalDollars", e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}>Fundraising</label>
                  <input
                    className={inputCls}
                    value={fields.fundraising}
                    onChange={(e) => setField("fundraising", e.target.value)}
                  />
                </div>
                <div className="col-span-2 md:col-span-3">
                  <label className={labelCls}>Notes</label>
                  <textarea
                    className={`${inputCls} min-h-[70px]`}
                    value={fields.notes}
                    onChange={(e) => setField("notes", e.target.value)}
                  />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(false)}
                  className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
                >
                  <X size={14} className="mr-1.5" /> Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={updateMutation.isPending}
                  className="bg-[#059669] hover:bg-[#047857] text-white"
                >
                  {updateMutation.isPending && (
                    <Loader2 size={14} className="animate-spin mr-1.5" />
                  )}
                  Save
                </Button>
              </div>
            </div>
          )
        )}

        <div id="section-customer" className="bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm">
              <UserCog size={15} className="text-[#059669]" />
              <span className="font-bold text-white">Customer</span>
              {store.pvCustomerId ? (
                <Link
                  href={`/customers/${store.pvCustomerId}`}
                  className="text-[#34d399] hover:underline"
                >
                  {store.pvCustomerCompany ?? store.pvCustomerId}
                </Link>
              ) : (
                <span className="text-slate-500">not linked</span>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setReassignOpen((o) => !o);
                  setCustomerSearch("");
                }}
                className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                {reassignOpen ? (
                  <>
                    <X size={14} className="mr-1.5" /> Cancel
                  </>
                ) : store.pvCustomerId ? (
                  "Change customer"
                ) : (
                  "Link customer"
                )}
              </Button>
              {store.pvCustomerId && !reassignOpen && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => reassignCustomer(null)}
                  disabled={updateMutation.isPending}
                  className="border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-white"
                >
                  Unlink
                </Button>
              )}
            </div>
          </div>
          {reassignOpen && (
            <div className="mt-3 space-y-2">
              <div className="relative">
                <Search
                  size={14}
                  className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500"
                />
                <input
                  className={`${inputCls} pl-8`}
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Search customers by name…"
                  autoFocus
                />
              </div>
              {debouncedSearch.length < 2 ? (
                <p className="text-xs text-slate-500">
                  Type at least 2 characters to search.
                </p>
              ) : customersQuery.isLoading ? (
                <p className="text-xs text-slate-500 flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> Searching…
                </p>
              ) : customerResults.length === 0 ? (
                <p className="text-xs text-slate-500">No customers matched.</p>
              ) : (
                <div className="space-y-1">
                  {customerResults.map((c) => {
                    const current = c.printavoId === store.pvCustomerId;
                    return (
                      <button
                        key={c.printavoId}
                        type="button"
                        onClick={() => !current && reassignCustomer(c.printavoId)}
                        disabled={updateMutation.isPending || current}
                        className={`w-full text-left rounded-lg border px-3 py-2 text-sm transition-colors ${
                          current
                            ? "border-[#059669] bg-emerald-950/40 cursor-default"
                            : "border-slate-700 bg-slate-800 hover:border-slate-500"
                        }`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-slate-100">
                            {c.displayName}
                          </span>
                          {current && (
                            <CheckCircle2
                              size={15}
                              className="text-[#059669] shrink-0"
                            />
                          )}
                        </span>
                        <span className="text-xs text-slate-400">
                          {c.orderCount} order{c.orderCount === 1 ? "" : "s"} ·{" "}
                          {fmtMoney(c.lifetimeSpend)} lifetime
                          {c.contactName ? ` · ${c.contactName}` : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="grid lg:grid-cols-2 gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Link2 size={15} className="text-[#059669]" />
                Linked Printavo invoices
              </h2>
              <span className="text-xs text-slate-500">{invoices.length}</span>
            </div>
            {!store.eventId ? (
              <p className="px-4 py-8 text-sm text-slate-500 text-center">
                Link a Chipply event number to see the matching Printavo invoices here.
              </p>
            ) : invoices.length === 0 ? (
              <p className="px-4 py-8 text-sm text-slate-500 text-center">
                No Printavo invoices found starting with "{store.eventId}" yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-xs text-slate-400">
                      <th className="px-4 py-2 font-semibold">Invoice</th>
                      <th className="px-4 py-2 font-semibold">Name</th>
                      <th className="px-4 py-2 font-semibold">Method</th>
                      <th className="px-4 py-2 font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <tr
                        key={inv.printavoId}
                        className="border-b border-slate-800/60 last:border-0"
                      >
                        <td className="px-4 py-2 whitespace-nowrap">
                          <a
                            href={`https://www.printavo.com/invoices/${inv.visualId}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[#34d399] hover:underline inline-flex items-center gap-1 font-semibold"
                          >
                            #{inv.visualId}
                            <ExternalLink size={11} />
                          </a>
                        </td>
                        <td className="px-4 py-2 text-slate-300 max-w-[14rem] truncate">
                          {inv.nickname ?? "—"}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-xs">
                          {decodeMethod(inv.nickname) ? (
                            <span className="bg-slate-800 text-slate-300 rounded px-1.5 py-0.5 font-semibold">
                              {decodeMethod(inv.nickname)}
                            </span>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-slate-400 whitespace-nowrap text-xs">
                          {inv.statusName ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Shirt size={15} className="text-[#059669]" />
                Styles across linked invoices
              </h2>
              <span className="text-xs text-slate-500">{styles.length}</span>
            </div>
            {styles.length === 0 ? (
              <p className="px-4 py-8 text-sm text-slate-500 text-center">
                No line items on the linked invoices yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-xs text-slate-400">
                      <th className="px-4 py-2 font-semibold">Style</th>
                      <th className="px-4 py-2 font-semibold">Description</th>
                      <th className="px-4 py-2 font-semibold text-right">Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {styles.map((s, i) => (
                      <tr key={i} className="border-b border-slate-800/60 last:border-0">
                        <td className="px-4 py-2 whitespace-nowrap text-slate-200 font-semibold">
                          {[s.brand, s.itemNumber].filter(Boolean).join(" ") || "—"}
                        </td>
                        <td className="px-4 py-2 text-slate-300 max-w-[16rem] truncate">
                          {s.description ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-200">{s.totalQty}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div id="section-margins" className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between gap-3 flex-wrap">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <FileSpreadsheet size={15} className="text-[#059669]" />
              Margin report (per style)
              <span className="text-xs text-slate-500 font-normal">
                {marginPreview
                  ? `${marginPreview.length} parsed — not saved yet`
                  : marginStyles.length || ""}
              </span>
            </h2>
            <input
              ref={marginFileRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleMarginFilePicked}
              className="hidden"
            />
            {marginPreview ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setMarginPreview(null)}
                  disabled={replaceStylesMutation.isPending}
                  className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
                >
                  <X size={14} className="mr-1.5" /> Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    replaceStylesMutation.mutate({
                      id,
                      data: { rows: marginPreview },
                    })
                  }
                  disabled={replaceStylesMutation.isPending}
                  className="bg-[#059669] hover:bg-[#047857] text-white"
                >
                  {replaceStylesMutation.isPending ? (
                    <Loader2 size={14} className="animate-spin mr-1.5" />
                  ) : (
                    <CheckCircle2 size={14} className="mr-1.5" />
                  )}
                  {marginStyles.length > 0
                    ? "Replace saved styles"
                    : "Save styles"}
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => marginFileRef.current?.click()}
                disabled={parseFileMutation.isPending}
                className="border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
              >
                {parseFileMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin mr-1.5" />
                ) : (
                  <Upload size={14} className="mr-1.5" />
                )}
                Upload margin report
              </Button>
            )}
          </div>
          <p className="text-xs text-slate-400">
            For a “Data-Export-All-Results” file, use{" "}
            <Link href="/chipply" className="text-emerald-400 underline">Chipply Stores → Import detailed data · CSV / XLSX</Link>
            {" "}instead. This uploader expects the separate Margin Report with per-style total sales, costs, and profit.
          </p>
          {marginPreview && marginStyles.length > 0 && (
            <p className="px-4 py-2 text-xs text-amber-200 bg-amber-950/40 border-b border-amber-800/50">
              Saving replaces the {marginStyles.length} style
              {marginStyles.length === 1 ? "" : "s"} currently on this store.
            </p>
          )}
          {(() => {
            const rows = (marginPreview ?? marginStyles).map((r) => ({
              vendorName: r.vendorName,
              style: r.style,
              productName: r.productName,
              purchases: r.purchases,
              totalSale: r.totalSale !== null ? Number(r.totalSale) : null,
              totalCost: r.totalCost !== null ? Number(r.totalCost) : null,
              totalProfit: r.totalProfit !== null ? Number(r.totalProfit) : null,
            }));
            if (rows.length === 0) {
              return (
                <p className="px-4 py-8 text-sm text-slate-500 text-center">
                  Upload this store's Margin Report CSV from Chipply to see
                  per-style sales, cost and profit.
                </p>
              );
            }
            const sum = (key: "purchases" | "totalSale" | "totalCost" | "totalProfit") =>
              rows.reduce((acc, r) => acc + (r[key] ?? 0), 0);
            return (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-800 text-left text-xs text-slate-400">
                      <th className="px-4 py-2 font-semibold">Vendor</th>
                      <th className="px-4 py-2 font-semibold">Style</th>
                      <th className="px-4 py-2 font-semibold">Product</th>
                      <th className="px-4 py-2 font-semibold text-right">Purchases</th>
                      <th className="px-4 py-2 font-semibold text-right">Sale</th>
                      <th className="px-4 py-2 font-semibold text-right">Cost</th>
                      <th className="px-4 py-2 font-semibold text-right">Profit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-b border-slate-800/60">
                        <td className="px-4 py-2 whitespace-nowrap text-slate-300">
                          {r.vendorName ?? "—"}
                        </td>
                        <td className="px-4 py-2 whitespace-nowrap text-slate-200 font-semibold">
                          {r.style ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-slate-300 max-w-[20rem] truncate">
                          {r.productName ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-200">
                          {r.purchases ?? "—"}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-200 font-mono text-xs">
                          {r.totalSale !== null ? fmtMoney(r.totalSale) : "—"}
                        </td>
                        <td className="px-4 py-2 text-right text-slate-200 font-mono text-xs">
                          {r.totalCost !== null ? fmtMoney(r.totalCost) : "—"}
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-mono text-xs ${
                            (r.totalProfit ?? 0) < 0
                              ? "text-red-400"
                              : "text-[#34d399]"
                          }`}
                        >
                          {r.totalProfit !== null ? fmtMoney(r.totalProfit) : "—"}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-800/40 font-semibold">
                      <td className="px-4 py-2 text-slate-300" colSpan={3}>
                        Totals
                      </td>
                      <td className="px-4 py-2 text-right text-slate-100">
                        {sum("purchases")}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-100 font-mono text-xs">
                        {fmtMoney(sum("totalSale"))}
                      </td>
                      <td className="px-4 py-2 text-right text-slate-100 font-mono text-xs">
                        {fmtMoney(sum("totalCost"))}
                      </td>
                      <td
                        className={`px-4 py-2 text-right font-mono text-xs ${
                          sum("totalProfit") < 0 ? "text-red-400" : "text-[#34d399]"
                        }`}
                      >
                        {fmtMoney(sum("totalProfit"))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            );
          })()}
        </div>
      </div>
    </AppShell>
  );
}
