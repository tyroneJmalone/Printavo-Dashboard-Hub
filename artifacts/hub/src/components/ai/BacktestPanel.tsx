import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDraftBacktestRuns,
  getListDraftBacktestRunsQueryKey,
  useStartDraftBacktestRun,
  useListDraftBacktestItems,
  getListDraftBacktestItemsQueryKey,
  useReviewDraftBacktestItem,
  type DraftBacktestItemRecord,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight, FlaskConical } from "lucide-react";

/**
 * Offline drafting backtest (Task #61): dry-runs the Pattern C pipeline over
 * historical emails the team ALREADY answered, so drafts can be judged
 * side-by-side against the reply that was actually sent — before go-live,
 * with zero Missive writes.
 *
 * Each item shows the customer's email, the real reply, a voice-matched
 * draft, and a generic (no voice profile) baseline draft. Human review
 * scores facts, voice fidelity, and would-use — the same axes as the live
 * trial. What it can't measure: Pattern B's live note-vs-draft ordering
 * race and real accepted/edited behavior.
 */

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-[#0f172a] border border-slate-800 rounded-xl p-4 ${className}`}>{children}</div>;
}

const btnGhost =
  "text-xs px-2.5 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-50";
const btnPrimary =
  "text-xs font-medium px-3 py-1.5 rounded-md bg-[#059669] hover:bg-[#047857] text-white disabled:opacity-50 disabled:cursor-not-allowed";

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
}

