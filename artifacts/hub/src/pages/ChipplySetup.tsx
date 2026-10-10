import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useGetChipplyStore, getGetChipplyStoreQueryKey, triggerPoll, type ChipplyLinkedInvoice } from "@workspace/api-client-react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { ImportReview, DetailedStoreData } from "@/components/chipply/DetailedData";
import { SummaryPanel } from "@/components/chipply/SummaryImport";
import { InvoiceCategories } from "@/components/chipply/InvoiceCategories";
import { useChipplySetup, useSaveChipplySetup, isConflict, setupErrorMessage, chipplySetupKey, type ChipplySetup as Setup, type ChipplySetupUpdate } from "@/hooks/use-chipply-setup";
import { STEPS, RESOLVED_OUTCOMES, REQUIRED_CONFIRMS, factsFor, factsOk, allFactsOk, priorConfirmed, canConfirm, stepSatisfied, isComplete, nextAttention, toggleConfirmed, syncNotes, unresolvedCount } from "@/lib/chipply-setup-logic";
import { ArrowLeft, ArrowRight, Check, CircleDashed, Loader2, LogOut, RefreshCcw, ShieldCheck, UserCheck, AlertTriangle, ExternalLink, SkipForward, Compass } from "lucide-react";

const OUTCOME_HELP: Record<string, string> = {
  ambiguous: "More than one Printavo invoice could fit these rows. Pick the right invoice, with a reason, in the reconciliation table below.",
  "quantity-mismatch": "The complete process group differs, not necessarily every source row. Expand Garment quantities by process below to see missing, extra, or changed style/color/size combinations.",
  incomplete: "The matching invoice has stale, incomplete, or invalid quantity details. Inspect Garment quantities by process below; run the sync in step 4, then Refresh facts.",
  unmatched: "No invoice for this event carries the matching process suffix in its nickname (for example \"<event> <store> EMB: ...\"). Check the existing invoice nicknames in Printavo and sync before considering anything new.",
  unverified: "Hub has no verified production status for these rows yet. This usually clears after invoices sync and reach a recognized status.",
};
const money = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

