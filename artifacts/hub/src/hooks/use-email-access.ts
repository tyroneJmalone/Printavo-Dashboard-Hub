import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";

export interface EmailAccessGroup {
  id: string;
  name: string;
  description: string;
  mailboxes: string[];
  members: string[]; // staff emails or ids
  createdAt: string;
}

export interface EmailAccessPolicy {
  defaultAccess: "deny";
  retentionDays: number;
  aiProcessingEnabled: boolean;
}

export interface EmailMailboxAccess {
  id: string;
  email: string;
  displayName: string | null;
  policy: {
    mailboxId: string;
    ownerStaffId: string | null;
    visibility: "private" | "group" | "workspace";
    protected: boolean;
  } | null;
}

export function useEmailMailboxPolicies() {
  return useQuery({
    queryKey: ["email-access", "mailboxes"],
    queryFn: () =>
      apiFetch<{
        mailboxes: EmailMailboxAccess[];
        staff: { id: string; email: string; role: string }[];
      }>("/email-access/mailboxes"),
  });
}

export function useUpdateEmailMailboxPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      policy,
    }: {
      id: string;
      policy: {
        ownerStaffId: string | null;
        visibility: "private" | "group" | "workspace";
        protected: boolean;
      };
    }) =>
      apiFetch(`/email-access/mailboxes/${id}/policy`, {
        method: "PUT",
        body: JSON.stringify(policy),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["email-access", "mailboxes"] }),
  });
}

export function useEmailAccessGroups() {
  return useQuery({
    queryKey: ["email-access", "groups"],
    queryFn: () => apiFetch<{ groups: EmailAccessGroup[] }>("/email-access/groups")
  });
}

export function useCreateEmailAccessGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<EmailAccessGroup>) => 
      apiFetch<EmailAccessGroup>("/email-access/groups", {
        method: "POST",
        body: JSON.stringify(data)
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-access", "groups"] })
  });
}

export function useUpdateEmailAccessGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string, data: Partial<EmailAccessGroup> }) => 
      apiFetch<EmailAccessGroup>(`/email-access/groups/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data)
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-access", "groups"] })
  });
}

export function useDeleteEmailAccessGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/email-access/groups/${id}`, {
      method: "DELETE"
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-access", "groups"] })
  });
}

export function useEmailAccessPolicy() {
  return useQuery({
    queryKey: ["email-access", "policy"],
    queryFn: () => apiFetch<EmailAccessPolicy>("/email-access/policy")
  });
}

export function useUpdateEmailAccessPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<EmailAccessPolicy>) => 
      apiFetch<EmailAccessPolicy>("/email-access/policy", {
        method: "PUT",
        body: JSON.stringify(data)
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["email-access", "policy"] })
  });
}
