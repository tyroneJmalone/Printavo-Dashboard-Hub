import { useState } from "react";
import {
  useListStaff,
  getListStaffQueryKey,
  useAddStaff,
  useUpdateStaffRole,
  useRemoveStaff,
  type StaffMember,
  type StaffMemberRole,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useStaff } from "@/components/auth/StaffGate";
import { Users, Loader2, UserPlus, Trash2, ShieldCheck } from "lucide-react";

function apiError(err: unknown): string | undefined {
  const e = err as { data?: { error?: string }; message?: string } | undefined;
  return e?.data?.error ?? e?.message;
}

const inputCls =
  "bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669] placeholder:text-slate-600";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function StaffAccessCard() {
  const me = useStaff();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useListStaff({
    query: { queryKey: getListStaffQueryKey() },
  });

  const [newEmail, setNewEmail] = useState("");
  const [newRole, setNewRole] = useState<StaffMemberRole>("staff");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListStaffQueryKey() });

  const add = useAddStaff({
    mutation: {
      onSuccess: (created) => {
        invalidate();
        setNewEmail("");
        setNewRole("staff");
        toast({
          title: "Staff member added",
          description: `${created.email} can now sign in with Google.`,
        });
      },
      onError: (err) =>
        toast({
          title: "Couldn't add staff member",
          description: apiError(err) ?? "Add failed",
          variant: "destructive",
        }),
    },
  });

  const updateRole = useUpdateStaffRole({
    mutation: {
      onSuccess: (updated) => {
        invalidate();
        toast({
          title: "Role updated",
          description: `${updated.email} is now ${updated.role === "admin" ? "an admin" : "staff"}.`,
        });
      },
      onError: (err) => {
        invalidate();
        toast({
          title: "Couldn't change role",
          description: apiError(err) ?? "Update failed",
          variant: "destructive",
        });
      },
    },
  });

  const remove = useRemoveStaff({
    mutation: {
      onSuccess: () => {
        invalidate();
        setConfirmingId(null);
        toast({ title: "Staff member removed" });
      },
      onError: (err) => {
        setConfirmingId(null);
        toast({
          title: "Couldn't remove staff member",
          description: apiError(err) ?? "Remove failed",
          variant: "destructive",
        });
      },
    },
  });

  const emailValid = EMAIL_RE.test(newEmail.trim());

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailValid || add.isPending) return;
    add.mutate({ data: { email: newEmail.trim().toLowerCase(), role: newRole } });
  };

  const staff = data?.staff ?? [];

  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-2.5">
        <Users size={16} className="text-[#10b981]" />
        <div>
          <div className="text-sm font-semibold text-slate-100">Staff access</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Who can sign in to Printavo Hub. Admins can manage this list and
            change the admin PIN.
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 size={18} className="animate-spin text-slate-500" />
        </div>
      ) : (
        <ul className="divide-y divide-slate-800/70">
          {staff.map((member: StaffMember) => {
            const isSelf = member.email === me.email;
            const confirming = confirmingId === member.id;
            return (
              <li key={member.id} className="px-5 py-3 flex items-center gap-3">
                <span
                  className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                    member.linked ? "bg-emerald-500" : "bg-slate-600"
                  }`}
                  title={member.linked ? "Has signed in" : "Hasn't signed in yet"}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-200 font-medium truncate">
                      {member.email}
                    </span>
                    {isSelf && (
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-[#10b981] bg-[#059669]/10 border border-[#059669]/30 rounded px-1.5 py-0.5">
                        you
                      </span>
                    )}
                    {member.role === "admin" && (
                      <ShieldCheck size={13} className="text-amber-400 flex-shrink-0" />
                    )}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    {member.linked ? "Signed in before" : "Never signed in"}
                    {member.addedByEmail ? ` · added by ${member.addedByEmail}` : ""}
                  </div>
                </div>
                <select
                  className={`${inputCls} py-1.5 text-xs`}
                  value={member.role}
                  disabled={updateRole.isPending}
                  onChange={(e) =>
                    updateRole.mutate({
                      id: member.id,
                      data: { role: e.target.value as StaffMemberRole },
                    })
                  }
                >
                  <option value="staff">Staff</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
                {isSelf ? (
                  <span className="w-[70px]" />
                ) : confirming ? (
                  <button
                    type="button"
                    onClick={() => remove.mutate({ id: member.id })}
                    disabled={remove.isPending}
                    className="w-[70px] text-xs font-semibold px-2 py-1.5 rounded-lg bg-red-500/15 border border-red-500/40 text-red-400 hover:bg-red-500/25 transition-colors disabled:opacity-50"
                  >
                    {remove.isPending ? "…" : "Sure?"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingId(member.id)}
                    className="w-[70px] flex items-center justify-center gap-1 text-xs font-medium px-2 py-1.5 rounded-lg border border-slate-700 text-slate-400 hover:text-red-400 hover:border-red-500/40 transition-colors"
                  >
                    <Trash2 size={12} /> Remove
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form
        onSubmit={onAdd}
        className="px-5 py-4 border-t border-slate-800 flex items-center gap-3"
      >
        <input
          className={`${inputCls} flex-1`}
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="coworker@mintprintworks.com"
        />
        <select
          className={inputCls}
          value={newRole}
          onChange={(e) => setNewRole(e.target.value as StaffMemberRole)}
        >
          <option value="staff">Staff</option>
          <option value="manager">Manager</option>
          <option value="admin">Admin</option>
        </select>
        <button
          type="submit"
          disabled={!emailValid || add.isPending}
          className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2 rounded-lg bg-[#059669]/10 border border-[#059669]/30 text-[#10b981] hover:bg-[#059669]/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {add.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <UserPlus size={13} />
          )}
          Add
        </button>
      </form>
    </div>
  );
}