function Pill({ kind, children }: { kind: "hub" | "user" | "open" | "skip"; children: ReactNode }) {
  const cls = { hub: "bg-emerald-950/60 text-emerald-300 border-emerald-800", user: "bg-sky-950/60 text-sky-300 border-sky-800", open: "bg-amber-950/50 text-amber-300 border-amber-800", skip: "bg-slate-800 text-slate-400 border-slate-700" }[kind];
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${cls}`}>{children}</span>;
}

export default function ChipplySetupPage() {
  const { id = "" } = useParams<{ id: string }>();
  const [, navigate] = useLocation();
  const client = useQueryClient();
  const setupQ = useChipplySetup(id);
  const storeQ = useGetChipplyStore(id, { query: { enabled: !!id, queryKey: getGetChipplyStoreQueryKey(id) } });
  const save = useSaveChipplySetup(id);
  const [view, setView] = useState(1);
  const [notes, setNotes] = useState("");
  const lastServerNotes = useRef("");
  const [conflict, setConflict] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [embedBusy, setEmbedBusy] = useState(false);
  const [sync, setSync] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });
  const init = useRef<string | null>(null);
  const s = setupQ.data;

  useEffect(() => {
    if (!s) return;
    if (init.current !== id) {
      init.current = id;
      setView(Math.min(9, Math.max(1, s.currentStep)));
      setNotes(s.notes);
    } else {
      setNotes((local) => syncNotes(local, lastServerNotes.current, s.notes));
    }
    lastServerNotes.current = s.notes;
  }, [s, id]);

  // Writes in flight (guide save, embedded import, override, category review, sync) block leaving.
  const locked = save.isPending || embedBusy || sync.busy;
  const blocked = locked || !!conflict;
  useEffect(() => {
    if (!locked) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [locked]);

  function persist(next: Partial<ChipplySetupUpdate>, after?: () => void) {
    if (!s || blocked) return;
    setSaveError(null);
    // Unsaved note edits ride along; untouched notes equal the latest server copy.
    save.mutate({ base: s, next: { currentStep: view, confirmedSteps: s.confirmedSteps, marginSkipped: s.marginSkipped, notes, ...next } }, {
      onSuccess: () => after?.(),
      onError: (err) => {
        if (isConflict(err)) {
          setConflict("Someone else saved this guide, or the store's facts changed (sync, import, edit) since you loaded it. Your last action was not saved. The latest progress is loaded; your unsaved note text is kept. Review, then repeat the action if it still applies.");
          void setupQ.refetch();
        } else setSaveError(setupErrorMessage(err));
      },
    });
  }
  const go = (n: number) => persist({ currentStep: n }, () => setView(n));
  const leave = (to: string) => persist({ currentStep: view }, () => navigate(to));
  const refreshAll = () => {
    void client.invalidateQueries({ queryKey: chipplySetupKey(id) });
    void client.invalidateQueries({ queryKey: getGetChipplyStoreQueryKey(id) });
    void client.invalidateQueries({ queryKey: ["chipply-detailed-data", id] });
  };
  async function runSync() {
    setSync({ busy: true, msg: null });
    let msg: string;
    try {
      const r = await triggerPoll();
      msg = r.ran ? (r.stats ? r.message : "Sync started. It usually takes a minute or two; use Refresh facts afterwards.") : r.message;
    } catch (err) { msg = setupErrorMessage(err); }
    setSync({ busy: false, msg });
    refreshAll();
  }

  if (setupQ.isLoading) return <AppShell><div className="max-w-6xl mx-auto px-4 py-8 space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-16 rounded-xl bg-slate-900 animate-pulse" />)}</div></AppShell>;
  if (setupQ.error || !s) return <AppShell><div className="max-w-xl mx-auto px-4 py-16 text-center space-y-3">
    <p className="text-slate-200 font-semibold">Couldn't load the setup guide</p>
    <p role="alert" className="text-sm text-slate-400">{setupErrorMessage(setupQ.error)}</p>
    <div className="flex justify-center gap-2"><Button data-testid="button-retry-setup" onClick={() => void setupQ.refetch()}>Retry</Button><Link href={`/chipply/${id}`} className="text-sm text-[#34d399] underline self-center">Back to store</Link></div>
  </div></AppShell>;

  const c = s.checks;
  const def = STEPS[view - 1];
  const complete = isComplete(s);
  const next = nextAttention(view, s);
  const notesDirty = notes !== s.notes;
  const pendingCount = STEPS.filter((d) => !stepSatisfied(d.n, s)).length;

  return <AppShell>
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <button data-testid="link-setup-store" disabled={blocked} onClick={() => leave(`/chipply/${id}`)} className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 mb-1 disabled:opacity-50"><ArrowLeft size={13} />{c.storeName}</button>
          <h1 className="text-xl font-bold text-white flex items-center gap-2"><Compass size={20} className="text-[#059669]" />Guided Chipply Setup</h1>
          <p data-testid="text-setup-saved" className="text-xs text-slate-500 mt-0.5">
            {s.updatedAt ? `Shared with all staff · last saved ${new Date(s.updatedAt).toLocaleString()}` : "Not saved yet. Progress saves on Next, Back, confirm, skip, note save and leaving, and is shared with all staff."}
            {save.isPending && <span className="ml-2 text-slate-300"><Loader2 size={11} className="inline animate-spin mr-1" />Saving</span>}
            {embedBusy && <span className="ml-2 text-amber-300">A write is in progress below; navigation waits until it finishes.</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button data-testid="button-refresh-facts" size="sm" variant="outline" onClick={refreshAll} disabled={setupQ.isFetching} className="border-slate-700 text-slate-300 hover:bg-slate-800"><RefreshCcw size={14} className={`mr-1.5 ${setupQ.isFetching ? "animate-spin" : ""}`} />Refresh facts</Button>
          <Button data-testid="button-save-exit" size="sm" disabled={blocked} onClick={() => leave(`/chipply/${id}`)} className="bg-[#059669] hover:bg-[#047857] text-white"><LogOut size={14} className="mr-1.5" />Save & exit</Button>
        </div>
      </header>

      {conflict && <div role="alert" data-testid="status-setup-conflict" className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-100 flex flex-wrap gap-3 items-start">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" /><span className="flex-1">{conflict}</span>
        <Button size="sm" variant="outline" data-testid="button-dismiss-conflict" disabled={setupQ.isFetching} onClick={() => setConflict(null)}>{setupQ.isFetching ? "Loading latest" : "I've reviewed the latest"}</Button>
      </div>}
      {saveError && <p role="alert" className="rounded-lg border border-red-800 bg-red-950/30 p-3 text-sm text-red-200">Not saved: {saveError}</p>}
      {s.staleConfirmations && <p data-testid="status-stale-confirmations" className="rounded-lg border border-sky-800 bg-sky-950/30 p-3 text-sm text-sky-100">Store facts changed after someone confirmed a step, so Hub cleared those confirmations. Re-check and confirm again.</p>}

      <div className="grid lg:grid-cols-[220px_1fr] gap-4">
        <nav aria-label="Setup steps" className="rounded-xl border border-slate-800 bg-slate-900 p-2 h-fit">
          {STEPS.map((d) => {
            const sat = stepSatisfied(d.n, s);
            const skipped = d.n === 8 && s.marginSkipped && !c.marginRowCount;
            return <button key={d.n} data-testid={`button-step-${d.n}`} disabled={blocked} onClick={() => go(d.n)} className={`w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed ${view === d.n ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"}`}>
              <span className={`grid place-items-center h-5 w-5 rounded-full text-[10px] font-bold shrink-0 ${sat ? "bg-[#059669] text-white" : "border border-slate-600 text-slate-400"}`}>{sat ? <Check size={11} /> : d.n}</span>
              <span className="flex-1 truncate">{d.short}</span>
              {skipped ? <span className="text-[10px] text-slate-500">skipped</span> : d.optional && <span className="text-[10px] text-slate-500">optional</span>}
            </button>;
          })}
          <div className={`mt-2 rounded-lg px-2.5 py-2 text-xs ${complete ? "bg-emerald-950/50 text-emerald-200" : "bg-slate-800/60 text-slate-400"}`} data-testid="status-setup-complete">
            {complete ? "Setup complete" : `${pendingCount} step${pendingCount === 1 ? "" : "s"} need attention`}
          </div>
        </nav>

        <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 space-y-4 min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Step {view} of 9{def.optional ? " · optional" : ""}</p><h2 className="text-lg font-bold text-white">{def.title}</h2></div>
            {stepSatisfied(view, s) ? <Pill kind="hub"><Check size={10} />Done</Pill> : <Pill kind="open">Needs attention</Pill>}
          </div>

          <ul className="space-y-1.5">{factsFor(view, s).map((f, i) => <li key={`${f.label}-${i}`} className="flex flex-wrap items-center gap-2 text-sm">
            {f.ok ? <Pill kind="hub"><ShieldCheck size={10} />Verified by Hub</Pill> : <Pill kind="open"><CircleDashed size={10} />Unresolved</Pill>}
            <span className="text-slate-200">{f.label}</span>{f.detail && <span className="text-slate-500">· {f.detail}</span>}
          </li>)}</ul>

          <StepBody n={view} s={s} id={id} invoices={storeQ.data?.invoices ?? []} invoicesLoading={storeQ.isLoading} eventId={storeQ.data?.store?.eventId ?? c.eventId}
            sync={sync} runSync={runSync} onImported={refreshAll} disabled={blocked} onLeave={leave} onBusyChange={setEmbedBusy}
            skipMargins={() => persist({ marginSkipped: !s.marginSkipped })} />

          {def.confirm && <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3 flex flex-wrap items-center gap-3">
            {s.confirmedSteps.includes(view) ? <Pill kind="user"><UserCheck size={10} />Confirmed by user</Pill> : <Pill kind="open">Not confirmed</Pill>}
            <span className="text-sm text-slate-300 flex-1">{def.confirm}.</span>
            <Button data-testid={`button-confirm-step-${view}`} size="sm" variant="outline" disabled={blocked || (!s.confirmedSteps.includes(view) && !canConfirm(view, s))} onClick={() => persist({ confirmedSteps: toggleConfirmed(s.confirmedSteps, view) })}>
              {s.confirmedSteps.includes(view) ? "Withdraw confirmation" : "Confirm"}
            </Button>
            {!s.confirmedSteps.includes(view) && !canConfirm(view, s) && <p className="w-full text-xs text-amber-300">
              {view === 9 ? `Unlocks once every Hub fact is verified, margins are imported or skipped, and steps ${REQUIRED_CONFIRMS.filter((k) => !s.confirmedSteps.includes(k)).join(", ") || REQUIRED_CONFIRMS.join(", ")} are confirmed.` : "Unlocks once the Hub facts above are verified."}
            </p>}
          </div>}

          <div className="rounded-lg border border-slate-800 p-3 space-y-2">
            <label className="text-[11px] font-semibold text-slate-300 block" htmlFor="setup-notes">Shared notes{notesDirty && <span className="ml-2 text-amber-300 font-normal">unsaved, saves with your next action</span>}</label>
            <textarea id="setup-notes" data-testid="input-setup-notes" value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} className="w-full min-h-[60px] rounded-lg border border-slate-700 bg-slate-800 p-2 text-sm text-slate-200 focus:outline-none focus:border-[#059669]" placeholder="What's pending, who's on it" />
            <div className="flex gap-2">
              <Button data-testid="button-save-notes" size="sm" variant="outline" disabled={blocked || !notesDirty} onClick={() => persist({})}>Save note</Button>
              {notesDirty && <Button data-testid="button-discard-notes" size="sm" variant="ghost" disabled={save.isPending} onClick={() => setNotes(s.notes)}>Discard edit</Button>}
            </div>
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
            <Button data-testid="button-step-back" variant="outline" disabled={blocked || view === 1} onClick={() => go(view - 1)} className="border-slate-700 text-slate-300"><ArrowLeft size={14} className="mr-1.5" />Back</Button>
            <div className="flex flex-wrap gap-2">
              {next && <Button data-testid="button-next-attention" variant="outline" disabled={blocked} onClick={() => go(next.n)} className="border-slate-700 text-slate-300"><SkipForward size={14} className="mr-1.5" />Next needing attention: {next.short}</Button>}
              {view < 9 && <Button data-testid="button-step-next" disabled={blocked} onClick={() => go(view + 1)} className="bg-[#059669] hover:bg-[#047857] text-white">Next<ArrowRight size={14} className="ml-1.5" /></Button>}
            </div>
          </footer>
          <p className="text-[11px] text-slate-500">Next only moves you along. Steps are done when Hub verifies the facts and, where asked, a person confirms.</p>
        </section>
      </div>
    </div>
  </AppShell>;
}

