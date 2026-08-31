import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAiConsumers,
  getListAiConsumersQueryKey,
  useCreateAiConsumer,
  useUpdateAiConsumer,
  useRevokeAiConsumer,
  useListAiAuditEvents,
  getListAiAuditEventsQueryKey,
  useReviewAiAuditEvent,
  useGetAiContextSettings,
  getGetAiContextSettingsQueryKey,
  useUpdateAiContextSettings,
} from "@workspace/api-client-react";
import { useStaff } from "@/components/auth/StaffGate";
import { AppShell } from "@/components/layout/AppShell";
import { PatternsPanel } from "@/components/ai/PatternsPanel";
import { BacktestPanel } from "@/components/ai/BacktestPanel";
import { useToast } from "@/hooks/use-toast";
import {
  Bot,
  Plus,
  Power,
  ShieldOff,
  Copy,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

/**
 * Admin control panel for the AI context layer: the kill switch, consumer
 * tokens (one per connected platform — Missive, chatbots, Zapier…), and
 * the audit log with fact-accuracy scoring. Scoring feeds the Task #44
 * success criteria: we measure whether the AI's answers used correct
 * company facts, not just whether calls succeeded.
 */

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-[#0f172a] border border-slate-800 rounded-xl p-4 ${className}`}>{children}</div>;
}

const inputCls =
  "bg-[#1e293b] border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#059669]";
const btnCls =
  "text-xs font-medium px-3 py-1.5 rounded-md bg-[#059669] hover:bg-[#047857] text-white disabled:opacity-50 disabled:cursor-not-allowed";
const btnGhost =
  "text-xs px-2.5 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-50";

const ACCURACY_OPTIONS = [
  { value: "correct", label: "Correct" },
  { value: "wrong_fact", label: "Wrong fact" },
  { value: "wrong_customer", label: "Wrong customer" },
  { value: "missing_data", label: "Missing data" },
] as const;

const OUTCOME_OPTIONS = [
  { value: "used", label: "Used as-is" },
  { value: "accepted", label: "Accepted" },
  { value: "edited", label: "Edited first" },
  { value: "rejected", label: "Rejected" },
  { value: "ignored", label: "Ignored" },
] as const;

export default function AiContext() {
  const { role } = useStaff();
  const isAdmin = role === "admin";
  const qc = useQueryClient();
  const { toast } = useToast();

  const [newName, setNewName] = useState("");
  const [newPlatform, setNewPlatform] = useState("");
  const [mintedToken, setMintedToken] = useState<{ name: string; token: string } | null>(null);
  const [expandedEvent, setExpandedEvent] = useState<string | null>(null);

  const { data: settings } = useGetAiContextSettings({
    query: { enabled: isAdmin, queryKey: getGetAiContextSettingsQueryKey() },
  });
  const { data: consumers } = useListAiConsumers({
    query: { enabled: isAdmin, queryKey: getListAiConsumersQueryKey() },
  });
  const auditParams = { limit: 100 };
  const { data: auditEvents } = useListAiAuditEvents(auditParams, {
    query: {
      enabled: isAdmin,
      refetchInterval: 30000,
      queryKey: getListAiAuditEventsQueryKey(auditParams),
    },
  });

  const invalidateConsumers = () => qc.invalidateQueries({ queryKey: getListAiConsumersQueryKey() });
  const invalidateAudit = () =>
    qc.invalidateQueries({ queryKey: getListAiAuditEventsQueryKey(), exact: false });

  const updateSettings = useUpdateAiContextSettings({
    mutation: {
      onSuccess: (next) => {
        qc.invalidateQueries({ queryKey: getGetAiContextSettingsQueryKey() });
        toast({
          title: next.contextLayerEnabled ? "AI context layer enabled" : "AI context layer disabled",
          description: next.contextLayerEnabled
            ? "Connected platforms can call tools again."
            : "Every tool call from every platform now fails fast.",
        });
      },
    },
  });
  const createConsumer = useCreateAiConsumer({
    mutation: {
      onSuccess: (data) => {
        setNewName("");
        setNewPlatform("");
        setMintedToken({ name: data.consumer.name, token: data.token });
        invalidateConsumers();
      },
      onError: (err: any) =>
        toast({ title: "Couldn't create consumer", description: err?.error ?? String(err), variant: "destructive" }),
    },
  });
  const updateConsumer = useUpdateAiConsumer({ mutation: { onSuccess: invalidateConsumers } });
  const revokeConsumer = useRevokeAiConsumer({
    mutation: {
      onSuccess: () => {
        invalidateConsumers();
        toast({ title: "Token revoked", description: "That platform can no longer reach the context layer." });
      },
    },
  });
  const reviewEvent = useReviewAiAuditEvent({
    mutation: {
      onSuccess: () => {
        invalidateAudit();
      },
    },
  });

  if (!isAdmin) {
    return (
      <AppShell>
        <div className="p-6 max-w-lg">
          <Card>
            <div className="text-sm text-slate-300">AI Connections are admin-only.</div>
          </Card>
        </div>
      </AppShell>
    );
  }

  const enabled = settings?.contextLayerEnabled ?? true;
  const scored = auditEvents?.filter((e) => e.accuracy) ?? [];
  const correctCount = scored.filter((e) => e.accuracy === "correct").length;

  return (
    <AppShell>
      <div className="p-4 lg:p-6 space-y-4 max-w-5xl">
        <div className="flex items-center gap-3">
          <Bot size={18} className="text-[#10b981]" />
          <h1 className="text-lg font-semibold text-white">AI Connections</h1>
          <div className="flex-1" />
          <button
            className={`text-xs font-medium px-3 py-1.5 rounded-md flex items-center gap-1.5 ${
              enabled
                ? "bg-red-500/10 border border-red-500/30 text-red-300 hover:bg-red-500/20"
                : "bg-[#059669] hover:bg-[#047857] text-white"
            }`}
            disabled={updateSettings.isPending || !settings}
            onClick={() => {
              const next = !enabled;
              if (!next && !confirm("Disable the AI context layer? Every connected platform loses access immediately."))
                return;
              updateSettings.mutate({ data: { contextLayerEnabled: next } });
            }}
          >
            <Power size={12} />
            {enabled ? "Disable everything" : "Re-enable"}
          </button>
        </div>
        <div className="text-xs text-slate-500 -mt-2">
          Platforms connected here (Missive, chatbots, Zapier…) can look up customers, orders, and company knowledge —
          and create quote <i>drafts</i> for human review. They can never write to Printavo or read email.
          {!enabled && <span className="text-red-400 font-semibold"> The layer is currently DISABLED.</span>}
        </div>

        {mintedToken && (
          <Card className="border-[#059669]/40">
            <div className="text-sm font-semibold text-[#10b981] mb-1.5">
              Token for “{mintedToken.name}” — copy it now
            </div>
            <div className="text-xs text-slate-400 mb-2">
              This is the only time it will be shown. Paste it into the platform's Authorization header as{" "}
              <code className="bg-slate-800 px-1 rounded">Bearer &lt;token&gt;</code>.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-slate-900 border border-slate-700 rounded px-2.5 py-2 text-slate-200 break-all select-all">
                {mintedToken.token}
              </code>
              <button
                className={btnGhost}
                onClick={() => {
                  navigator.clipboard.writeText(mintedToken.token).then(
                    () => toast({ title: "Token copied" }),
                    () => toast({ title: "Copy failed — select and copy manually", variant: "destructive" }),
                  );
                }}
              >
                <Copy size={12} />
              </button>
              <button className={btnGhost} onClick={() => setMintedToken(null)}>
                Done
              </button>
            </div>
          </Card>
        )}

        {/* Consumers */}
        <Card>
          <div className="text-sm font-semibold text-slate-200 mb-3">Connected platforms</div>
          <div className="space-y-2">
            {consumers?.map((c) => (
              <div key={c.id} className="border border-slate-800 rounded-lg px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  {c.active ? (
                    <CheckCircle2 size={14} className="text-[#10b981] flex-shrink-0" />
                  ) : (
                    <XCircle size={14} className="text-red-400 flex-shrink-0" />
                  )}
                  <span className="text-sm text-slate-200 font-medium">{c.name}</span>
                  {c.platform && (
                    <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">{c.platform}</span>
                  )}
                  <code className="text-[10px] text-slate-500">{c.tokenPrefix}…</code>
                  {c.revokedAt && (
                    <span className="text-[10px] uppercase tracking-wide bg-red-500/10 text-red-400 px-1.5 py-0.5 rounded">
                      revoked
                    </span>
                  )}
                  <div className="flex-1" />
                  {!c.revokedAt && (
                    <>
                      <button
                        className={btnGhost}
                        disabled={updateConsumer.isPending}
                        onClick={() => updateConsumer.mutate({ id: c.id, data: { active: !c.active } })}
                      >
                        {c.active ? "Pause" : "Resume"}
                      </button>
                      <button
                        className="text-xs px-2.5 py-1.5 rounded-md border border-red-500/30 text-red-300 hover:bg-red-500/10"
                        disabled={revokeConsumer.isPending}
                        onClick={() => {
                          if (confirm(`Permanently revoke the token for "${c.name}"? This cannot be undone — you'd mint a new token instead.`))
                            revokeConsumer.mutate({ id: c.id });
                        }}
                      >
                        <span className="flex items-center gap-1">
                          <ShieldOff size={12} /> Revoke
                        </span>
                      </button>
                    </>
                  )}
                </div>
                <div className="text-[11px] text-slate-500 mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
                  <span>tier: {c.tier}</span>
                  <span>scopes: {c.scopes.join(", ")}</span>
                  <span>{c.rateLimitPerMin}/min</span>
                  <span>last used: {c.lastUsedAt ? new Date(c.lastUsedAt).toLocaleString() : "never"}</span>
                </div>
              </div>
            ))}
            {consumers && consumers.length === 0 && (
              <div className="text-sm text-slate-500">No platforms connected yet — add the first one below.</div>
            )}
          </div>
          <form
            className="flex flex-wrap gap-2 mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim().length >= 2)
                createConsumer.mutate({
                  data: { name: newName.trim(), platform: newPlatform.trim() || undefined },
                });
            }}
          >
            <input
              className={`${inputCls} flex-1 min-w-[200px]`}
              placeholder="Name — e.g. Missive"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <input
              className={`${inputCls} w-40`}
              placeholder="Platform (optional)"
              value={newPlatform}
              onChange={(e) => setNewPlatform(e.target.value)}
            />
            <button type="submit" className={btnCls} disabled={createConsumer.isPending || newName.trim().length < 2}>
              <span className="flex items-center gap-1.5">
                <Plus size={13} /> Create token
              </span>
            </button>
          </form>
        </Card>

        {/* Audit log */}
        <Card>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-sm font-semibold text-slate-200">Activity &amp; accuracy</span>
            <div className="flex-1" />
            {scored.length > 0 && (
              <span className="text-[11px] text-slate-400">
                {correctCount}/{scored.length} scored calls correct (
                {Math.round((correctCount / scored.length) * 100)}%)
              </span>
            )}
          </div>
          <div className="text-xs text-slate-500 mb-3">
            Every tool call from every platform lands here. Score a call's accuracy when you review what the AI did with
            it — that's how we know the context layer is helping, not just running.
          </div>
          <div className="space-y-1.5">
            {auditEvents?.map((e) => {
              const isOpen = expandedEvent === e.id;
              return (
                <div key={e.id} className="border border-slate-800 rounded-lg">
                  <button
                    type="button"
                    className="w-full flex flex-wrap items-center gap-2 px-3 py-2 text-left"
                    onClick={() => setExpandedEvent(isOpen ? null : e.id)}
                  >
                    {isOpen ? (
                      <ChevronDown size={12} className="text-slate-500" />
                    ) : (
                      <ChevronRight size={12} className="text-slate-500" />
                    )}
                    {e.ok ? (
                      <CheckCircle2 size={13} className="text-[#10b981]" />
                    ) : (
                      <XCircle size={13} className="text-red-400" />
                    )}
                    <code className="text-xs text-slate-200">{e.tool}</code>
                    <span className="text-[10px] bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">{e.consumerName}</span>
                    {e.errorCode && <span className="text-[10px] text-red-400">{e.errorCode}</span>}
                    {e.accuracy && (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                          e.accuracy === "correct" ? "bg-[#059669]/15 text-[#10b981]" : "bg-amber-500/15 text-amber-300"
                        }`}
                      >
                        {ACCURACY_OPTIONS.find((o) => o.value === e.accuracy)?.label ?? e.accuracy}
                      </span>
                    )}
                    <div className="flex-1" />
                    <span className="text-[10px] text-slate-500">{e.latencyMs}ms</span>
                    <span className="text-[10px] text-slate-500">{new Date(e.createdAt).toLocaleString()}</span>
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 space-y-2 border-t border-slate-800 pt-2.5">
                      <div className="text-[11px] text-slate-400">
                        <span className="text-slate-500">input:</span>{" "}
                        <code className="bg-slate-900 px-1.5 py-0.5 rounded break-all">{e.input || "—"}</code>
                      </div>
                      <div className="text-[11px] text-slate-400">
                        <span className="text-slate-500">result:</span> {e.resultSummary || "—"}
                        {e.staffEmail && <span className="ml-3 text-slate-500">by {e.staffEmail}</span>}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          className={inputCls}
                          value={e.accuracy ?? ""}
                          onChange={(ev) =>
                            reviewEvent.mutate({
                              id: e.id,
                              data: { accuracy: (ev.target.value || null) as any },
                            })
                          }
                        >
                          <option value="">Score accuracy…</option>
                          {ACCURACY_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        <select
                          className={inputCls}
                          value={e.feedbackOutcome ?? ""}
                          onChange={(ev) =>
                            reviewEvent.mutate({
                              id: e.id,
                              data: { feedbackOutcome: (ev.target.value || null) as any },
                            })
                          }
                        >
                          <option value="">How was it used…</option>
                          {OUTCOME_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                        {e.reviewedByEmail && (
                          <span className="text-[10px] text-slate-500">
                            reviewed by {e.reviewedByEmail}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {auditEvents && auditEvents.length === 0 && (
              <div className="text-sm text-slate-500">No AI activity yet.</div>
            )}
          </div>
        </Card>

        <PatternsPanel />
        <BacktestPanel />
      </div>
    </AppShell>
  );
}
