import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetEmailActivityStatus,
  getGetEmailActivityStatusQueryKey,
  useAddEmailMailbox,
  useUpdateEmailMailbox,
  useRemoveEmailMailbox,
  useVerifyEmailMailbox,
  useTriggerEmailSync,
  useListEmailExclusions,
  getListEmailExclusionsQueryKey,
  useAddEmailExclusion,
  useRemoveEmailExclusion,
  useUpdateEmailActivitySettings,
} from "@workspace/api-client-react";
import { useStaff } from "@/components/auth/StaffGate";
import { AppShell } from "@/components/layout/AppShell";
import { useToast } from "@/hooks/use-toast";
import { Mail, RefreshCw, Trash2, CheckCircle2, XCircle, CircleDashed, ArrowLeft, ShieldBan, BookOpen } from "lucide-react";

/**
 * Email tracker setup: tracked mailboxes (with per-mailbox connectivity
 * status + verify), exclusion rules, thresholds, and the click-by-click
 * Google Admin console walkthrough for domain-wide delegation.
 */

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-[#0f172a] border border-slate-800 rounded-xl p-4 ${className}`}>{children}</div>;
}

const inputCls =
  "bg-[#1e293b] border border-slate-700 rounded-md px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#059669]";
const btnCls =
  "text-xs font-medium px-3 py-1.5 rounded-md bg-[#059669] hover:bg-[#047857] text-white disabled:opacity-50 disabled:cursor-not-allowed";
const btnGhost =
  "text-xs px-2.5 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800";

