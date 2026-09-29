import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { CorrespondenceEmailBody } from "@/components/email/CorrespondenceEmailBody";
import { useCorrespondenceThreads, useCorrespondenceThread, useCorrespondenceAiSearch, useCorrespondenceMailboxes } from "@/hooks/use-correspondence";
import { Search, Sparkles, Mail, Inbox, Archive, MessageCircle, AlertCircle, Loader2, Send } from "lucide-react";

function ThreadView({ threadId }: { threadId: string }) {
  const { data, isLoading, error } = useCorrespondenceThread(threadId);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="animate-spin text-slate-500" size={24} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-500 space-y-2">
        <AlertCircle size={32} className="text-slate-600" />
        <p>Couldn't load thread</p>
      </div>
    );
  }

  const { thread, messages } = data;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex-none p-5 border-b border-slate-800/60 bg-slate-900/50">
        <h2 className="text-xl font-semibold text-white mb-2">{thread.subject || "(No subject)"}</h2>
        <div className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-2 text-slate-300">
            <div className="w-8 h-8 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-semibold border border-emerald-500/30">
              {thread.counterpart.charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="font-medium">{thread.counterpart}</div>
              <div className="text-xs text-slate-500">{thread.counterpartEmail}</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-1 rounded bg-slate-800 text-slate-300 capitalize">{thread.status}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar">
        {messages.map((msg, idx) => (
          <div key={msg.id} className="relative">
            {idx !== 0 && (
              <div className="absolute -top-6 left-6 w-px h-6 bg-slate-800" />
            )}
            <div className="bg-[#0f172a] border border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <div className="px-4 py-3 bg-slate-900/50 border-b border-slate-800 flex items-start justify-between">
                <div>
                  <div className="font-medium text-slate-200 text-sm">{msg.from}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    to {msg.to.join(", ")}
                    {msg.cc?.length > 0 && ` • cc ${msg.cc.join(", ")}`}
                  </div>
                </div>
                <div className="text-xs text-slate-400">
                  {new Date(msg.date).toLocaleString(undefined, {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
                  })}
                </div>
              </div>
              <div className="p-4 text-sm text-slate-300 leading-7">
                <CorrespondenceEmailBody threadId={threadId} messageId={msg.id} body={msg.bodyText || msg.snippet || ""} />
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-slate-800/60 flex flex-wrap gap-2">
                    {msg.attachments.map(att => (
                      <div key={att.id} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800/50 border border-slate-700/50 text-xs text-slate-300 hover:bg-slate-800 cursor-pointer">
                        <span className="truncate max-w-[150px]">{att.filename}</span>
                        <span className="text-slate-500 text-[10px]">{(att.size / 1024).toFixed(0)}KB</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Correspondence() {
  const [activeTab, setActiveTab] = useState<"inbox" | "sent" | "archived" | "ai">("inbox");
  const [mailboxId, setMailboxId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const { data: mailboxesData, isLoading: mailboxesLoading } = useCorrespondenceMailboxes();
  const { data: threadsData, isLoading, error: threadsError } = useCorrespondenceThreads({
    folder: activeTab === "ai" ? undefined : activeTab,
    mailboxId: submittedQuery ? undefined : mailboxId || undefined,
    q: activeTab !== "ai" ? submittedQuery : undefined,
    limit: 50
  });

  const aiSearchMutation = useCorrespondenceAiSearch();

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittedQuery(searchQuery);
    
    if (activeTab === "ai") {
      if (!searchQuery.trim()) return;
      aiSearchMutation.mutate({ query: searchQuery });
    }
  };

  const threads = threadsData?.threads || [];

  return (
    <AppShell>
      <div className="h-[calc(100vh-64px)] lg:h-[100dvh] flex overflow-hidden">
        {/* Sidebar */}
        <div className="w-full lg:w-[380px] flex-shrink-0 border-r border-slate-800 bg-[#020617] flex flex-col">
          <div className="p-4 border-b border-slate-800">
            <h1 className="text-lg font-semibold text-white flex items-center gap-2 mb-4">
              <MessageCircle size={18} className="text-[#10b981]" />
              Correspondence
            </h1>

            <label className="block mb-3">
              <span className="block text-[11px] font-medium text-slate-400 mb-1.5">
                Browsing mailbox
              </span>
              <select
                value={mailboxId}
                disabled={mailboxesLoading}
                onChange={(event) => {
                  setMailboxId(event.target.value);
                  setSelectedThreadId(null);
                }}
                className="w-full bg-[#0f172a] border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669] disabled:opacity-60"
              >
                <option value="">All authorized mailboxes</option>
                {mailboxesData?.mailboxes.map((mailbox) => (
                  <option key={mailbox.id} value={mailbox.id}>
                    {mailbox.displayName || mailbox.email}
                    {mailbox.displayName ? ` — ${mailbox.email}` : ""}
                  </option>
                ))}
              </select>
            </label>

            <form onSubmit={handleSearchSubmit} className="relative mb-4">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" size={14} />
              <input 
                type="text"
                placeholder="Search emails, subjects, customers..."
                className="w-full bg-[#0f172a] border border-slate-700 text-slate-200 text-sm rounded-lg pl-8 pr-3 py-2 focus:outline-none focus:border-[#059669] placeholder:text-slate-500"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </form>
            <p className="text-[10px] leading-4 text-slate-500 -mt-2 mb-3">
              Search scope: all correspondence you’re authorized to search, across every mailbox and folder.
            </p>

            <div className="flex gap-1 bg-[#0f172a] p-1 rounded-lg border border-slate-800">
              <button
                className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded-md transition-colors ${activeTab === "inbox" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"}`}
                onClick={() => { setActiveTab("inbox"); setSelectedThreadId(null); }}
              >
                <Inbox size={14} /> Inbox
              </button>
              <button
                className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded-md transition-colors ${activeTab === "sent" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"}`}
                onClick={() => { setActiveTab("sent"); setSelectedThreadId(null); }}
              >
                <Send size={14} /> Sent
              </button>
              <button
                className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded-md transition-colors ${activeTab === "archived" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"}`}
                onClick={() => { setActiveTab("archived"); setSelectedThreadId(null); }}
              >
                <Archive size={14} /> Archived
              </button>
              <button
                className={`flex-1 flex items-center justify-center gap-1.5 text-xs font-medium py-1.5 rounded-md transition-colors ${activeTab === "ai" ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30" : "text-slate-400 hover:text-slate-200"}`}
                onClick={() => { setActiveTab("ai"); setSelectedThreadId(null); }}
              >
                <Sparkles size={14} /> AI
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto custom-scrollbar">
            {activeTab === "ai" ? (
              <div className="p-4 space-y-4">
                {aiSearchMutation.isPending && (
                  <div className="flex justify-center p-8">
                    <Loader2 className="animate-spin text-slate-500" size={20} />
                  </div>
                )}
                {aiSearchMutation.data && !aiSearchMutation.isPending && (
                  <>
                    <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-sm text-emerald-100/90 leading-relaxed shadow-sm">
                      <Sparkles size={16} className="text-emerald-400 mb-2" />
                      {aiSearchMutation.data.summary}
                    </div>
                    {aiSearchMutation.data.results?.length > 0 && (
                      <div className="divide-y divide-slate-800/60 mt-4">
                        {aiSearchMutation.data.results.map((res) => (
                          <button
                            key={res.threadId}
                            className={`w-full text-left py-3 hover:bg-slate-900/50 transition-colors ${selectedThreadId === res.threadId ? "bg-slate-900 border-l-2 border-[#10b981] px-2" : "border-l-2 border-transparent px-2"}`}
                            onClick={() => setSelectedThreadId(res.threadId)}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <span className="font-medium text-slate-200 text-sm truncate pr-2">{res.counterpart || "Unknown"}</span>
                              <span className="text-[10px] text-emerald-400 font-medium whitespace-nowrap bg-emerald-500/10 px-1.5 py-0.5 rounded">
                                Source
                              </span>
                            </div>
                            <div className="text-xs text-slate-300 truncate font-medium mb-1">
                              {res.subject || "(No subject)"}
                            </div>
                            <div className="text-xs text-slate-500 line-clamp-2 leading-relaxed">
                              {res.content}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                )}
                {!aiSearchMutation.data && !aiSearchMutation.isPending && (
                  <div className="text-center p-8 text-slate-500 text-sm">
                    Enter a semantic query like "Show me emails about delays on Next Level apparel" to search with AI.
                  </div>
                )}
              </div>
            ) : isLoading ? (
              <div className="flex justify-center p-8">
                <Loader2 className="animate-spin text-slate-500" size={20} />
              </div>
            ) : threadsError ? (
              <div className="text-center p-8 text-rose-300 text-sm">
                {threadsError instanceof Error ? threadsError.message : "Unable to load correspondence."}
              </div>
            ) : threads.length === 0 ? (
              <div className="text-center p-8 text-slate-500 text-sm">
                No threads found.
              </div>
            ) : (
              <div className="divide-y divide-slate-800/60">
                {threads.map(thread => (
                  <button
                    key={thread.id}
                    className={`w-full text-left p-4 hover:bg-slate-900/50 transition-colors ${selectedThreadId === thread.id ? "bg-slate-900 border-l-2 border-[#10b981]" : "border-l-2 border-transparent"}`}
                    onClick={() => setSelectedThreadId(thread.id)}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium text-slate-200 text-sm truncate pr-2">{thread.counterpart}</span>
                      <span className="text-[10px] text-slate-500 whitespace-nowrap">
                        {new Date(thread.lastMessageAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                    </div>
                    <div className="text-xs text-slate-300 truncate font-medium mb-1">
                      {thread.subject || "(No subject)"}
                    </div>
                    <div className="text-xs text-slate-500 line-clamp-2 leading-relaxed">
                      {thread.snippet}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Main content */}
        <div className={`flex-1 bg-[#020617] ${selectedThreadId ? "flex" : "hidden lg:flex"}`}>
          {selectedThreadId ? (
            <ThreadView threadId={selectedThreadId} />
          ) : (
            <div className="flex flex-col items-center justify-center h-full w-full text-slate-500 space-y-4">
              <div className="w-16 h-16 rounded-2xl bg-slate-900 flex items-center justify-center border border-slate-800">
                <Mail size={24} className="text-slate-600" />
              </div>
              <div className="text-center">
                <h3 className="text-sm font-medium text-slate-300">Select a thread</h3>
                <p className="text-xs text-slate-500 mt-1 max-w-[200px]">
                  Choose a conversation from the list to view its contents.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}