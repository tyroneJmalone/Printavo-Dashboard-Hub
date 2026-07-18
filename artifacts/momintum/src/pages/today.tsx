import { useState } from "react";
import { useListTasks } from "@workspace/api-client-react";
import { TaskItem } from "@/components/tasks/task-item";
import { SortableTaskList } from "@/components/tasks/sortable-task-list";
import { SortSelect, sortTasksLocally, type SortByOption } from "@/components/tasks/sort-select";
import { CreateTask } from "@/components/tasks/create-task";
import { BulkActionBar } from "@/components/tasks/bulk-action-bar";
import { Button } from "@/components/ui/button";
import { ListChecks } from "lucide-react";
import { useCurrentUser } from "@/lib/current-user";
import { useTaskSelection } from "@/hooks/use-task-selection";
import { isToday, isPast, parseISO } from "date-fns";

export function Today() {
  const { data: tasks, isLoading } = useListTasks({ completed: false });
  const [sortBy, setSortBy] = useState<SortByOption>("manual");
  const { members } = useCurrentUser();
  const { selecting, selectedIds, toggle, clear, startSelecting } = useTaskSelection();

  if (isLoading) return <div>Loading...</div>;

  const todayStr = new Date().toISOString().split('T')[0];

  const overdueTasks = sortTasksLocally(
    tasks?.filter(t => t.dueDate && isPast(parseISO(t.dueDate)) && !isToday(parseISO(t.dueDate))) || [],
    sortBy,
    members,
  );
  const todayTasks = sortTasksLocally(
    tasks?.filter(t => t.dueDate && isToday(parseISO(t.dueDate))) || [],
    sortBy,
    members,
  );

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-3xl font-bold text-foreground">Today</h1>
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
          <CreateTask dueDate={todayStr} placeholder="Add a task for today..." />
        </div>

        {selecting && (
          <BulkActionBar selectedIds={Array.from(selectedIds)} onDone={clear} />
        )}

        {overdueTasks.length > 0 && (
          <div className="mb-8 space-y-2">
            <h2 className="text-sm font-bold text-destructive uppercase tracking-wider">Overdue</h2>
            <SortableTaskList
              tasks={overdueTasks}
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

        <div className="space-y-2">
          <SortableTaskList
            tasks={todayTasks}
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
      </div>
    </div>
  );
}
