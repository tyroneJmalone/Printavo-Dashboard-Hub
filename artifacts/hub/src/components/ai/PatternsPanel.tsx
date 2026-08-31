import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetDraftPatternSummary,
  getGetDraftPatternSummaryQueryKey,
  useListDraftPatternEvents,
  getListDraftPatternEventsQueryKey,
  useReviewDraftPatternEvent,
  useGetMissiveWebhookSettings,
  getGetMissiveWebhookSettingsQueryKey,
  useRotateMissiveWebhookSecret,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { ChevronDown, ChevronRight, Copy, Webhook, Timer } from "lucide-react";

/**
 * Drafting-pattern comparison (Task #52): Pattern A = Missive assistant →
 * MCP tools; Pattern B = webhook → context note → Missive AI Rule draft;
 * Pattern C = Hub voice-matched draft. Pattern B's pre-agreed pass
 * criteria: note lands before the rule's draft in ≥95% of conversations
 * AND drafts demonstrably use note content.
 */

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-[#0f172a] border border-slate-800 rounded-xl p-4 ${className}`}>{children}</div>;
}

const btnGhost =
  "text-xs px-2.5 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-50";

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

export function PatternsPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const summaryParams = { sinceDays: 30 };
  const { data: summary } = useGetDraftPatternSummary(summaryParams, {
    query: { refetchInterval: 30000, queryKey: getGetDraftPatternSummaryQueryKey(summaryParams) },
  });
  const eventParams = { limit: 100 };
  const { data: events } = useListDraftPatternEvents(eventParams, {
    query: { refetchInterval: 30000, queryKey: getListDraftPatternEventsQueryKey(eventParams) },
  });
  const { data: webhooks } = useGetMissiveWebhookSettings({
    query: { queryKey: getGetMissiveWebhookSettingsQueryKey() },
  });
  const rotate = useRotateMissiveWebhookSecret({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetMissiveWebhookSettingsQueryKey() });
        setShowSecret(true);
        toast({
          title: "Webhook secret rotated",
          description: "Paste the new secret into BOTH Missive webhook rules or they will be rejected.",
        });
      },
    },
  });
  const review = useReviewDraftPatternEvent({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListDraftPatternEventsQueryKey(), exact: false });
        qc.invalidateQueries({ queryKey: getGetDraftPatternSummaryQueryKey(), exact: false });
      },
    },
  });

  const copy = (text: string, label: string) =>
    navigator.clipboard.writeText(text).then(() => toast({ title: `${label} copied` }));

  const b = summary?.patternB;
  const orderingPct = b ? pct(b.orderingHeld, b.orderingKnown) : "—";
  const passCriteria =
    b && b.orderingKnown > 0 ? (b.orderingHeld / b.orderingKnown >= 0.95 ? "PASSING" : "FAILING") : "no data yet";

  return (
    <>
      <Card>
        <div className="flex items-center gap-2 mb-2">
          <Webhook size={14} className="text-[#10b981]" />
          <div className="text-sm font-semibold text-white">Missive webhooks (Patterns B & C)</div>
          <div className="flex-1" />
          <button
            className={btnGhost}
            disabled={rotate.isPending}
            onClick={() => {
              if (
                webhooks?.configured &&
                !confirm("Rotate the webhook secret? Both Missive rules must be updated with the new value.")
              )
                return;
              rotate.mutate();
            }}
          >
            {webhooks?.configured ? "Rotate secret" : "Generate secret"}
          </button>
        </div>
        <div className="text-xs text-slate-500 mb-2.5">
          In Missive: Settings → Rules → add a rule on incoming email with a <b>Webhook</b> action pointing at one of
          these URLs, and paste the signature secret into the action's “Signature secret” field. Pattern B pairs its
          webhook with an “Add AI note / Create draft with AI” rule; Pattern C needs only the webhook — the Hub creates
          the voice-matched draft itself.
        </div>
        <div className="space-y-1.5">
          {[
            ["Pattern B (context note)", webhooks?.contextNoteUrl ?? ""],
            ["Pattern C (voice draft)", webhooks?.voiceDraftUrl ?? ""],
          ].map(([label, url]) => (
            <div key={label} className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400 w-44 shrink-0">{label}</span>
              <code className="flex-1 text-[11px] bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-300 truncate">
                {url}
              </code>
              <button className={btnGhost} onClick={() => copy(url, label)}>
                <Copy size={11} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400 w-44 shrink-0">Signature secret</span>
            <code className="flex-1 text-[11px] bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-300 truncate">
              {webhooks?.configured ? (showSecret ? webhooks.secret : "••••••••••••••••") : "not configured yet"}
            </code>
            {webhooks?.configured && (
              <>
                <button className={btnGhost} onClick={() => setShowSecret((s) => !s)}>
                  {showSecret ? "Hide" : "Show"}
                </button>
                <button className={btnGhost} onClick={() => copy(webhooks.secret ?? "", "Secret")}>
                  <Copy size={11} />
                </button>
              </>
            )}
          </div>
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-2 mb-2.5">
          <Timer size={14} className="text-[#10b981]" />
          <div className="text-sm font-semibold text-white">Drafting patterns — last 30 days</div>
          <div className="flex-1" />
          <span
            className={`text-[11px] px-2 py-0.5 rounded-full border ${
              passCriteria === "PASSING"
                ? "bg-[#059669]/15 border-[#059669]/40 text-[#10b981]"
                : passCriteria === "FAILING"
                  ? "bg-red-500/10 border-red-500/30 text-red-300"
                  : "bg-slate-800 border-slate-700 text-slate-400"
            }`}
          >
            Pattern B ordering: {orderingPct} (≥95% required) — {passCriteria}
          </span>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-3">
          <StatBlock
            title="A — Missive assistant → MCP"
            rows={[
              ["Tool calls", String(summary?.patternA.calls ?? 0)],
              ["Scored", String(summary?.patternA.scored ?? 0)],
              ["Facts correct", pct(summary?.patternA.correct ?? 0, summary?.patternA.scored ?? 0)],
              ["Used / accepted", String(summary?.patternA.usedOrAccepted ?? 0)],
              ["Edited", String(summary?.patternA.edited ?? 0)],
              ["Rejected / ignored", String(summary?.patternA.rejectedOrIgnored ?? 0)],
            ]}
          />
          <StatBlock
            title="B — note → Missive AI Rule"
            rows={[
              ["Webhook events", String(b?.events ?? 0)],
              ["Notes posted", String(b?.notesPosted ?? 0)],
              ["Avg note latency", b ? `${((b.avgNoteLatencyMs ?? 0) / 1000).toFixed(1)}s` : "—"],
              ["Note before draft", `${b?.orderingHeld ?? 0}/${b?.orderingKnown ?? 0} (${orderingPct})`],
              ["Draft used note", `${b?.draftUsedNoteYes ?? 0}/${b?.draftUsedNoteScored ?? 0} scored`],
              ["Errors", String(b?.errors ?? 0)],
            ]}
          />
          <StatBlock
            title="C — Hub voice-matched draft"
            rows={[
              ["Webhook events", String(summary?.patternC.events ?? 0)],
              ["Drafts created", String(summary?.patternC.draftsCreated ?? 0)],
              ["Scored", String(summary?.patternC.scored ?? 0)],
              ["Facts correct", pct(summary?.patternC.correct ?? 0, summary?.patternC.scored ?? 0)],
              ["Accepted vs edited", `${summary?.patternC.usedOrAccepted ?? 0} / ${summary?.patternC.edited ?? 0}`],
              ["Errors", String(summary?.patternC.errors ?? 0)],
            ]}
          />
        </div>
        <div className="text-[11px] text-slate-500 mt-2">
          Pattern A/C accuracy and outcomes are scored per call in the audit log below (Pattern C events use the
          “voice_draft” tool). Pattern B ordering is measured automatically; “draft used note” needs the human
          spot-check on each event here.
        </div>
      </Card>

      <Card>
        <div className="text-sm font-semibold text-white mb-2">Pattern B/C events</div>
        {!events?.length && <div className="text-xs text-slate-500">No webhook events yet.</div>}
        <div className="space-y-1.5">
          {(events ?? []).map((e) => {
            const open = expanded === e.id;
            return (
              <div key={e.id} className="border border-slate-800 rounded-lg">
                <button
                  className="w-full flex items-center gap-2 px-2.5 py-2 text-left"
                  onClick={() => setExpanded(open ? null : e.id)}
                >
                  {open ? (
                    <ChevronDown size={12} className="text-slate-500 shrink-0" />
                  ) : (
                    <ChevronRight size={12} className="text-slate-500 shrink-0" />
                  )}
                  <span
                    className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      e.pattern === "B" ? "bg-sky-500/15 text-sky-300" : "bg-purple-500/15 text-purple-300"
                    }`}
                  >
                    {e.pattern}
                  </span>
                  <span className="text-xs text-slate-200 truncate flex-1">
                    {e.conversationSubject || "(no subject)"}
                    <span className="text-slate-500"> — {e.counterpartEmail || "unknown sender"}</span>
                  </span>
                  {e.status === "error" ? (
                    <span className="text-[10px] text-red-300">error</span>
                  ) : e.pattern === "B" ? (
                    <span className="text-[10px] text-slate-400">
                      {e.noteLatencyMs != null ? `note ${(e.noteLatencyMs / 1000).toFixed(1)}s` : "…"}
                      {e.noteBeforeDraft === true ? " · note first ✓" : e.noteBeforeDraft === false ? " · DRAFT FIRST ✗" : ""}
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-400">{e.hubDraftCreatedAt ? "draft ✓" : "…"}</span>
                  )}
                  <span className="text-[10px] text-slate-500">{new Date(e.receivedAt).toLocaleString()}</span>
                </button>
                {open && (
                  <div className="px-3 pb-2.5 space-y-2 border-t border-slate-800 pt-2">
                    {e.error && <div className="text-xs text-red-300">{e.error}</div>}
                    <div className="text-[11px] text-slate-400">
                      Customer: {e.customerName || "no match"} · Status: {e.status}
                      {e.ruleDraftCreatedAt &&
                        ` · rule draft ${new Date(e.ruleDraftCreatedAt).toLocaleTimeString()}`}
                      {e.reviewedByEmail && ` · reviewed by ${e.reviewedByEmail}`}
                    </div>
                    {e.noteBody && (
                      <pre className="text-[11px] bg-slate-900 border border-slate-800 rounded-md p-2 whitespace-pre-wrap text-slate-300 max-h-48 overflow-auto">
                        {e.noteBody}
                      </pre>
                    )}
                    {e.pattern === "B" && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] text-slate-500">Note before draft:</span>
                        {[true, false].map((v) => (
                          <button
                            key={String(v)}
                            className={`${btnGhost} ${e.noteBeforeDraft === v ? "border-[#059669] text-[#10b981]" : ""}`}
                            onClick={() => review.mutate({ id: e.id, data: { noteBeforeDraft: v } })}
                          >
                            {v ? "Yes" : "No"}
                          </button>
                        ))}
                        <span className="text-[11px] text-slate-500 ml-2">Draft used note content:</span>
                        {[true, false].map((v) => (
                          <button
                            key={String(v)}
                            className={`${btnGhost} ${e.draftUsedNote === v ? "border-[#059669] text-[#10b981]" : ""}`}
                            onClick={() => review.mutate({ id: e.id, data: { draftUsedNote: v } })}
                          >
                            {v ? "Yes" : "No"}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}