function DeepLink({ to, testId, disabled, onLeave, children }: { to: string; testId: string; disabled: boolean; onLeave: (to: string) => void; children: ReactNode }) {
  return <button type="button" data-testid={testId} disabled={disabled} onClick={() => onLeave(to)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 hover:border-[#059669] disabled:opacity-50 disabled:cursor-not-allowed">{children}<ExternalLink size={12} className="text-slate-500" /></button>;
}

function StepBody({ n, s, id, invoices, invoicesLoading, eventId, sync, runSync, onImported, disabled, onLeave, onBusyChange, skipMargins }: {
  n: number; s: Setup; id: string; invoices: ChipplyLinkedInvoice[]; invoicesLoading: boolean; eventId: string | null;
  sync: { busy: boolean; msg: string | null }; runSync: () => void; onImported: () => void;
  disabled: boolean; onLeave: (to: string) => void; onBusyChange: (busy: boolean) => void; skipMargins: () => void;
}) {
  const c = s.checks;
  const p = "text-sm text-slate-400";
  const edit = (section: string) => `/chipply/${id}?setup=1&section=${section}`;
  const link = (to: string, testId: string, label: string) => <DeepLink to={to} testId={testId} disabled={disabled} onLeave={onLeave}>{label}</DeepLink>;
  const unresolved = Object.entries(c.outcomes).filter(([k, v]) => !RESOLVED_OUTCOMES.has(k) && v > 0);
  switch (n) {
    case 1: return <div className="space-y-3"><p className={p}>The event number ties this store to Printavo invoices whose nickname starts with it. Edit on the store page; your step is saved and the banner there brings you back.</p>{link(edit("identity"), "link-edit-identity", "Edit store identity")}<SummaryPanel storeId={id} disabled={disabled} onLeave={onLeave} onBusyChange={onBusyChange} /></div>;
    case 2: return <div className="space-y-3"><p className={p}>Hub can only tell that some customer is linked. You confirm it is the right organization. Reports filter by the closed date.</p><div className="flex flex-wrap gap-2">{link(edit("customer"), "link-edit-customer", "Link or change customer")}{link(edit("identity"), "link-edit-dates", "Edit closed date")}</div><SummaryPanel storeId={id} disabled={disabled} onLeave={onLeave} onBusyChange={onBusyChange} compact /></div>;
    case 3: return <div className="space-y-3">
      <p className={p}>Open each invoice in Printavo and check:</p>
      <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm text-slate-300 list-disc pl-5">
        <li>Customer is this store's organization</li><li>Nickname starts with event {eventId ?? "#"} and names the process (EMB, PRINT, HEAT...)</li>
        <li>Styles, colors, sizes and quantities fit the Chipply orders</li><li>Status reflects where production actually is</li><li>Production date is plausible for the close date</li>
      </ul>
      {!eventId ? <p className="text-sm text-amber-300">Link an event number in step 1 first.</p>
        : invoicesLoading ? <div className="h-20 rounded-lg bg-slate-800 animate-pulse" />
        : invoices.length === 0 ? <p className="text-sm text-amber-300">Hub's mirror has no invoices starting with {eventId}. Sync in step 4 first, then search Printavo for existing invoices before creating anything.</p>
        : <div className="divide-y divide-slate-800 rounded-lg border border-slate-800">{invoices.map((i) => <div key={i.printavoId} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
          <a data-testid={`link-invoice-${i.printavoId}`} href={`https://www.printavo.com/invoices/${i.visualId}`} target="_blank" rel="noopener noreferrer" className="font-mono text-[#34d399] underline">#{i.visualId}</a>
          <span className="flex-1 min-w-40 text-slate-200">{i.nickname ?? "No nickname"}</span><span className="text-xs text-slate-400">{i.statusName ?? "Unknown status"}</span>
        </div>)}</div>}
      {c.incompleteInvoiceCount > 0 && <p className="text-xs text-amber-300">{c.incompleteInvoiceCount} invoice(s) have incomplete line detail. Sync in step 4.</p>}
    </div>;
    case 4: return <div className="space-y-3">
      <p className={p}>Pulls new and changed Printavo orders and their line items, the same as the top-bar sync. Safe to repeat; Hub skips it if one is already running. Read-only on Printavo.</p>
      <Button data-testid="button-run-sync" onClick={runSync} disabled={sync.busy} variant="outline">{sync.busy ? <Loader2 size={14} className="mr-1.5 animate-spin" /> : <RefreshCcw size={14} className="mr-1.5" />}Sync Printavo now</Button>
      {sync.msg && <p role="status" data-testid="text-sync-result" className="text-sm text-slate-300">{sync.msg}</p>}
    </div>;
    case 5: return <div className="space-y-3">
      <p className={p}>Upload the complete detailed export for this one store. Each upload is a full snapshot that replaces the current one (history kept), never a delta to add on top. Hub rejects an export whose sales order belongs to a different store. Saved only in Hub.</p>
      {c.snapshotId && <p className="text-sm text-emerald-300">Current snapshot: {c.orderCount} orders · {c.quantity} units · {money(c.itemTotalCents)} line sales. Compare these with the Chipply portal, then confirm below.</p>}
      <div className="rounded-lg border border-slate-800 p-3"><ImportReview expectedStoreId={id} onSaved={onImported} onBusyChange={onBusyChange} /></div>
    </div>;
    case 6: return <div className="space-y-3">
      <p className={p}>Each Chipply row is matched to a Printavo invoice. Actual decoration comes from invoice status and nickname, not categories or Chipply's planned process. {unresolvedCount(c.outcomes) > 0 && "You can continue with unresolved rows; they stay counted."}</p>
      {!c.snapshotId ? <p className="text-sm text-amber-300">Import the detailed export in step 5 first.</p> : unresolved.length === 0 ? <p className="text-sm text-emerald-300">Every row is matched or reviewed.</p> :
        <ul className="space-y-2">{unresolved.map(([k, v]) => <li key={k} data-testid={`text-outcome-${k}`} className="rounded-lg border border-amber-900/60 bg-amber-950/20 p-3 text-sm"><span className="font-semibold text-amber-200">{v} {k} row{v === 1 ? "" : "s"}</span><p className="text-slate-300 mt-0.5">{OUTCOME_HELP[k] ?? "Review these rows in the reconciliation table."}</p></li>)}</ul>}
      {c.snapshotId && <DetailedStoreData storeId={id} onBusyChange={onBusyChange} />}
    </div>;
    case 7: return <div className="space-y-3">
      <p className={p}>Hub can only see whether lines have a category, not whether it is the right one. Review the assigned categories and confirm below. Categories keep Printavo tidy but do not decide the actual method in reports. Changes use the usual preview and confirm.</p>
      {eventId ? <InvoiceCategories eventId={eventId} onBusyChange={onBusyChange} /> : <p className="text-sm text-amber-300">Link an event number in step 1 to scope categories.</p>}
    </div>;
    case 8: return <div className="space-y-3">
      <p className={p}>Optional. A Chipply Margin Report has one row per style with total sales, costs and profit; it carries no store name, so upload it from this store's page. A new upload replaces this store's current margin rows. Chipply dollars stay separate from Printavo revenue. Import it or skip explicitly to resolve this step.</p>
      <div className="flex flex-wrap gap-2 items-center">
        {link(edit("margins"), "link-margins", "Upload margin report")}
        {!c.marginRowCount && <Button data-testid="button-skip-margins" size="sm" variant="outline" disabled={disabled} onClick={skipMargins}>{s.marginSkipped ? "Undo skip" : "Skip margins"}</Button>}
        {s.marginSkipped && !c.marginRowCount && <Pill kind="skip">Skipped by user</Pill>}
      </div>
    </div>;
    default: {
      const complete = isComplete(s);
      return <div className="space-y-3">
        <p className={p}>{complete ? "Every Hub fact is verified and each required step is confirmed by staff." : allFactsOk(s) ? (priorConfirmed(s) ? "Hub facts are verified. Confirm below to finish." : "Hub facts are verified, but some steps still need your confirmation.") : "Some items are still unresolved. You can stop here; they stay listed until fixed."}</p>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-sm">
          {([["Unresolved rows", unresolvedCount(c.outcomes)], ["Lines missing category", c.missingCategoryCount], ["Incomplete invoices", c.incompleteInvoiceCount], ["Summary differences", c.summaryConflictCount ?? 0], ["Steps unconfirmed", REQUIRED_CONFIRMS.filter((k) => !s.confirmedSteps.includes(k)).length]] as const).map(([l, v]) => <div key={l} className="rounded-lg bg-slate-800 p-3"><p className="text-xs text-slate-400">{l}</p><p data-testid={`text-final-${l.replace(/\s/g, "-").toLowerCase()}`} className={`text-lg font-bold ${v ? "text-amber-300" : "text-white"}`}>{v}</p></div>)}
        </div>
        {!factsOk(8, s) && <p className="text-xs text-amber-300">Margins: import a Margin Report or skip it in step 8.</p>}
        {(c.summaryConflictCount ?? 0) > 0 && <SummaryPanel storeId={id} disabled={disabled} onLeave={onLeave} onBusyChange={onBusyChange} />}
        {eventId && link(`/orders?source=chipply&store=${encodeURIComponent(eventId)}`, "link-report", `Open Chipply report for event ${eventId}`)}
      </div>;
    }
  }
}