export default function EmailActivitySettings() {
  const { role } = useStaff();
  const isAdmin = role === "admin";
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: status, isLoading } = useGetEmailActivityStatus({
    query: { enabled: isAdmin, refetchInterval: 15000, queryKey: getGetEmailActivityStatusQueryKey() },
  });
  const { data: exclusions } = useListEmailExclusions({
    query: { enabled: isAdmin, queryKey: getListEmailExclusionsQueryKey() },
  });

  const invalidateStatus = () => qc.invalidateQueries({ queryKey: getGetEmailActivityStatusQueryKey() });
  const invalidateExclusions = () => qc.invalidateQueries({ queryKey: getListEmailExclusionsQueryKey() });

  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [verifyResults, setVerifyResults] = useState<Record<string, { ok: boolean; error: string | null; messagesTotal: number | null }>>({});
  const [exKind, setExKind] = useState<"address" | "domain">("domain");
  const [exValue, setExValue] = useState("");
  const [exNote, setExNote] = useState("");
  const [threshold, setThreshold] = useState<string>("");
  const [showGuide, setShowGuide] = useState(false);

  const addMailbox = useAddEmailMailbox({
    mutation: {
      onSuccess: () => {
        setNewEmail("");
        setNewName("");
        invalidateStatus();
        toast({ title: "Mailbox added", description: "It will backfill on the next sync tick." });
      },
      onError: (err: any) => toast({ title: "Couldn't add mailbox", description: err?.error ?? String(err), variant: "destructive" }),
    },
  });
  const updateMailbox = useUpdateEmailMailbox({ mutation: { onSuccess: invalidateStatus } });
  const removeMailbox = useRemoveEmailMailbox({
    mutation: {
      onSuccess: () => {
        invalidateStatus();
        toast({ title: "Mailbox removed", description: "Its synced metadata was deleted." });
      },
    },
  });
  const verifyMailbox = useVerifyEmailMailbox({
    mutation: {
      onSuccess: (data, vars) => setVerifyResults((prev) => ({ ...prev, [vars.id]: data })),
    },
  });
  const triggerSync = useTriggerEmailSync({
    mutation: {
      onSuccess: (data) => {
        invalidateStatus();
        toast({ title: data.ran ? "Sync started" : "Sync not started", description: data.message });
      },
    },
  });
  const addExclusion = useAddEmailExclusion({
    mutation: {
      onSuccess: () => {
        setExValue("");
        setExNote("");
        invalidateExclusions();
        invalidateStatus();
        toast({ title: "Rule added", description: "Applied retroactively to all synced mail." });
      },
      onError: (err: any) => toast({ title: "Couldn't add rule", description: err?.error ?? String(err), variant: "destructive" }),
    },
  });
  const removeExclusion = useRemoveEmailExclusion({
    mutation: {
      onSuccess: () => {
        invalidateExclusions();
        invalidateStatus();
        toast({ title: "Rule removed", description: "Mail was reclassified retroactively." });
      },
    },
  });
  const updateSettings = useUpdateEmailActivitySettings({
    mutation: {
      onSuccess: () => {
        invalidateStatus();
        setThreshold("");
        toast({ title: "Settings saved" });
      },
    },
  });

  if (!isAdmin) {
    return (
      <AppShell>
        <div className="p-6 max-w-lg">
          <Card>
            <div className="text-sm text-slate-300">Email Activity settings are admin-only.</div>
          </Card>
        </div>
      </AppShell>
    );
  }

  const saEmail = status?.serviceAccountEmail;

  return (
    <AppShell>
      <div className="p-4 lg:p-6 space-y-4 max-w-3xl">
        <div className="flex items-center gap-3">
          <Link href="/email-activity" className="text-slate-400 hover:text-slate-100">
            <ArrowLeft size={16} />
          </Link>
          <Mail size={18} className="text-[#10b981]" />
          <h1 className="text-lg font-semibold text-white">Email Tracker Setup</h1>
          <div className="flex-1" />
          <button
            className={btnGhost}
            onClick={() => triggerSync.mutate()}
            disabled={triggerSync.isPending || status?.syncActive}
          >
            <span className="flex items-center gap-1.5">
              <RefreshCw size={12} className={status?.syncActive ? "animate-spin" : ""} />
              {status?.syncActive ? "Syncing…" : "Sync now"}
            </span>
          </button>
        </div>

        {/* Credentials status */}
        <Card>
          <div className="flex items-center gap-2 mb-2">
            {status?.credentialsConfigured ? (
              <CheckCircle2 size={15} className="text-[#10b981]" />
            ) : (
              <XCircle size={15} className="text-amber-400" />
            )}
            <span className="text-sm font-semibold text-slate-200">Google Workspace connection</span>
          </div>
          {status?.credentialsConfigured ? (
            <div className="text-xs text-slate-400">
              Service account configured:{" "}
              <code className="text-slate-300 bg-slate-800 px-1.5 py-0.5 rounded">{saEmail}</code>
            </div>
          ) : (
            <div className="text-xs text-slate-400">
              Add the <code className="text-slate-300 bg-slate-800 px-1 rounded">GOOGLE_SERVICE_ACCOUNT_JSON</code>{" "}
              secret (the full service-account key JSON file contents) in Replit → Secrets, then restart the API server.
              The walkthrough below covers creating that key.
            </div>
          )}
          <button className="mt-3 flex items-center gap-1.5 text-xs text-[#10b981] hover:underline" onClick={() => setShowGuide((v) => !v)}>
            <BookOpen size={13} /> {showGuide ? "Hide" : "Show"} one-time Google setup walkthrough
          </button>
          {showGuide && (
            <ol className="mt-3 space-y-2.5 text-xs text-slate-300 list-decimal pl-5 leading-relaxed">
              <li>
                <b>Create a Google Cloud project</b> (or reuse one): go to{" "}
                <span className="text-slate-400">console.cloud.google.com</span> → project picker → <i>New Project</i> →
                name it e.g. “Hub Email Tracker”.
              </li>
              <li>
                <b>Enable the Gmail API</b>: in that project, <i>APIs &amp; Services → Library</i> → search “Gmail API” →{" "}
                <i>Enable</i>.
              </li>
              <li>
                <b>Create a service account</b>: <i>APIs &amp; Services → Credentials → Create Credentials → Service
                account</i>. Name it, skip the optional role screens, <i>Done</i>.
              </li>
              <li>
                <b>Create a JSON key</b>: open the service account → <i>Keys</i> tab → <i>Add key → Create new key →
                JSON</i>. A .json file downloads — paste its entire contents into the Replit secret{" "}
                <code className="bg-slate-800 px-1 rounded">GOOGLE_SERVICE_ACCOUNT_JSON</code>.
              </li>
              <li>
                <b>Copy the Client ID</b> (a long number) from the service account's <i>Details</i> page — you need it in
                the next step.
              </li>
              <li>
                <b>Grant domain-wide delegation</b> in the Google <b>Admin</b> console (admin.google.com, must be a
                Workspace super-admin): <i>Security → Access and data control → API controls → Domain-wide delegation →
                Add new</i>. Paste the Client ID, and for OAuth scopes enter exactly:{" "}
                <code className="bg-slate-800 px-1 rounded break-all">https://www.googleapis.com/auth/gmail.readonly</code>{" "}
                → <i>Authorize</i>.
              </li>
              <li>
                <b>Verify below</b>: add each mailbox, hit <i>Verify</i> — a green check means delegation works. Only
                message <i>metadata</i> (headers + subjects) is ever read, never bodies.
              </li>
            </ol>
          )}
        </Card>

        {/* Mailboxes */}
        <Card>
          <div className="text-sm font-semibold text-slate-200 mb-3">Tracked mailboxes</div>
          <div className="space-y-2">
            {isLoading && <div className="text-sm text-slate-500">Loading…</div>}
            {status?.mailboxes.map((m) => {
              const v = verifyResults[m.id];
              return (
                <div key={m.id} className="border border-slate-800 rounded-lg px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    {m.lastSyncStatus === "ok" ? (
                      <CheckCircle2 size={14} className="text-[#10b981] flex-shrink-0" />
                    ) : m.lastSyncStatus === "error" ? (
                      <XCircle size={14} className="text-red-400 flex-shrink-0" />
                    ) : (
                      <CircleDashed size={14} className="text-slate-500 flex-shrink-0" />
                    )}
                    <div className="min-w-0">
                      <span className="text-sm text-slate-200 font-medium">{m.displayName || m.email}</span>
                      {m.displayName && <span className="text-xs text-slate-500 ml-2">{m.email}</span>}
                    </div>
                    {!m.active && (
                      <span className="text-[10px] uppercase tracking-wide bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">paused</span>
                    )}
                    <div className="flex-1" />
                    <button className={btnGhost} onClick={() => verifyMailbox.mutate({ id: m.id })} disabled={verifyMailbox.isPending}>
                      Verify
                    </button>
                    <button
                      className={btnGhost}
                      onClick={() => updateMailbox.mutate({ id: m.id, data: { active: !m.active } })}
                    >
                      {m.active ? "Pause" : "Resume"}
                    </button>
                    <button
                      className="p-1.5 rounded-md text-slate-500 hover:text-red-400 hover:bg-slate-800"
                      title="Remove mailbox and delete its synced metadata"
                      onClick={() => {
                        if (confirm(`Stop tracking ${m.email}? All its synced metadata will be deleted.`))
                          removeMailbox.mutate({ id: m.id });
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
                    <span>{m.messageCount.toLocaleString()} messages ({m.filteredCount.toLocaleString()} filtered)</span>
                    <span>{m.backfillComplete ? "backfill complete" : "backfill in progress"}</span>
                    <span>
                      last sync: {m.lastSyncAt ? new Date(m.lastSyncAt).toLocaleString() : "never"}
                    </span>
                  </div>
                  {m.lastSyncStatus === "error" && m.lastSyncError && (
                    <div className="text-[11px] text-red-400 mt-1 break-all">{m.lastSyncError}</div>
                  )}
                  {v && (
                    <div className={`text-[11px] mt-1 ${v.ok ? "text-[#10b981]" : "text-red-400"} break-all`}>
                      {v.ok ? `✓ Connected — ${v.messagesTotal?.toLocaleString()} messages in mailbox` : v.error}
                    </div>
                  )}
                </div>
              );
            })}
            {status && status.mailboxes.length === 0 && (
              <div className="text-sm text-slate-500">No mailboxes tracked yet — add the first one below.</div>
            )}
          </div>
          <form
            className="flex flex-wrap gap-2 mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (newEmail.trim()) addMailbox.mutate({ data: { email: newEmail.trim(), displayName: newName.trim() || undefined } });
            }}
          >
            <input className={`${inputCls} flex-1 min-w-[200px]`} placeholder="person@yourdomain.com" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            <input className={`${inputCls} w-36`} placeholder="Display name" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button type="submit" className={btnCls} disabled={addMailbox.isPending || !newEmail.trim()}>
              Add mailbox
            </button>
          </form>
        </Card>

        {/* Exclusions */}
        <Card>
          <div className="flex items-center gap-2 mb-1">
            <ShieldBan size={14} className="text-[#10b981]" />
            <span className="text-sm font-semibold text-slate-200">Exclusion rules</span>
          </div>
          <div className="text-xs text-slate-500 mb-3">
            Bulk mail is auto-filtered (List-Unsubscribe, no-reply senders, Gmail categories). Add rules here for anything
            it misses — rules apply retroactively and filtered mail stays visible in the dashboard's filtered bucket.
          </div>
          <div className="space-y-1.5">
            {exclusions?.map((r) => (
              <div key={r.id} className="flex items-center gap-2 text-xs border border-slate-800 rounded px-2.5 py-1.5">
                <span className="text-[10px] uppercase tracking-wide bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded">{r.kind}</span>
                <span className="text-slate-200 font-mono">{r.value}</span>
                {r.note && <span className="text-slate-500 truncate">— {r.note}</span>}
                <div className="flex-1" />
                <button
                  className="p-1 rounded text-slate-500 hover:text-red-400"
                  onClick={() => removeExclusion.mutate({ id: r.id })}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            {exclusions && exclusions.length === 0 && <div className="text-sm text-slate-500">No manual rules yet.</div>}
          </div>
          <form
            className="flex flex-wrap gap-2 mt-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (exValue.trim()) addExclusion.mutate({ data: { kind: exKind, value: exValue.trim(), note: exNote.trim() || undefined } });
            }}
          >
            <select className={inputCls} value={exKind} onChange={(e) => setExKind(e.target.value as "address" | "domain")}>
              <option value="domain">Domain</option>
              <option value="address">Address</option>
            </select>
            <input
              className={`${inputCls} flex-1 min-w-[180px]`}
              placeholder={exKind === "domain" ? "example.com" : "sender@example.com"}
              value={exValue}
              onChange={(e) => setExValue(e.target.value)}
            />
            <input className={`${inputCls} w-40`} placeholder="Note (optional)" value={exNote} onChange={(e) => setExNote(e.target.value)} />
            <button type="submit" className={btnCls} disabled={addExclusion.isPending || !exValue.trim()}>
              Add rule
            </button>
          </form>
        </Card>

        {/* Settings */}
        <Card>
          <div className="text-sm font-semibold text-slate-200 mb-3">Thresholds</div>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const hours = Number(threshold);
              if (hours >= 1) updateSettings.mutate({ data: { unansweredThresholdHours: hours } });
            }}
          >
            <label className="text-xs text-slate-400">
              Flag threads unanswered after (hours)
              <input
                type="number"
                min={1}
                max={720}
                className={`${inputCls} block mt-1 w-32`}
                placeholder={String(status?.settings.unansweredThresholdHours ?? 24)}
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </label>
            <button type="submit" className={btnCls} disabled={updateSettings.isPending || !threshold}>
              Save
            </button>
            <div className="text-[11px] text-slate-500">
              Backfill horizon: {status?.settings.backfillDays ?? 365} days (applies to newly added mailboxes)
            </div>
          </form>
        </Card>
      </div>
    </AppShell>
  );
}
