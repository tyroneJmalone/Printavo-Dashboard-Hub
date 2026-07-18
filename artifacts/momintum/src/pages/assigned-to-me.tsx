import { useState } from "react";
import { useListTasks } from "@workspace/api-client-react";
import { TaskItem } from "@/components/tasks/task-item";
import { SortableTaskList } from "@/components/tasks/sortable-task-list";
import { SortSelect, sortTasksLocally, type SortByOption } from "@/components/tasks/sort-select";
import { CreateTask } from "@/components/tasks/create-task";
import { BulkActionBar } from "@/components/tasks/bulk-action-bar";
import { Button } from "@/components/ui/button";
import { ListChecks, UserCheck } from "lucide-react";
import { useCurrentUser } from "@/lib/current-user";
import { useTaskSelection } from "@/hooks/use-task-selection";

export function AssignedToMe() {
  const { currentUser, members } = useCurrentUser();
  const { data: tasks, isLoading } = useListTasks(
    { assigneeId: currentUser?.id },
    { query: { enabled: !!currentUser?.id, queryKey: ["tasks", "assigned-to-me", currentUser?.id] } },
  );
  const [sortBy, setSortBy] = useState<SortByOption>("manual");
  const { selecting, selectedIds, toggle, clear, startSelecting } = useTaskSelection();

  if (isLoading || !currentUser) return <div>Loading...</div>;

  const active = sortTasksLocally((tasks ?? []).filter((t) => !t.completed), sortBy, members);
  const overdue = active.filter((t) => t.dueDate && new Date(t.dueDate) < new Date(new Date().toDateString()));
  const upcoming = active.filter((t) => !overdue.includes(t) && t.dueDate);
  const undated = active.filter((t) => !t.dueDate);

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <UserCheck className="w-6 h-6 text-muted-foreground" />
            <h1 className="text-3xl font-bold text-foreground">Assigned to Me</h1>
          </div>
          <div className="flex items-center gap-2">
            <SortSelect value={sortBy} onChange={setSortBy} />
            {!selecting && (
              <Button variant="outline" size="sm" onClick={() => startSelecting()}>
                <ListChecks className="w-4 h-4 mr-1" /> Select
              </Button>
            )}
          </div>
        </div>

        <div className="mb-4">
          <CreateTask assigneeId={currentUser.id} placeholder="Add a task assigned to me..." />
        </div>

        {selecting && (
          <BulkActionBar selectedIds={Array.from(selectedIds)} onDone={clear} />
        )}

        {overdue.length > 0 && (
          <div className="space-y-2 mb-6">
            <h2 className="text-sm font-bold uppercase tracking-wider text-destructive">Overdue</h2>
            <SortableTaskList
              tasks={overdue}
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
        )}

        {upcoming.length > 0 && (
          <div className="space-y-2 mb-6">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Scheduled</h2>
            <SortableTaskList
              tasks={upcoming}
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
        )}

        {undated.length > 0 && (
          <div className="space-y-2">
            <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">No due date</h2>
            <SortableTaskList
              tasks={undated}
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
        )}

        {active.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-12">No tasks assigned to you.</p>
        )}
      </div>
    </div>
  );
}
