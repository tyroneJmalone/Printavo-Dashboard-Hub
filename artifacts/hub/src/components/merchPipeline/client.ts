import { customFetch } from "@workspace/api-client-react";
export const stages = ["Target/Prospect/Inquiry", "Discovery", "Real Deal/Scheduled", "Gathering/Building", "Live", "Closed"] as const;
export type Details = {
  status?: string; dashboardUrl?: string; previewUrl?: string; websiteUrl?: string;
  launchDate?: string | null; closeDate?: string | null; inHandDate?: string | null;
  fundraiser?: boolean; payee?: string; processes?: string; audience?: string;
  repeat?: boolean; partial?: boolean; inHouse?: boolean; notes?: string;
  mailingAddress?: string; checkDate?: string | null; checkAmount?: string | null; payoutNotes?: string;
};
export type Opportunity = {
  id: string; name: string; stage: typeof stages[number]; ownerId: string | null;
  nextAction: string; dueDate: string | null; chipplyStoreId: string | null;
  eventId: string | null; archived: boolean; details: Details; createdAt: string; updatedAt: string;
};
export type StaffChoice = { id: string; email: string };
export type StoreChoice = { id: string; name: string; eventId: string | null };
export type Thread = { id: string; subject: string; webUrl?: string | null };
export type ThreadLink = { id: string; subject: string; threadId: string | null; url: string | null };
export function merchRequest<T>(path: string, method = "GET", body?: unknown) {
  return customFetch<T>(`/api${path}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
}
export const inputClass = "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100";
export const buttonClass = "rounded-md border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50";