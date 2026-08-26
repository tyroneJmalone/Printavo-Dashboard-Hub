import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { 
  useEmailAccessGroups, 
  useCreateEmailAccessGroup, 
  useUpdateEmailAccessGroup, 
  useDeleteEmailAccessGroup,
  useEmailAccessPolicy,
  useUpdateEmailAccessPolicy,
  useEmailMailboxPolicies,
  useUpdateEmailMailboxPolicy,
  type EmailAccessPolicy
} from "@/hooks/use-email-access";
import { useCorrespondenceHistoryImport } from "@/hooks/use-correspondence";
import { ShieldCheck, ShieldAlert, Plus, Trash2, Settings2, Users, Loader2, DownloadCloud } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

const inputCls = "bg-[#1e293b] border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669] placeholder:text-slate-600 w-full";
const btnCls = "text-xs font-medium px-3 py-1.5 rounded-lg bg-[#059669] hover:bg-[#047857] text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5";

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-[#0f172a] border border-slate-800 rounded-xl p-5 ${className}`}>
      {children}
    </div>
  );
}

export default function EmailAccess() {
  const { data: groupsData, isLoading: groupsLoading } = useEmailAccessGroups();
  const { data: policy, isLoading: policyLoading } = useEmailAccessPolicy();
  const { data: mailboxData, isLoading: mailboxesLoading } = useEmailMailboxPolicies();
  const { toast } = useToast();

  const createGroup = useCreateEmailAccessGroup();
  const updateGroup = useUpdateEmailAccessGroup();
  const deleteGroup = useDeleteEmailAccessGroup();
  const updatePolicy = useUpdateEmailAccessPolicy();
  const importHistory = useCorrespondenceHistoryImport();
  const updateMailboxPolicy = useUpdateEmailMailboxPolicy();

  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [importEmails, setImportEmails] = useState("");

  const handleCreateGroup = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim()) return;
    createGroup.mutate({ name: newGroupName, description: newGroupDesc, mailboxes: [], members: [] }, {
      onSuccess: () => {
        setNewGroupName("");
        setNewGroupDesc("");
        toast({ title: "Access group created" });
      }
    });
  };

  const handlePolicySave = (newPolicy: Partial<EmailAccessPolicy>) => {
    updatePolicy.mutate(newPolicy, {
      onSuccess: () => toast({ title: "Policy updated" })
    });
  };

  return (
    <AppShell>
      <div className="p-4 lg:p-8 max-w-5xl mx-auto space-y-6">
        <div className="flex items-center gap-3 mb-2">
          <ShieldCheck size={20} className="text-[#10b981]" />
          <h1 className="text-xl font-semibold text-white">Email Access Control</h1>
        </div>
        <p className="text-sm text-slate-400">
          Manage who can search and view synced email correspondence across the organization.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <div className="flex items-center gap-2 mb-4">
                <ShieldCheck size={16} className="text-[#10b981]" />
                <h2 className="text-sm font-semibold text-slate-200">Mailbox Privacy</h2>
              </div>
              <p className="text-xs text-slate-500 mb-4">
                Mailboxes without a saved policy are private and unreadable. Admin access does not override these settings.
              </p>
              {mailboxesLoading ? (
                <div className="py-6 flex justify-center"><Loader2 className="animate-spin text-slate-500" /></div>
              ) : (
                <div className="space-y-3">
                  {mailboxData?.mailboxes.map((mailbox) => {
                    const current = mailbox.policy ?? {
                      ownerStaffId: null,
                      visibility: "private" as const,
                      protected: true,
                    };
                    const save = (next: Partial<typeof current>) =>
                      updateMailboxPolicy.mutate({
                        id: mailbox.id,
                        policy: { ...current, ...next },
                      });
                    return (
                      <div key={mailbox.id} className="grid grid-cols-1 md:grid-cols-[1fr_1fr_150px_auto] gap-3 items-center border border-slate-800 rounded-lg p-3">
                        <div>
                          <div className="text-sm text-slate-200">{mailbox.displayName || mailbox.email}</div>
                          <div className="text-[10px] text-slate-500">{mailbox.email}</div>
                        </div>
                        <select className={`${inputCls} py-1.5 text-xs`} value={current.ownerStaffId ?? ""} onChange={(e) => save({ ownerStaffId: e.target.value || null })}>
                          <option value="">No owner (unreadable)</option>
                          {mailboxData.staff.map((staff) => <option key={staff.id} value={staff.id}>{staff.email}</option>)}
                        </select>
                        <select className={`${inputCls} py-1.5 text-xs`} value={current.visibility} onChange={(e) => save({ visibility: e.target.value as typeof current.visibility })}>
                          <option value="private">Private</option>
                          <option value="group">Groups only</option>
                          <option value="workspace">Workspace</option>
                        </select>
                        <label className="flex items-center gap-2 text-xs text-slate-300">
                          <input type="checkbox" checked={current.protected} onChange={(e) => save({ protected: e.target.checked })} />
                          Protected
                        </label>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
            <Card>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Users size={16} className="text-[#10b981]" />
                  <h2 className="text-sm font-semibold text-slate-200">Access Groups</h2>
                </div>
              </div>
              
              {groupsLoading ? (
                <div className="py-8 flex justify-center"><Loader2 className="animate-spin text-slate-500" /></div>
              ) : (
                <div className="space-y-4">
                  {groupsData?.groups?.map(group => (
                    <div key={group.id} className="border border-slate-800 rounded-lg p-4 bg-slate-900/50">
                      <div className="flex justify-between items-start mb-3">
                        <div>
                          <h3 className="text-sm font-medium text-slate-200">{group.name}</h3>
                          <p className="text-xs text-slate-500 mt-0.5">{group.description}</p>
                        </div>
                        <button 
                          onClick={() => {
                            if (confirm("Delete this group?")) deleteGroup.mutate(group.id);
                          }}
                          className="text-slate-500 hover:text-red-400 p-1"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      <div className="grid grid-cols-2 gap-4 text-xs">
                        <div>
                          <label className="block text-slate-400 mb-1.5 uppercase tracking-wide text-[10px]">Mailboxes to Expose</label>
                          <input 
                            className={`${inputCls} py-1.5 text-xs`} 
                            placeholder="Comma-separated emails..." 
                            defaultValue={group.mailboxes?.join(", ")}
                            onBlur={(e) => {
                              const mailboxes = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
                              updateGroup.mutate({ id: group.id, data: { mailboxes } });
                            }}
                          />
                        </div>
                        <div>
                          <label className="block text-slate-400 mb-1.5 uppercase tracking-wide text-[10px]">Authorized Members</label>
                          <input 
                            className={`${inputCls} py-1.5 text-xs`} 
                            placeholder="Comma-separated emails..." 
                            defaultValue={group.members?.join(", ")}
                            onBlur={(e) => {
                              const members = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
                              updateGroup.mutate({ id: group.id, data: { members } });
                            }}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                  {(!groupsData?.groups || groupsData.groups.length === 0) && (
                    <div className="text-center py-6 text-sm text-slate-500 bg-slate-900/30 rounded-lg border border-slate-800 border-dashed">
                      No access groups configured.
                    </div>
                  )}
                </div>
              )}

              <form onSubmit={handleCreateGroup} className="mt-6 pt-6 border-t border-slate-800/80">
                <h4 className="text-xs font-semibold text-slate-300 mb-3 uppercase tracking-wide">Create New Group</h4>
                <div className="flex gap-3 items-start">
                  <div className="flex-1 space-y-3">
                    <input 
                      placeholder="Group Name (e.g., Sales Team)" 
                      className={inputCls} 
                      value={newGroupName}
                      onChange={e => setNewGroupName(e.target.value)}
                    />
                    <input 
                      placeholder="Description" 
                      className={inputCls}
                      value={newGroupDesc}
                      onChange={e => setNewGroupDesc(e.target.value)}
                    />
                  </div>
                  <button type="submit" disabled={!newGroupName.trim() || createGroup.isPending} className={`${btnCls} h-[42px]`}>
                    <Plus size={14} /> Add
                  </button>
                </div>
              </form>
            </Card>
          </div>

          <div className="space-y-6">
            <Card>
              <div className="flex items-center gap-2 mb-4">
                <Settings2 size={16} className="text-[#10b981]" />
                <h2 className="text-sm font-semibold text-slate-200">Global Policy</h2>
              </div>
              
              {policyLoading ? (
                <div className="py-4 flex justify-center"><Loader2 className="animate-spin text-slate-500" /></div>
              ) : policy ? (
                <div className="space-y-5">
                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-2">Default Access</label>
                     <div className={`${inputCls} text-slate-400`}>Deny by Default</div>
                    <p className="text-[10px] text-slate-500 mt-1.5 leading-relaxed">
                      If no group covers a mailbox, who can read its mail? "Deny by Default" means explicit groups are required.
                    </p>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-slate-300 mb-2">Data Retention (Days)</label>
                    <input 
                      type="number" 
                      className={inputCls} 
                      value={policy.retentionDays}
                      onChange={e => handlePolicySave({ retentionDays: parseInt(e.target.value) || 365 })}
                    />
                  </div>

                  <div className="flex items-start gap-3 p-3 bg-slate-900/50 rounded-lg border border-slate-800">
                    <input 
                      type="checkbox" 
                      id="aiProcessing"
                      className="mt-1"
                      checked={policy.aiProcessingEnabled}
                      onChange={e => handlePolicySave({ aiProcessingEnabled: e.target.checked })}
                    />
                    <label htmlFor="aiProcessing" className="text-xs text-slate-300">
                      <span className="font-medium text-slate-200 block mb-0.5">AI Processing Enabled</span>
                      <span className="text-slate-500">Allow AI features (like smart summaries and semantic search) to read synced emails.</span>
                    </label>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-red-400">Failed to load policy.</div>
              )}
            </Card>

            <Card className="border-amber-900/30 bg-amber-900/10">
              <div className="flex gap-2">
                <ShieldAlert size={16} className="text-amber-500 flex-shrink-0" />
                <div className="text-xs text-amber-500/80 leading-relaxed">
                  <strong className="text-amber-500 block mb-1">Security Note</strong>
                  Access groups only apply to Hub users. These settings do not change Google Workspace or Microsoft 365 permissions.
                </div>
              </div>
            </Card>

            <Card>
              <div className="flex items-center gap-2 mb-4">
                <DownloadCloud size={16} className="text-[#10b981]" />
                <h2 className="text-sm font-semibold text-slate-200">Historical Import</h2>
              </div>
              <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                Manually trigger an import of historical emails for specific mailboxes. This runs in the background.
              </p>
              <div className="space-y-3">
                <input 
                  placeholder="Comma-separated emails..." 
                  className={inputCls} 
                  value={importEmails}
                  onChange={e => setImportEmails(e.target.value)}
                />
                <button 
                  onClick={() => {
                    const emails = importEmails.split(",").map(e => e.trim()).filter(Boolean);
                    if (emails.length === 0) return;
                    importHistory.mutate({ emails }, {
                      onSuccess: () => {
                        setImportEmails("");
                        toast({ title: "Import job started" });
                      }
                    });
                  }}
                  disabled={!importEmails.trim() || importHistory.isPending}
                  className={btnCls}
                >
                  {importHistory.isPending ? "Starting..." : "Start Import"}
                </button>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </AppShell>
  );
}