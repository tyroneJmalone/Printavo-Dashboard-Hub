import { useState } from "react";
import {
  useListMembers,
  useCreateMember,
  useDeleteMember,
  useListTasks,
  useListTeams,
  useCreateTeam,
  useDeleteTeam,
  useAddTeamMember,
  useRemoveTeamMember,
  getListMembersQueryKey,
  getListTeamsQueryKey,
  useListQuotes,
  useCreateQuote,
  useDeleteQuote,
  getListQuotesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentUser } from "@/lib/current-user";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Mail, Trash2, Sparkles, Users, X, UsersRound } from "lucide-react";

const TEAM_COLORS = ["#2FADA8", "#9e4a95", "#6DBE45", "#FB923C", "#60A5FA", "#F472B6"];

const COLORS = ["#2DD4BF", "#A78BFA", "#FB923C", "#F472B6", "#60A5FA", "#34D399"];

export function Team() {
  const { currentUser } = useCurrentUser();
  const { data: members, isLoading } = useListMembers();
  const { data: tasks } = useListTasks({ completed: false });
  const { data: teams } = useListTeams();
  const createMember = useCreateMember();
  const deleteMember = useDeleteMember();
  const createTeam = useCreateTeam();
  const deleteTeam = useDeleteTeam();
  const addTeamMember = useAddTeamMember();
  const removeTeamMember = useRemoveTeamMember();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");

  const [memberToDelete, setMemberToDelete] = useState<{ id: number; name: string } | null>(null);

  const { data: quotes } = useListQuotes();
  const createQuote = useCreateQuote();
  const deleteQuote = useDeleteQuote();
  const [quoteText, setQuoteText] = useState("");
  const [quoteToDelete, setQuoteToDelete] = useState<{ id: number; text: string } | null>(null);

  const [teamOpen, setTeamOpen] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [teamColor, setTeamColor] = useState(TEAM_COLORS[0]);
  const [manageTeam, setManageTeam] = useState<{ id: number; name: string } | null>(null);
  const [addMemberId, setAddMemberId] = useState<string>("");
  const [teamToDelete, setTeamToDelete] = useState<{ id: number; name: string } | null>(null);

  if (isLoading) return <div>Loading...</div>;

  const isAdmin = !!currentUser?.isAdmin;

  const handleAddQuote = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quoteText.trim()) return;
    createQuote.mutate(
      { data: { text: quoteText.trim() } },
      {
        onSuccess: () => {
          setQuoteText("");
          queryClient.invalidateQueries({ queryKey: getListQuotesQueryKey() });
        },
      },
    );
  };

  const handleDeleteQuoteConfirm = () => {
    if (!quoteToDelete) return;
    deleteQuote.mutate(
      { id: quoteToDelete.id },
      {
        onSuccess: () => {
          setQuoteToDelete(null);
          queryClient.invalidateQueries({ queryKey: getListQuotesQueryKey() });
        },
      },
    );
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim()) return;
    const color = COLORS[(members?.length || 0) % COLORS.length];
    createMember.mutate(
      { data: { name: name.trim(), email: email.trim(), color } },
      {
        onSuccess: () => {
          setName("");
          setEmail("");
          setOpen(false);
          queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
        },
      },
    );
  };

  const handleCreateTeam = (e: React.FormEvent) => {
    e.preventDefault();
    if (!teamName.trim()) return;
    createTeam.mutate(
      { data: { name: teamName.trim(), color: teamColor } },
      {
        onSuccess: () => {
          setTeamName("");
          setTeamColor(TEAM_COLORS[0]);
          setTeamOpen(false);
          queryClient.invalidateQueries({ queryKey: getListTeamsQueryKey() });
        },
      },
    );
  };

  const handleAddMember = () => {
    if (!manageTeam || !addMemberId) return;
    addTeamMember.mutate(
      { id: manageTeam.id, memberId: parseInt(addMemberId, 10) },
      {
        onSuccess: () => {
          setAddMemberId("");
          queryClient.invalidateQueries({ queryKey: getListTeamsQueryKey() });
        },
      },
    );
  };

  const handleRemoveMember = (teamId: number, memberId: number) => {
    removeTeamMember.mutate(
      { id: teamId, memberId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTeamsQueryKey() });
        },
      },
    );
  };

  const handleDeleteTeamConfirm = () => {
    if (!teamToDelete) return;
    deleteTeam.mutate(
      { id: teamToDelete.id },
      {
        onSuccess: () => {
          setTeamToDelete(null);
          queryClient.invalidateQueries({ queryKey: getListTeamsQueryKey() });
        },
      },
    );
  };

  const handleDeleteConfirm = () => {
    if (!memberToDelete) return;
    deleteMember.mutate(
      { id: memberToDelete.id },
      {
        onSuccess: () => {
          setMemberToDelete(null);
          queryClient.invalidateQueries({ queryKey: getListMembersQueryKey() });
        },
      },
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">Team</h1>
        <div className="flex items-center gap-2">
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="w-4 h-4 mr-1" /> Add Member
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add team member</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-3">
                <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
                <Input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                <DialogFooter>
                  <Button type="submit" disabled={createMember.isPending}>
                    Add
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {(members || []).map((member) => {
          const activeCount = (tasks || []).filter((t) => t.assigneeId === member.id).length;
          const canDelete = isAdmin && member.id !== currentUser?.id;
          return (
            <Card key={member.id}>
              <CardHeader className="flex flex-row items-center gap-3 space-y-0">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold shrink-0"
                  style={{ backgroundColor: member.color }}
                >
                  {member.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <CardTitle className="text-base">{member.name}</CardTitle>
                  <div className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                    <Mail className="w-3 h-3 shrink-0" />
                    {member.email}
                  </div>
                </div>
                {canDelete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setMemberToDelete({ id: member.id, name: member.name })}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                <span className="text-sm text-muted-foreground">
                  {activeCount} active task{activeCount === 1 ? "" : "s"}
                </span>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <AlertDialog open={!!memberToDelete} onOpenChange={(o) => !o && setMemberToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {memberToDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove them from the team. Their tasks will remain but become unassigned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm} disabled={deleteMember.isPending}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
            <UsersRound className="w-5 h-5 text-[#2FADA8]" />
            Groups
          </h2>
          {isAdmin && (
            <Dialog open={teamOpen} onOpenChange={(o) => { setTeamOpen(o); if (!o) { setTeamName(""); setTeamColor(TEAM_COLORS[0]); } }}>
              <DialogTrigger asChild>
                <Button size="sm" variant="outline">
                  <Plus className="w-4 h-4 mr-1" /> New Group
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create a group</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleCreateTeam} className="space-y-4">
                  <Input
                    placeholder="Group name (e.g. Design, Dev, Marketing)"
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                  />
                  <div>
                    <p className="text-sm text-muted-foreground mb-2">Color</p>
                    <div className="flex gap-2 flex-wrap">
                      {TEAM_COLORS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          onClick={() => setTeamColor(c)}
                          className="w-7 h-7 rounded-full border-2 transition-all"
                          style={{
                            backgroundColor: c,
                            borderColor: teamColor === c ? c : "transparent",
                            boxShadow: teamColor === c ? `0 0 0 2px white, 0 0 0 4px ${c}` : undefined,
                          }}
                        />
                      ))}
                    </div>
                  </div>
                  <DialogFooter>
                    <Button type="submit" disabled={createTeam.isPending || !teamName.trim()}>
                      Create
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          )}
        </div>

        {(!teams || teams.length === 0) && (
          <p className="text-sm text-muted-foreground">
            {isAdmin ? "No groups yet. Create one to share lists or mention a whole team in comments." : "No groups have been set up yet."}
          </p>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(teams || []).map((team) => {
            const teamMembers = (members || []).filter((m) => team.memberIds.includes(m.id));
            const currentTeamForManage = manageTeam?.id === team.id ? team : null;
            return (
              <Card key={team.id} className="overflow-hidden">
                <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-2">
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0"
                    style={{ backgroundColor: team.color }}
                  >
                    {team.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base">{team.name}</CardTitle>
                    <p className="text-xs text-muted-foreground">{team.memberIds.length} member{team.memberIds.length === 1 ? "" : "s"}</p>
                  </div>
                  {isAdmin && (
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => setManageTeam(manageTeam?.id === team.id ? null : { id: team.id, name: team.name })}
                      >
                        <Users className="w-3.5 h-3.5 mr-1" />
                        {manageTeam?.id === team.id ? "Done" : "Manage"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-destructive"
                        onClick={() => setTeamToDelete({ id: team.id, name: team.name })}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  )}
                </CardHeader>
                <CardContent className="pt-0 pb-3">
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {teamMembers.map((m) => (
                      <div
                        key={m.id}
                        className="flex items-center gap-1 text-xs bg-muted rounded-full pl-1.5 pr-2 py-0.5"
                      >
                        <div
                          className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                          style={{ backgroundColor: m.color }}
                        >
                          {m.name.slice(0, 1).toUpperCase()}
                        </div>
                        <span>{m.name}</span>
                        {isAdmin && currentTeamForManage && (
                          <button
                            type="button"
                            onClick={() => handleRemoveMember(team.id, m.id)}
                            className="ml-0.5 text-muted-foreground hover:text-destructive"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    ))}
                    {teamMembers.length === 0 && (
                      <span className="text-xs text-muted-foreground italic">No members yet</span>
                    )}
                  </div>
                  {isAdmin && currentTeamForManage && (
                    <div className="flex gap-2 mt-2 pt-2 border-t border-border">
                      <Select value={addMemberId} onValueChange={setAddMemberId}>
                        <SelectTrigger className="h-8 text-xs flex-1">
                          <SelectValue placeholder="Add a member…" />
                        </SelectTrigger>
                        <SelectContent>
                          {(members || [])
                            .filter((m) => !team.memberIds.includes(m.id))
                            .map((m) => (
                              <SelectItem key={m.id} value={String(m.id)}>
                                {m.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <Button
                        size="sm"
                        className="h-8 text-xs"
                        onClick={handleAddMember}
                        disabled={!addMemberId || addTeamMember.isPending}
                      >
                        Add
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      <AlertDialog open={!!teamToDelete} onOpenChange={(o) => !o && setTeamToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group "{teamToDelete?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will delete the group. Lists shared with this group won't be deleted but will become visible to everyone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteTeamConfirm} disabled={deleteTeam.isPending}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="w-4 h-4 text-[#9e4a95]" />
              Banner Quotes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <form onSubmit={handleAddQuote} className="flex gap-2">
              <Input
                placeholder="Add a new motivational quote..."
                value={quoteText}
                onChange={(e) => setQuoteText(e.target.value)}
              />
              <Button type="submit" disabled={createQuote.isPending || !quoteText.trim()}>
                <Plus className="w-4 h-4 mr-1" /> Add
              </Button>
            </form>
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {(quotes || []).map((quote) => (
                <div
                  key={quote.id}
                  className="flex items-start justify-between gap-2 rounded-md border border-border px-3 py-2"
                >
                  <span className="text-sm text-foreground">{quote.text}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => setQuoteToDelete({ id: quote.id, text: quote.text })}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
              {quotes && quotes.length === 0 && (
                <p className="text-sm text-muted-foreground">No quotes yet. Add one above.</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <AlertDialog open={!!quoteToDelete} onOpenChange={(o) => !o && setQuoteToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this quote?</AlertDialogTitle>
            <AlertDialogDescription>"{quoteToDelete?.text}"</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteQuoteConfirm} disabled={deleteQuote.isPending}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
