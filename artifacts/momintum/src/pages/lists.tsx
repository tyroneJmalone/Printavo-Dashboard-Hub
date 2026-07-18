import { useState } from "react";
import { Link } from "wouter";
import {
  useListLists, useListTasks, useCreateList, useListTeams,
  getListListsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, ListChecks, Lock, Globe, Users as UsersIcon } from "lucide-react";
import { useCurrentUser } from "@/lib/current-user";

const COLORS = ["#6DBE45", "#A64C96", "#2FADA8", "#5B6B99", "#C9B3DE", "#EF6F4E"];

export function Lists() {
  const { currentUser } = useCurrentUser();
  const { data: lists, isLoading } = useListLists();
  const { data: tasks } = useListTasks({ completed: false });
  const { data: teams } = useListTeams();
  const createList = useCreateList();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [visibility, setVisibility] = useState<"shared" | "personal" | `team-${number}`>("shared");

  const teamsById = new Map((teams || []).map((t) => [t.id, t]));

  if (isLoading) return <div>Loading...</div>;

  const visibleLists = (lists || []).filter(
    (list) => !list.ownerId || list.ownerId === currentUser?.id || currentUser?.isAdmin,
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const color = COLORS[(lists?.length || 0) % COLORS.length];
    const isTeam = visibility.startsWith("team-");
    const teamId = isTeam ? parseInt(visibility.replace("team-", ""), 10) : null;
    createList.mutate(
      {
        data: {
          name: name.trim(),
          color,
          ownerId: visibility === "personal" ? currentUser?.id ?? null : null,
          teamId: teamId ?? null,
        },
      },
      {
        onSuccess: () => {
          setName("");
          setVisibility("shared");
          setOpen(false);
          queryClient.invalidateQueries({ queryKey: getListListsQueryKey() });
        },
      },
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">Lists</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="w-4 h-4 mr-1" /> New List
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create a list</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-3">
              <Input placeholder="List name" value={name} onChange={(e) => setName(e.target.value)} />
              <Select value={visibility} onValueChange={(v) => setVisibility(v as typeof visibility)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shared">
                    <span className="flex items-center gap-2"><Globe className="w-3.5 h-3.5" />Shared (everyone)</span>
                  </SelectItem>
                  <SelectItem value="personal">
                    <span className="flex items-center gap-2"><Lock className="w-3.5 h-3.5" />Personal (only me)</span>
                  </SelectItem>
                  {(teams || []).map((t) => (
                    <SelectItem key={t.id} value={`team-${t.id}`}>
                      <span className="flex items-center gap-2">
                        <span className="w-3.5 h-3.5 rounded-full inline-block shrink-0" style={{ backgroundColor: t.color }} />
                        {t.name} only
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <DialogFooter>
                <Button type="submit" disabled={createList.isPending}>
                  Create
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {visibleLists.length === 0 && (
        <p className="text-muted-foreground text-sm">No lists yet. Create one to get started.</p>
      )}

      {(() => {
        const myLists = visibleLists.filter(
          (l) => !l.ownerId || l.ownerId === currentUser?.id,
        );
        const othersPrivateLists = currentUser?.isAdmin
          ? visibleLists.filter((l) => l.ownerId && l.ownerId !== currentUser?.id)
          : [];

        const renderListCard = (list: (typeof visibleLists)[number]) => {
          const activeCount = (tasks || []).filter((t) => t.listId === list.id).length;
          const isPersonal = !!list.ownerId;
          const team = list.teamId ? teamsById.get(list.teamId) : undefined;
          return (
            <Link key={list.id} href={`/lists/${list.id}`}>
              <Card className="cursor-pointer hover:border-primary/50 transition-colors">
                <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-2">
                  <div
                    className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
                    style={{ backgroundColor: `${list.color}20` }}
                  >
                    <ListChecks className="w-4 h-4" style={{ color: list.color }} />
                  </div>
                  <CardTitle className="text-base flex-1">{list.name}</CardTitle>
                  {isPersonal ? (
                    <div className="flex items-center gap-1 text-muted-foreground" title="Private list">
                      <Lock className="w-3.5 h-3.5" />
                    </div>
                  ) : team ? (
                    <div
                      className="flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium"
                      style={{ backgroundColor: `${team.color}20`, color: team.color }}
                      title={`Shared with ${team.name}`}
                    >
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: team.color }}
                      />
                      {team.name}
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 text-muted-foreground" title="Shared with everyone">
                      <Globe className="w-3.5 h-3.5" />
                    </div>
                  )}
                </CardHeader>
                <CardContent>
                  <span className="text-sm text-muted-foreground">
                    {activeCount} active task{activeCount === 1 ? "" : "s"}
                  </span>
                </CardContent>
              </Card>
            </Link>
          );
        };

        return (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {myLists.map(renderListCard)}
            </div>
            {othersPrivateLists.length > 0 && (
              <div>
                <div className="flex items-center gap-3 my-4">
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                    <Lock className="w-3 h-3" />
                    Team members' private lists
                  </span>
                  <div className="flex-1 h-px bg-border" />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 opacity-80">
                  {othersPrivateLists.map(renderListCard)}
                </div>
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}
