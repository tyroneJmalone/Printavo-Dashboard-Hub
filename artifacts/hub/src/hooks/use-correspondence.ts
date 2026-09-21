import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface Thread {
  id: string;
  mailboxId: string;
  gmailThreadId: string;
  subject: string;
  counterpart: string;
  counterpartEmail?: string;
  lastMessageAt: string;
  messageCount: number;
  snippet?: string;
  status: "open" | "archived" | "snoozed";
  participants: string[];
}

export interface CorrespondenceMailbox {
  id: string;
  email: string;
  displayName: string | null;
}

export interface AiSearchSource {
  id: string;
  threadId: string;
  subject: string;
  counterpart: string;
  from: string;
  date: string;
  content: string;
}

export function useCorrespondenceMailboxes() {
  return useQuery({
    queryKey: ["correspondence", "mailboxes"],
    queryFn: () =>
      apiFetch<{ mailboxes: CorrespondenceMailbox[] }>("/correspondence/mailboxes"),
  });
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  gmailMessageId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  date: string;
  snippet: string;
  bodyHtml?: string;
  bodyText?: string;
  attachments?: { id: string; filename: string; mimeType: string; size: number }[];
}

export function useCorrespondenceSearch() {
  return useMutation({
    mutationFn: (data: { query: string; limit?: number; offset?: number }) => 
      apiFetch<{ threads: Thread[]; total: number }>("/correspondence/search", {
        method: "POST",
        body: JSON.stringify(data),
      })
  });
}

export function useCorrespondenceAiSearch() {
  return useMutation({
    mutationFn: (data: { query: string; customerId?: string }) =>
      apiFetch<{ results: AiSearchSource[]; summary: string }>("/correspondence/ai-search", {
        method: "POST",
        body: JSON.stringify(data),
      })
  });
}

export function useCorrespondenceHistoryImport() {
  return useMutation({
    mutationFn: (data: { fromDate?: string; toDate?: string; emails?: string[] }) => 
      apiFetch<{ started: boolean; job_id: string }>("/correspondence/history-import", {
        method: "POST",
        body: JSON.stringify(data),
      })
  });
}

export function useCorrespondenceThreads(params: {
  folder?: "inbox" | "sent" | "archived";
  mailboxId?: string;
  q?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: ["correspondence", "threads", params],
    queryFn: () => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") {
          q.append(k, String(v));
        }
      }
      return apiFetch<{ threads: Thread[]; total: number; hasMore: boolean }>(`/correspondence/threads?${q.toString()}`);
    }
  });
}

export function useCorrespondenceThread(id: string) {
  return useQuery({
    queryKey: ["correspondence", "threads", id],
    queryFn: () => apiFetch<{ thread: Thread; messages: ThreadMessage[] }>(`/correspondence/threads/${id}`),
    enabled: !!id
  });
}
