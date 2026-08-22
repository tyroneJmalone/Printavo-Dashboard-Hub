import { useState } from "react";
import { useLocation, Link } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { useListAiQuoteDrafts, useInterpretAiQuotePrompt } from "@workspace/api-client-react";
import { Loader2, Wand2, Clock, ChevronRight, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";

export default function AiQuotesList() {
  const [, setLocation] = useLocation();
  const [prompt, setPrompt] = useState("");
  const { toast } = useToast();
  const { data: drafts, isLoading } = useListAiQuoteDrafts();
  const interpret = useInterpretAiQuotePrompt();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    interpret.mutate(
      { data: { prompt: prompt.trim() } },
      {
        onSuccess: (res) => {
          setLocation(`/ai-quotes/${res.id}`);
        },
        onError: (error: Error) => {
          toast({
            title: "Could not create draft",
            description: error.message,
            variant: "destructive",
          });
        },
      }
    );
  };

  const statusColors: Record<string, string> = {
    draft: "bg-blue-500/10 text-blue-400 border-blue-500/20",
    creating: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    created: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    failed: "bg-red-500/10 text-red-400 border-red-500/20",
    unknown: "bg-slate-500/10 text-slate-400 border-slate-500/20",
  };

  return (
    <AppShell>
      <div className="max-w-5xl mx-auto p-6 flex flex-col gap-8 h-full">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2 tracking-tight">
            <Wand2 className="text-[#10b981]" size={28} />
            AI Quote Drafts
          </h1>
          <p className="text-sm text-slate-400 mt-1">
            Create a local, reviewable draft from a request. Nothing is written to Printavo until you explicitly confirm it.
          </p>
        </div>

        <div className="bg-[#0f172a] border border-slate-800 rounded-2xl p-5 shadow-sm">
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <label className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              New Draft
            </label>
            <Textarea
              placeholder="e.g. 50 black gildan 5000s for Acme Corp, large front print 2 colors..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-[100px] bg-slate-950 border-slate-800 text-slate-200 resize-y placeholder:text-slate-600"
              disabled={interpret.isPending}
            />
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={!prompt.trim() || interpret.isPending}
                className="bg-[#059669] hover:bg-[#047857] text-white transition-colors"
              >
                {interpret.isPending ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Wand2 className="w-4 h-4 mr-2" />
                )}
                Interpret & Draft
              </Button>
            </div>
          </form>
        </div>

        <div className="flex-1 flex flex-col gap-4">
          <h2 className="text-sm font-bold text-slate-300 uppercase tracking-wider">Recent Drafts</h2>
          {isLoading ? (
            <div className="py-12 flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-slate-500" />
            </div>
          ) : drafts?.drafts.length === 0 ? (
            <div className="bg-[#0f172a]/50 border border-slate-800/50 rounded-xl p-8 text-center flex flex-col items-center">
              <FileText className="w-10 h-10 text-slate-700 mb-3" />
              <p className="text-slate-400 text-sm">No recent quote drafts.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {drafts?.drafts.map((d) => (
                <Link
                  key={d.id}
                  href={`/ai-quotes/${d.id}`}
                  className="block bg-[#0f172a] border border-slate-800 rounded-xl p-4 hover:border-slate-700 hover:bg-[#1e293b] transition-colors group"
                >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-3 mb-1.5">
                          <span className="font-mono text-xs text-slate-500">{d.id.split("-")[0]}</span>
                          <Badge variant="outline" className={`text-[10px] uppercase font-bold py-0 h-5 border ${statusColors[d.status] || statusColors.unknown}`}>
                            {d.status}
                          </Badge>
                          <span className="text-[10px] text-slate-500 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {formatDistanceToNow(new Date(d.createdAt), { addSuffix: true })}
                          </span>
                          {d.printavoVisualId && (
                            <span className="text-[10px] font-mono font-bold text-emerald-400">
                              Printavo quote #{d.printavoVisualId}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-slate-300 line-clamp-2 leading-relaxed">
                          {d.prompt}
                        </p>
                      </div>
                      <div className="flex-shrink-0 pt-2 text-slate-600 group-hover:text-[#10b981] transition-colors">
                        <ChevronRight className="w-5 h-5" />
                      </div>
                    </div>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}
