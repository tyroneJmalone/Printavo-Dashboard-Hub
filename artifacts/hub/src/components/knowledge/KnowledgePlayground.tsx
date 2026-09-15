import { FormEvent, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  FlaskConical,
  Loader2,
  RotateCcw,
  Search,
} from "lucide-react";
import type { KnowledgePlaygroundResponse } from "@workspace/api-client-react";
import { customFetch } from "../../../../../lib/api-client-react/src/custom-fetch";

async function requestKnowledgePlayground(message: string): Promise<KnowledgePlaygroundResponse> {
  return customFetch<KnowledgePlaygroundResponse>("/api/knowledge/playground", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

function errorMessage(error: unknown): string {
  const apiError = error as { data?: { error?: string; message?: string }; message?: string };
  return apiError?.data?.error ?? apiError?.data?.message ?? apiError?.message ?? "We couldn't test the knowledge base. Try again.";
}

export function KnowledgePlayground() {
  const [message, setMessage] = useState("");
  const [submittedMessage, setSubmittedMessage] = useState<string | null>(null);
  const [result, setResult] = useState<KnowledgePlaygroundResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);

  const trimmedMessage = message.trim();
  const canSubmit = trimmedMessage.length >= 3 && trimmedMessage.length <= 4000 && !isPending;

  const runPlayground = async (nextMessage: string) => {
    const trimmed = nextMessage.trim();
    if (trimmed.length < 3 || trimmed.length > 4000 || isPending) return;

    setIsPending(true);
    setError(null);
    setResult(null);
    setSubmittedMessage(trimmed);

    try {
      setResult(await requestKnowledgePlayground(trimmed));
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setIsPending(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runPlayground(message);
  };

  const updateMessage = (nextMessage: string) => {
    setMessage(nextMessage);
    // A result belongs to the exact submitted message. Clear it as soon as
    // the draft changes so an old answer cannot look like a new one.
    setSubmittedMessage(null);
    setResult(null);
    setError(null);
  };

  return (
    <section
      aria-labelledby="knowledge-playground-heading"
      className="rounded-xl border border-slate-800 bg-[#0f172a] p-4 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <FlaskConical size={18} className="mt-0.5 shrink-0 text-[#10b981]" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="knowledge-playground-heading" className="text-sm font-semibold text-slate-100">
            Test the knowledge base
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            Preview how a customer or prospect message is answered using only approved, currently effective
            Customer-Shareable facts and Brand/Voice Guidance. Internal Operational Knowledge is never shown or
            used for this customer-facing test. This is a simulation: it does not send an email or save a
            knowledge-base entry, and it does not include full email or customer-account context.
          </p>
        </div>
      </div>

      <form className="mt-4 space-y-3" onSubmit={submit}>
        <div>
          <label htmlFor="knowledge-playground-message" className="mb-1.5 block text-xs font-medium text-slate-300">
            Customer or prospect message
          </label>
          <textarea
            id="knowledge-playground-message"
            value={message}
            onChange={(event) => updateMessage(event.target.value)}
            placeholder="e.g. How quickly can you print and ship 50 hoodies?"
            maxLength={4000}
            rows={4}
            aria-describedby="knowledge-playground-help knowledge-playground-count"
            className="w-full resize-y rounded-md border border-slate-700 bg-[#1e293b] px-3 py-2.5 text-sm leading-relaxed text-slate-100 placeholder:text-slate-500 focus:border-[#059669] focus:outline-none focus:ring-1 focus:ring-[#059669]"
          />
          <div className="mt-1.5 flex items-start justify-between gap-3 text-[11px]">
            <span id="knowledge-playground-help" className="text-slate-500">
              Enter at least 3 characters. The test message is used only for this response.
            </span>
            <span
              id="knowledge-playground-count"
              className={`shrink-0 ${trimmedMessage.length > 4000 ? "text-red-300" : "text-slate-500"}`}
              aria-live="polite"
            >
              {message.length.toLocaleString()} / 4,000
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#059669] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#047857] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isPending ? (
              <>
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                Testing…
              </>
            ) : (
              <>
                <FlaskConical size={14} aria-hidden="true" />
                Try response
              </>
            )}
          </button>
          {trimmedMessage.length > 0 && trimmedMessage.length < 3 && (
            <span className="text-[11px] text-amber-300">Add at least {3 - trimmedMessage.length} more character{3 - trimmedMessage.length === 1 ? "" : "s"}.</span>
          )}
        </div>
      </form>

      {error && (
        <div
          role="alert"
          className="mt-4 flex flex-wrap items-start gap-2.5 rounded-lg border border-red-900/60 bg-red-950/30 px-3.5 py-3 text-sm text-red-200"
        >
          <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{error}</span>
          {submittedMessage && (
            <button
              type="button"
              onClick={() => void runPlayground(submittedMessage)}
              disabled={isPending}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-red-800/70 px-2.5 py-1.5 text-xs font-medium text-red-100 hover:bg-red-900/40 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCcw size={13} aria-hidden="true" />
              Try again
            </button>
          )}
        </div>
      )}

      {isPending && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/30 px-3.5 py-3 text-sm text-slate-400" role="status">
          <Loader2 size={16} className="animate-spin text-[#10b981]" aria-hidden="true" />
          Searching approved knowledge entries…
        </div>
      )}

      {result && submittedMessage && (
        <div className="mt-4 space-y-4 border-t border-slate-800 pt-4">
          <div className="rounded-lg border border-slate-800 bg-slate-950/30 px-3.5 py-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Message tested</div>
            <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{submittedMessage}</p>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Suggested reply</h3>
            <div className="mt-2 whitespace-pre-wrap rounded-lg border border-emerald-900/40 bg-emerald-950/15 px-3.5 py-3 text-sm leading-relaxed text-slate-100">
              {result.reply}
            </div>
          </div>

          <div>
            <div className="flex items-center gap-2">
              <Search size={14} className="text-slate-500" aria-hidden="true" />
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Searched terms</h3>
            </div>
            {result.searchQueries.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Actual search terms">
                {result.searchQueries.map((query, index) => (
                  <span key={`${query}-${index}`} className="rounded-full border border-slate-700 bg-slate-800/70 px-2 py-1 text-xs text-slate-300">
                    {query}
                  </span>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-slate-500">No search terms were returned.</p>
            )}
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Matched customer-safe entries
            </h3>
            {result.retrievedEntries.length === 0 ? (
              <div className="mt-2 rounded-lg border border-amber-900/50 bg-amber-950/20 px-3.5 py-3 text-sm text-amber-200">
                No approved, currently effective customer-shareable facts or brand guidance matched this message.
              </div>
            ) : (
              <div className="mt-2 space-y-2">
                {result.retrievedEntries.map((entry) => {
                  const usedInReply = result.usedEntryIds.includes(entry.id);
                  return (
                    <details key={entry.id} className="group rounded-lg border border-slate-800 bg-slate-950/25">
                      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2.5 text-sm text-slate-200 marker:hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[#059669] [&::-webkit-details-marker]:hidden">
                        <ChevronDown size={14} className="shrink-0 text-slate-500 transition-transform group-open:rotate-180" aria-hidden="true" />
                        <span className="min-w-0 flex-1 font-medium">{entry.title}</span>
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{entry.category}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            usedInReply ? "bg-emerald-500/15 text-emerald-300" : "bg-slate-800 text-slate-400"
                          }`}
                        >
                          {usedInReply ? "Used in reply" : "Retrieved only"}
                        </span>
                      </summary>
                      <div className="border-t border-slate-800 px-3 py-3">
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-300">{entry.body}</p>
                      </div>
                    </details>
                  );
                })}
              </div>
            )}
          </div>

          {result.note && (
            <p className="border-t border-slate-800 pt-3 text-xs leading-relaxed text-slate-500">
              <span className="font-semibold text-slate-400">Note:</span> {result.note}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
