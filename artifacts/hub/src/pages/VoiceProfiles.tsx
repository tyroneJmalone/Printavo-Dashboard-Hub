import { useQueryClient } from "@tanstack/react-query";
import {
  useListVoiceProfiles,
  getListVoiceProfilesQueryKey,
  useRefreshVoiceProfile,
} from "@workspace/api-client-react";
import type { VoiceProfileRecord } from "@workspace/api-client-react";
import { AppShell } from "@/components/layout/AppShell";
import { useToast } from "@/hooks/use-toast";
import { AudioLines, RefreshCw, AlertTriangle, Clock } from "lucide-react";

/**
 * Per-mailbox voice profiles for voice-matched AI drafting (Pattern C).
 * A profile is DISTILLED style traits from that teammate's own sent mail —
 * greetings, sign-offs, formality, phrasing habits. Never message content.
 */

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-[#0f172a] border border-slate-800 rounded-xl p-4 ${className}`}>{children}</div>;
}

const btnGhost =
  "text-xs px-2.5 py-1.5 rounded-md border border-slate-700 text-slate-300 hover:text-white hover:bg-slate-800 disabled:opacity-50 flex items-center gap-1.5";

interface Traits {
  greetings?: string[];
  signoffs?: string[];
  formality?: { level?: number; description?: string };
  messageLength?: string;
  sentenceStyle?: string;
  punctuationHabits?: string[];
  emojiUse?: string;
  phrasingHabits?: string[];
  toneDescriptors?: string[];
  imitationNotes?: string[];
}

function TraitChips({ label, values }: { label: string; values?: string[] }) {
  if (!values?.length) return null;
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {values.map((v, i) => (
          <span key={i} className="text-xs bg-slate-800/80 border border-slate-700 rounded-full px-2 py-0.5 text-slate-200">
            {v}
          </span>
        ))}
      </div>
    </div>
  );
}

function TraitText({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-0.5">{label}</div>
      <div className="text-xs text-slate-300">{value}</div>
    </div>
  );
}

function ProfileCard({
  row,
  onRefresh,
  refreshing,
}: {
  row: VoiceProfileRecord;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const traits = (row.traits ?? null) as Traits | null;
  const statusBadge =
    row.status === "ready" ? (
      <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#059669]/15 border border-[#059669]/40 text-[#10b981]">
        ready · {row.sampleMessageCount} sent messages
      </span>
    ) : row.status === "generating" ? (
      <span className="text-[11px] px-2 py-0.5 rounded-full bg-sky-500/10 border border-sky-500/30 text-sky-300 flex items-center gap-1">
        <Clock size={10} /> generating…
      </span>
    ) : row.status === "error" ? (
      <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-500/10 border border-red-500/30 text-red-300 flex items-center gap-1">
        <AlertTriangle size={10} /> failed
      </span>
    ) : (
      <span className="text-[11px] px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-slate-400">
        no profile yet
      </span>
    );

  return (
    <Card>
      <div className="flex items-center gap-2.5 flex-wrap">
        <div className="font-semibold text-sm text-white">{row.mailboxName || row.mailboxEmail}</div>
        <div className="text-xs text-slate-500">{row.mailboxEmail}</div>
        {statusBadge}
        <div className="flex-1" />
        {row.generatedAt && (
          <div className="text-[11px] text-slate-500">
            updated {new Date(row.generatedAt).toLocaleDateString()}
          </div>
        )}
        <button className={btnGhost} disabled={refreshing || row.status === "generating"} onClick={onRefresh}>
          <RefreshCw size={12} className={row.status === "generating" ? "animate-spin" : ""} />
          {row.status === "ready" || row.status === "error" ? "Refresh" : "Generate"}
        </button>
      </div>
      {row.status === "error" && row.error && (
        <div className="mt-2 text-xs text-red-300 bg-red-500/5 border border-red-500/20 rounded-md px-2.5 py-1.5">
          {row.error}
        </div>
      )}
      {traits && row.status === "ready" && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <TraitChips label="Greetings" values={traits.greetings} />
          <TraitChips label="Sign-offs" values={traits.signoffs} />
          <TraitText
            label={`Formality${traits.formality?.level ? ` (${traits.formality.level}/5)` : ""}`}
            value={traits.formality?.description}
          />
          <TraitText label="Typical length" value={traits.messageLength} />
          <TraitText label="Sentence style" value={traits.sentenceStyle} />
          <TraitText label="Emoji use" value={traits.emojiUse} />
          <TraitChips label="Punctuation habits" values={traits.punctuationHabits} />
          <TraitChips label="Tone" values={traits.toneDescriptors} />
          <div className="sm:col-span-2">
            <TraitChips label="Phrasing habits" values={traits.phrasingHabits} />
          </div>
          {traits.imitationNotes?.length ? (
            <div className="sm:col-span-2">
              <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Imitation notes</div>
              <ul className="text-xs text-slate-300 list-disc pl-4 space-y-0.5">
                {traits.imitationNotes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

export default function VoiceProfiles() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: rows } = useListVoiceProfiles({
    query: { queryKey: getListVoiceProfilesQueryKey(), refetchInterval: 15000 },
  });
  const refresh = useRefreshVoiceProfile({
    mutation: {
      onSuccess: (res) => {
        qc.invalidateQueries({ queryKey: getListVoiceProfilesQueryKey() });
        toast({
          title: res.started ? "Voice profile refresh started" : "Refresh not started",
          description: res.started
            ? "Distilling style traits from this person's sent mail — usually under a minute."
            : (res.reason ?? "Already generating."),
        });
      },
      onError: (err: unknown) =>
        toast({
          title: "Couldn't start refresh",
          description: String((err as { error?: string })?.error ?? err),
          variant: "destructive",
        }),
    },
  });

  return (
    <AppShell>
      <div className="p-4 lg:p-6 space-y-4 max-w-4xl">
        <div className="flex items-center gap-3">
          <AudioLines size={18} className="text-[#10b981]" />
          <h1 className="text-lg font-semibold text-white">Voice Profiles</h1>
        </div>
        <div className="text-xs text-slate-500 -mt-2">
          Each profile is a distilled writing-style summary built from that person's own sent email — greetings,
          sign-offs, formality, phrasing habits. AI drafting uses it so a draft in your mailbox sounds like{" "}
          <i>you</i>. Profiles never contain message content, and connected AI platforms only ever see these traits.
        </div>
        {(rows ?? []).map((row) => (
          <ProfileCard
            key={row.mailboxId}
            row={row}
            refreshing={refresh.isPending}
            onRefresh={() => refresh.mutate({ mailboxId: row.mailboxId })}
          />
        ))}
        {rows && rows.length === 0 && (
          <Card>
            <div className="text-sm text-slate-400">No tracked mailboxes yet — set up email sync first.</div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
