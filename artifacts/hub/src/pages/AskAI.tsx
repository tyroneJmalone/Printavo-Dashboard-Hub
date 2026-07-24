import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import {
  useAskInsights,
  useListInsightsPresets,
  getListInsightsPresetsQueryKey,
  useCreateInsightsPreset,
  useUpdateInsightsPreset,
  useRunInsightsPreset,
  type AskInsightsResponse,
  type RunInsightsPresetResponse,
  type InsightsPreset,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  Sparkles,
  Loader2,
  Save,
  Play,
  Archive,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Code2,
} from "lucide-react";

const EXAMPLE_QUESTIONS = [
  "Who were our top 10 customers by revenue this year?",
  "What was our total invoice revenue last month?",
  "Which order statuses have the most orders right now?",
  "What styles did we order the most pieces of in the last 90 days?",
];

function extractError(err: unknown): string {
  return (
    (err as { data?: { error?: string } })?.data?.error ??
    "Something went wrong. Try rephrasing your question."
  );
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function ResultsTable({
  columns,
  rows,
  truncated,
}: {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-400 py-3">No rows returned.</p>;
  }
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-slate-800 max-h-[28rem] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-900">
            <tr>
              {columns.map((c, i) => (
                <th
                  key={i}
                  className="text-left px-3 py-2 font-semibold text-slate-300 whitespace-nowrap border-b border-slate-800"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="odd:bg-slate-900/40">
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className="px-3 py-1.5 text-slate-200 whitespace-nowrap max-w-[24rem] overflow-hidden text-ellipsis"
                  >
                    {formatCell(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500 mt-1.5">
        {rows.length} row{rows.length === 1 ? "" : "s"}
        {truncated && " — results truncated at 500 rows; ask a more specific question to narrow it down"}
      </p>
    </div>
  );
}

function SqlBlock({ sql }: { sql: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Code2 size={14} />
        {open ? "Hide SQL" : "Show SQL"}
      </button>
      {open && (
        <pre className="mt-2 text-xs bg-slate-950 border border-slate-800 rounded-lg p-3 overflow-x-auto text-emerald-300/90 whitespace-pre-wrap">
          {sql}
        </pre>
      )}
    </div>
  );
}

export default function AskAI() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskInsightsResponse | null>(null);
  const [askError, setAskError] = useState<string | null>(null);

  const [saveOpen, setSaveOpen] = useState(false);
  const [presetName, setPresetName] = useState("");

  const [runResult, setRunResult] = useState<RunInsightsPresetResponse | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);

  const ask = useAskInsights({
    mutation: {
      onSuccess: (data) => {
        setResult(data);
        setAskError(null);
      },
      onError: (err) => {
        setResult(null);
        setAskError(extractError(err));
      },
    },
  });

  const presetsQuery = useListInsightsPresets(undefined, {
    query: { queryKey: getListInsightsPresetsQueryKey(undefined) },
  });
  const presets = presetsQuery.data?.presets ?? [];

  const invalidatePresets = () =>
    queryClient.invalidateQueries({ queryKey: getListInsightsPresetsQueryKey(undefined) });

  const createPreset = useCreateInsightsPreset({
    mutation: {
      onSuccess: (data) => {
        setSaveOpen(false);
        invalidatePresets();
        toast({ title: "Preset saved", description: `“${data.preset.name}” added to your presets.` });
      },
      onError: (err) => toast({ title: "Couldn't save preset", description: extractError(err), variant: "destructive" }),
    },
  });

  const updatePreset = useUpdateInsightsPreset({
    mutation: {
      onSuccess: () => invalidatePresets(),
      onError: (err) => toast({ title: "Couldn't update preset", description: extractError(err), variant: "destructive" }),
    },
  });

  const runPreset = useRunInsightsPreset({
    mutation: {
      onSuccess: (data) => {
        setRunResult(data);
        setRunningId(null);
        invalidatePresets();
      },
      onError: (err) => {
        setRunningId(null);
        toast({
          title: "Preset failed to run",
          description: extractError(err),
          variant: "destructive",
        });
      },
    },
  });

  const canAsk = question.trim().length >= 3 && !ask.isPending;

  const submit = () => {
    if (!canAsk) return;
    setAskError(null);
    ask.mutate({ data: { question: question.trim() } });
  };

  return (
    <AppShell>
      <div className="sticky top-0 z-10 bg-[#020617]/80 backdrop-blur-md border-b border-slate-800 px-8 py-5">
        <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
          <Sparkles size={20} className="text-[#10b981]" />
          Ask AI
        </h1>
        <p className="text-xs text-slate-400 mt-1">
          Ask questions about your Printavo data in plain English — answers come from the local
          mirror, read-only
        </p>
      </div>

      <div className="px-8 py-6 space-y-6 max-w-5xl">
        <div className="space-y-3">
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="e.g. Who were our top 10 customers by revenue this year?"
            className="min-h-[80px] bg-slate-900 border-slate-700 text-white"
            maxLength={1000}
          />
          <div className="flex items-center gap-3 flex-wrap">
            <Button onClick={submit} disabled={!canAsk} className="bg-[#10b981] hover:bg-[#0ea371] text-slate-950 font-semibold">
              {ask.isPending ? (
                <>
                  <Loader2 size={16} className="animate-spin mr-1.5" />
                  Thinking…
                </>
              ) : (
                <>
                  <Sparkles size={16} className="mr-1.5" />
                  Ask
                </>
              )}
            </Button>
            {!result && !ask.isPending && (
              <div className="flex gap-2 flex-wrap">
                {EXAMPLE_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setQuestion(q)}
                    className="text-xs px-2.5 py-1 rounded-full border border-slate-700 text-slate-400 hover:text-white hover:border-slate-500 transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {askError && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-800/60 bg-amber-950/30 px-4 py-3 text-sm text-amber-200">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{askError}</span>
          </div>
        )}

        {result && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs text-slate-500 mb-1">{result.question}</p>
                <p className="text-sm text-slate-100 leading-relaxed">{result.answer}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0 border-slate-700 text-slate-200"
                onClick={() => {
                  setPresetName(result.question.slice(0, 120));
                  setSaveOpen(true);
                }}
              >
                <Save size={14} className="mr-1.5" />
                Save as preset
              </Button>
            </div>
            <ResultsTable columns={result.columns} rows={result.rows} truncated={result.truncated} />
            <SqlBlock sql={result.sql} />
          </div>
        )}

        <div className="pt-2">
          <h2 className="text-sm font-semibold text-white mb-3">Saved presets</h2>
          {presetsQuery.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-slate-400 py-4">
              <Loader2 size={16} className="animate-spin" /> Loading presets…
            </div>
          ) : presets.length === 0 ? (
            <p className="text-sm text-slate-500 py-2">
              No presets yet. Ask a question above, then save the answer as a preset to re-run it
              anytime.
            </p>
          ) : (
            <div className="space-y-2">
              {presets.map((p: InsightsPreset) => (
                <div key={p.id} className="rounded-lg border border-slate-800 bg-slate-900/40">
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-white truncate">{p.name}</p>
                      <p className="text-xs text-slate-500 truncate">
                        {p.question}
                        {p.lastRunAt && (
                          <> · last run {new Date(p.lastRunAt).toLocaleDateString()}</>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-slate-700 text-slate-200"
                        disabled={runPreset.isPending}
                        onClick={() => {
                          setRunningId(p.id);
                          setRunResult(null);
                          runPreset.mutate({ id: p.id });
                        }}
                      >
                        {runPreset.isPending && runningId === p.id ? (
                          <Loader2 size={14} className="animate-spin mr-1.5" />
                        ) : (
                          <Play size={14} className="mr-1.5" />
                        )}
                        Run
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-slate-500 hover:text-slate-200"
                        title="Archive preset"
                        disabled={updatePreset.isPending}
                        onClick={() => {
                          if (runResult?.preset.id === p.id) setRunResult(null);
                          updatePreset.mutate({ id: p.id, data: { archived: true } });
                        }}
                      >
                        <Archive size={14} />
                      </Button>
                    </div>
                  </div>
                  {runResult && runResult.preset.id === p.id && (
                    <div className="border-t border-slate-800 px-4 py-3 space-y-3">
                      <ResultsTable
                        columns={runResult.columns}
                        rows={runResult.rows}
                        truncated={runResult.truncated}
                      />
                      <SqlBlock sql={runResult.preset.sql} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="bg-slate-900 border-slate-700 text-white">
          <DialogHeader>
            <DialogTitle>Save as preset</DialogTitle>
            <DialogDescription className="text-slate-400">
              Saves this question and its SQL so you can re-run it anytime without asking the AI
              again.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            placeholder="Preset name"
            maxLength={120}
            className="bg-slate-950 border-slate-700 text-white"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSaveOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-[#10b981] hover:bg-[#0ea371] text-slate-950 font-semibold"
              disabled={presetName.trim().length === 0 || createPreset.isPending || !result}
              onClick={() => {
                if (!result) return;
                createPreset.mutate({
                  data: {
                    name: presetName.trim(),
                    question: result.question,
                    sql: result.sql,
                  },
                });
              }}
            >
              {createPreset.isPending && <Loader2 size={14} className="animate-spin mr-1.5" />}
              Save preset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
