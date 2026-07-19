import { useParams, Link } from "wouter";
import { useState } from "react";
import {
  useListLists,
  useListTasks,
  useDeleteList,
  useUpdateList,
  useListListGroups,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListListsQueryKey, getListTasksQueryKey } from "@workspace/api-client-react";
import { TaskItem } from "@/components/tasks/task-item";
import { SortableTaskList } from "@/components/tasks/sortable-task-list";
import { SortSelect, sortTasksLocally, type SortByOption } from "@/components/tasks/sort-select";
import { CreateTask } from "@/components/tasks/create-task";
import { BulkActionBar } from "@/components/tasks/bulk-action-bar";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Trash2, ListChecks, Globe, Lock, Folder } from "lucide-react";
import { useLocation } from "wouter";
import { useCurrentUser } from "@/lib/current-user";
import { useTaskSelection } from "@/hooks/use-task-selection";

export function ListDetail() {
  const { id } = useParams<{ id: string }>();
  const listId = Number(id);
  const { data: lists, isLoading: listsLoading } = useListLists();
  const { data: listGroups } = useListListGroups();
  const { data: tasks, isLoading: tasksLoading } = useListTasks({ listId });
  const deleteList = useDeleteList();
  const updateList = useUpdateList();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [sortBy, setSortBy] = useState<SortByOption>("manual");
  const { members, currentUser } = useCurrentUser();
  const { selecting, selectedIds, toggle, clear, startSelecting } = useTaskSelection();

  if (listsLoading || tasksLoading) return <div>Loading...</div>;

  const list = lists?.find((l) => l.id === listId);

  if (!list) {
    return (
      <div className="space-y-4">
        <Link href="/lists" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Back to Lists
        </Link>
        <p className="text-muted-foreground text-sm">List not found.</p>
      </div>
    );
  }

  const isShared = list.ownerId === null;
  const isOwnedByMe = list.ownerId === currentUser?.id;
  const canShare = currentUser?.isAdmin || isOwnedByMe || isShared;
  const canAddTasks = isShared || isOwnedByMe;

  const activeTasks = sortTasksLocally((tasks || []).filter((t) => !t.completed), sortBy, members);
  const completedTasks = (tasks || []).filter((t) => t.completed);

  const handleDelete = () => {
    deleteList.mutate(
      { id: listId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListListsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
          navigate("/lists");
        },
      },
    );
  };

  const handleToggleShare = () => {
    const newOwnerId = isShared ? (currentUser?.id ?? null) : null;
    updateList.mutate(
      { id: listId, data: { ownerId: newOwnerId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListListsQueryKey() });
        },
      },
    );
  };

  const sortedGroups = (listGroups || [])
    .slice()
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);

  const handleGroupChange = (value: string) => {
    updateList.mutate(
      { id: listId, data: { groupId: value === "none" ? null : Number(value) } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListListsQueryKey() });
        },
      },
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Link href="/lists" className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1">
        <ArrowLeft className="w-4 h-4" /> Back to Lists
      </Link>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-md flex items-center justify-center shrink-0"
            style={{ backgroundColor: `${list.color}20` }}
          >
            <ListChecks className="w-4 h-4" style={{ color: list.color }} />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-foreground">{list.name}</h1>
            <span className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
              {isShared
                ? <><Globe className="w-3 h-3" /> Shared with everyone</>
                : <><Lock className="w-3 h-3" /> Private</>}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {sortedGroups.length > 0 && (
            <Select
              value={list.groupId != null ? String(list.groupId) : "none"}
              onValueChange={handleGroupChange}
            >
              <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="List group">
                <Folder className="w-3.5 h-3.5 mr-1.5 shrink-0 opacity-60" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  <span className="text-muted-foreground">No group</span>
                </SelectItem>
                {sortedGroups.map((g) => (
                  <SelectItem key={g.id} value={String(g.id)}>
                    <span className="flex items-center gap-2">
                      <Folder className="w-3.5 h-3.5" style={{ color: g.color }} />
                      {g.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {canShare && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleShare}
              disabled={updateList.isPending}
            >
              {isShared
                ? <><Lock className="w-3.5 h-3.5 mr-1.5" /> Make private</>
                : <><Globe className="w-3.5 h-3.5 mr-1.5" /> Share</>}
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={handleDelete}>
            <Trash2 className="w-4 h-4 text-muted-foreground" />
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex justify-end gap-2">
          <SortSelect value={sortBy} onChange={setSortBy} />
          {!selecting && (
            <Button variant="outline" size="sm" onClick={() => startSelecting()}>
              <ListChecks className="w-4 h-4 mr-1" /> Select
            </Button>
          )}
        </div>

        {canAddTasks && (
          <div className="mb-4">
            <CreateTask listId={listId} placeholder="Add a task to this list..." />
          </div>
        )}
        {!canAddTasks && (
          <div className="mb-4 px-3 py-2 rounded-md bg-muted/50 border border-border text-sm text-muted-foreground flex items-center gap-2">
            <Lock className="w-3.5 h-3.5 shrink-0" />
            This is a private list — only the owner can add or edit tasks.
          </div>
        )}

        {selecting && (
          <BulkActionBar selectedIds={Array.from(selectedIds)} onDone={clear} />
        )}

        <SortableTaskList
          tasks={activeTasks}
          enabled={sortBy === "manual" && !selecting}
          renderItem={(task) => (
            <TaskItem
              task={task}
              selectionMode={selecting}
              selected={selectedIds.has(task.id)}
              onToggleSelect={toggle}
            />
          )}
        />
      </div>

      {completedTasks.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-wider">Completed</h2>
          <div className="space-y-1">
            {completedTasks.map((task) => (
              <TaskItem key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
