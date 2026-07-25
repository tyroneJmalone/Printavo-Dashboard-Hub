import { useState } from "react";
import { Link, useParams } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import {
  useGetChipplyStore,
  getGetChipplyStoreQueryKey,
  getListChipplyStoresQueryKey,
  getListDetectedChipplyStoresQueryKey,
  useUpdateChipplyStore,
  type ChipplyStore,
  type UpdateChipplyStoreRequest,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { fmtMoney, fmtDate, parseNumField } from "./ChipplyStores";
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
  const invoices = detailQuery.data?.invoices ?? [];
  const styles = detailQuery.data?.styles ?? [];

  const updateMutation = useUpdateChipplyStore({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetChipplyStoreQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListChipplyStoresQueryKey() });
        queryClient.invalidateQueries({
          queryKey: getListDetectedChipplyStoresQueryKey(),
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
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
        <div>
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
                        <td className="px-4 py-2 text-slate-300 max-w-[18rem] truncate">
                          {inv.nickname ?? "—"}
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
      </div>
    </AppShell>
  );
}