function StatBlock({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="bg-slate-900/60 border border-slate-800 rounded-lg p-3">
      <div className="text-xs font-semibold text-slate-200 mb-2">{title}</div>
      <div className="space-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between text-[11px]">
            <span className="text-slate-500">{k}</span>
            <span className="text-slate-200 font-medium">{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const FACT_OPTIONS = [
  { value: "correct", label: "Correct" },
  { value: "wrong_fact", label: "Wrong fact" },
  { value: "wrong_customer", label: "Wrong customer" },
  { value: "missing_data", label: "Missing data" },
] as const;

const VOICE_OPTIONS = [
  { value: "voice", label: "Voice draft" },
  { value: "generic", label: "Generic draft" },
  { value: "both", label: "Both" },
  { value: "neither", label: "Neither" },
] as const;

const WOULD_USE_OPTIONS = [
  { value: "as_is", label: "As-is" },
  { value: "with_edits", label: "With edits" },
  { value: "no", label: "No" },
] as const;

function TextBlock({ label, text, accent }: { label: string; text: string; accent?: string }) {
  return (
    <div className="min-w-0">
      <div className={`text-[10px] font-semibold uppercase tracking-wide mb-1 ${accent ?? "text-slate-500"}`}>
        {label}
      </div>
      <pre className="text-[11px] bg-slate-900 border border-slate-800 rounded-md p-2 whitespace-pre-wrap text-slate-300 max-h-56 overflow-auto">
        {text || "(empty)"}
      </pre>
    </div>
  );
}

export function BacktestPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [sampleSize, setSampleSize] = useState(10);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [mailboxFilter, setMailboxFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: runs } = useListDraftBacktestRuns(
    { limit: 20 },
    { query: { refetchInterval: 15000, queryKey: getListDraftBacktestRunsQueryKey({ limit: 20 }) } },
  );
  const run = (runs ?? []).find((r) => r.id === selectedRunId) ?? runs?.[0] ?? null;
  const running = run?.status === "running";

  const { data: items } = useListDraftBacktestItems(run?.id ?? "", {
    query: {
      enabled: Boolean(run?.id),
      refetchInterval: running ? 10000 : false,
      queryKey: getListDraftBacktestItemsQueryKey(run?.id ?? ""),
    },
  });

  const start = useStartDraftBacktestRun({
    mutation: {
      onSuccess: (created) => {
        setSelectedRunId(created.id);
        qc.invalidateQueries({ queryKey: getListDraftBacktestRunsQueryKey(), exact: false });
        toast({
          title: "Backtest started",
          description: `${created.itemsTotal} historical emails queued — drafts generate in the background.`,
        });
      },
      onError: (err: any) =>
        toast({ title: "Couldn't start backtest", description: err?.error ?? String(err), variant: "destructive" }),
    },
  });
  const review = useReviewDraftBacktestItem({
    mutation: {
      onSuccess: () => {
        if (run?.id) qc.invalidateQueries({ queryKey: getListDraftBacktestItemsQueryKey(run.id) });
      },
    },
  });

  const generated = useMemo(() => (items ?? []).filter((i) => i.status === "generated"), [items]);
  const stats = useMemo(() => {
    const factScored = generated.filter((i) => i.factAccuracy);
    const voiceScored = generated.filter((i) => i.voiceVerdict);
    const useScored = generated.filter((i) => i.wouldUse);
    const count = (list: DraftBacktestItemRecord[], field: "factAccuracy" | "voiceVerdict" | "wouldUse", v: string) =>
      list.filter((i) => i[field] === v).length;
    return {
      factScored: factScored.length,
      factCorrect: count(factScored, "factAccuracy", "correct"),
      wrongFact: count(factScored, "factAccuracy", "wrong_fact"),
      wrongCustomer: count(factScored, "factAccuracy", "wrong_customer"),
      missingData: count(factScored, "factAccuracy", "missing_data"),
      voiceScored: voiceScored.length,
      voiceWins: count(voiceScored, "voiceVerdict", "voice"),
      genericWins: count(voiceScored, "voiceVerdict", "generic"),
      both: count(voiceScored, "voiceVerdict", "both"),
      neither: count(voiceScored, "voiceVerdict", "neither"),
      useScored: useScored.length,
      asIs: count(useScored, "wouldUse", "as_is"),
      withEdits: count(useScored, "wouldUse", "with_edits"),
      no: count(useScored, "wouldUse", "no"),
    };
  }, [generated]);

  const mailboxes = useMemo(
    () => Array.from(new Set((items ?? []).map((i) => i.mailboxEmail))).sort(),
    [items],
  );
  const visible = (items ?? []).filter((i) => mailboxFilter === "all" || i.mailboxEmail === mailboxFilter);

  return (
    <>
      <Card>
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <FlaskConical size={14} className="text-[#10b981]" />
          <div className="text-sm font-semibold text-white">Drafting backtest — history vs. real replies</div>
          <div className="flex-1" />
          <label className="text-[11px] text-slate-500">
            Emails per mailbox{" "}
            <select
              className="bg-[#1e293b] border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-100 ml-1"
              value={sampleSize}
              onChange={(e) => setSampleSize(Number(e.target.value))}
            >
              {[5, 10, 15, 25].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            className={btnPrimary}
            disabled={start.isPending || running}
            onClick={() => start.mutate({ data: { samplePerMailbox: sampleSize } })}
          >
            {running ? "Run in progress…" : "Start backtest"}
          </button>
        </div>
        <div className="text-xs text-slate-500 mb-2.5">
          Dry-runs the voice-drafting pipeline over past customer emails the team already answered — no drafts are
          created in Missive. Each item pairs the AI's voice-matched draft (and a generic baseline) with the reply the
          teammate actually sent, so facts and voice can be judged against reality. The live-week measurements
          (Pattern B note-before-draft ordering, real accepted/edited rates) are out of scope here.
        </div>
        {runs && runs.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <select
              className="bg-[#1e293b] border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-100"
              value={run?.id ?? ""}
              onChange={(e) => setSelectedRunId(e.target.value)}
            >
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {new Date(r.startedAt).toLocaleString()} — {r.samplePerMailbox}/mailbox — {r.status}
                </option>
              ))}
            </select>
            {run && (
              <span className="text-[11px] text-slate-400">
                {run.itemsDone}/{run.itemsTotal} generated
                {run.itemsFailed > 0 && <span className="text-red-300"> · {run.itemsFailed} failed</span>}
                {run.status === "error" && run.error && <span className="text-red-300"> · {run.error}</span>}
              </span>
            )}
            {run && run.skippedMailboxes.length > 0 && (
              <span className="text-[11px] text-amber-300/80">skipped: {run.skippedMailboxes.join("; ")}</span>
            )}
          </div>
        )}
        {(!runs || runs.length === 0) && (
          <div className="text-xs text-slate-500">
            No backtest runs yet. Voice profiles must be ready first (Voice Profiles page).
          </div>
        )}
      </Card>

      {run && generated.length > 0 && (
        <Card>
          <div className="text-sm font-semibold text-white mb-2.5">Backtest results — human-scored</div>
          <div className="grid gap-2.5 sm:grid-cols-3">
            <StatBlock
              title="Fact accuracy"
              rows={[
                ["Scored", `${stats.factScored}/${generated.length}`],
                ["Correct", `${stats.factCorrect} (${pct(stats.factCorrect, stats.factScored)})`],
                ["Wrong fact", String(stats.wrongFact)],
                ["Wrong customer", String(stats.wrongCustomer)],
                ["Missing data", String(stats.missingData)],
              ]}
            />
            <StatBlock
              title="Sounds like the teammate"
              rows={[
                ["Scored", `${stats.voiceScored}/${generated.length}`],
                ["Voice draft wins", `${stats.voiceWins} (${pct(stats.voiceWins, stats.voiceScored)})`],
                ["Generic wins", String(stats.genericWins)],
                ["Both close", String(stats.both)],
                ["Neither", String(stats.neither)],
              ]}
            />
            <StatBlock
              title="Would the owner use it?"
              rows={[
                ["Scored", `${stats.useScored}/${generated.length}`],
                ["As-is", `${stats.asIs} (${pct(stats.asIs, stats.useScored)})`],
                ["With edits", String(stats.withEdits)],
                ["No", String(stats.no)],
                ["Usable overall", pct(stats.asIs + stats.withEdits, stats.useScored)],
              ]}
            />
          </div>
        </Card>
      )}

      {run && (
        <Card>
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <div className="text-sm font-semibold text-white">Backtest items</div>
            <div className="flex-1" />
            <select
              className="bg-[#1e293b] border border-slate-700 rounded-md px-2 py-1 text-xs text-slate-100"
              value={mailboxFilter}
              onChange={(e) => setMailboxFilter(e.target.value)}
            >
              <option value="all">All mailboxes</option>
              {mailboxes.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          {!visible.length && <div className="text-xs text-slate-500">No items yet.</div>}
          <div className="space-y-1.5">
            {visible.map((item) => {
              const open = expanded === item.id;
              const scored = Boolean(item.factAccuracy && item.voiceVerdict && item.wouldUse);
              return (
                <div key={item.id} className="border border-slate-800 rounded-lg">
                  <button
                    className="w-full flex items-center gap-2 px-2.5 py-2 text-left"
                    onClick={() => setExpanded(open ? null : item.id)}
                  >
                    {open ? (
                      <ChevronDown size={12} className="text-slate-500 shrink-0" />
                    ) : (
                      <ChevronRight size={12} className="text-slate-500 shrink-0" />
                    )}
                    <span className="text-[10px] text-slate-400 shrink-0 w-16 truncate">
                      {item.mailboxEmail.split("@")[0]}
                    </span>
                    <span className="text-xs text-slate-200 truncate flex-1">
                      {item.subject || "(no subject)"}
                      <span className="text-slate-500"> — {item.counterpartEmail}</span>
                    </span>
                    {item.status === "error" ? (
                      <span className="text-[10px] text-red-300">error</span>
                    ) : item.status === "pending" ? (
                      <span className="text-[10px] text-slate-500">generating…</span>
                    ) : scored ? (
                      <span className="text-[10px] text-[#10b981]">scored ✓</span>
                    ) : (
                      <span className="text-[10px] text-amber-300/80">needs review</span>
                    )}
                    <span className="text-[10px] text-slate-500 shrink-0">
                      {new Date(item.inboundAt).toLocaleDateString()}
                    </span>
                  </button>
                  {open && (
                    <div className="px-3 pb-3 space-y-2.5 border-t border-slate-800 pt-2">
                      {item.error && <div className="text-xs text-red-300">{item.error}</div>}
                      <div className="text-[11px] text-slate-400">
                        Customer match: {item.customerName || "none"}
                        {item.reviewedByEmail && ` · reviewed by ${item.reviewedByEmail}`}
                      </div>
                      <div className="grid gap-2.5 md:grid-cols-2">
                        <TextBlock label="Customer's email" text={item.inboundText} />
                        <TextBlock label="Real reply (what was actually sent)" text={item.replyText} accent="text-[#10b981]" />
                      </div>
                      {item.status === "generated" && (
                        <>
                          <div className="grid gap-2.5 md:grid-cols-2">
                            <TextBlock label="AI voice-matched draft" text={item.voiceDraftBody} accent="text-purple-300" />
                            <TextBlock label="AI generic draft (baseline)" text={item.genericDraftBody} accent="text-sky-300" />
                          </div>
                          {item.factsMarkdown && (
                            <details>
                              <summary className="text-[11px] text-slate-500 cursor-pointer">
                                Context facts the AI was given
                              </summary>
                              <pre className="text-[11px] bg-slate-900 border border-slate-800 rounded-md p-2 whitespace-pre-wrap text-slate-400 max-h-40 overflow-auto mt-1">
                                {item.factsMarkdown}
                              </pre>
                            </details>
                          )}
                          <div className="space-y-1.5">
                            {[
                              { label: "Facts in the voice draft", field: "factAccuracy" as const, options: FACT_OPTIONS },
                              { label: "Reads more like the real reply", field: "voiceVerdict" as const, options: VOICE_OPTIONS },
                              { label: "Would the owner use the voice draft", field: "wouldUse" as const, options: WOULD_USE_OPTIONS },
                            ].map(({ label, field, options }) => (
                              <div key={field} className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-[11px] text-slate-500 w-56 shrink-0">{label}:</span>
                                {options.map((o) => (
                                  <button
                                    key={o.value}
                                    className={`${btnGhost} ${item[field] === o.value ? "border-[#059669] text-[#10b981]" : ""}`}
                                    onClick={() => review.mutate({ id: item.id, data: { [field]: o.value } })}
                                  >
                                    {o.label}
                                  </button>
                                ))}
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </>
  );
}
