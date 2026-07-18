import { useState } from "react";
import { useListTasks } from "@workspace/api-client-react";
import { TaskItem } from "@/components/tasks/task-item";
import { SortableTaskList } from "@/components/tasks/sortable-task-list";
import { SortSelect, sortTasksLocally, type SortByOption } from "@/components/tasks/sort-select";
import { BulkActionBar } from "@/components/tasks/bulk-action-bar";
import { Button } from "@/components/ui/button";
import { ListChecks } from "lucide-react";
import { isToday, isFuture, parseISO, format, isSameDay } from "date-fns";
import { useCurrentUser } from "@/lib/current-user";
import { useTaskSelection } from "@/hooks/use-task-selection";

export function Upcoming() {
  const { data: tasks, isLoading } = useListTasks({ completed: false });
  const [sortBy, setSortBy] = useState<SortByOption>("dueDate");
  const { members } = useCurrentUser();
  const { selecting, selectedIds, toggle, clear, startSelecting } = useTaskSelection();

  if (isLoading) return <div>Loading...</div>;

  const upcomingTasks = (tasks || []).filter(
    (t) => t.dueDate && !isToday(parseISO(t.dueDate)) && isFuture(parseISO(t.dueDate)),
  );

  const groups: { date: Date; tasks: typeof upcomingTasks }[] = [];
  for (const task of upcomingTasks) {
    const due = parseISO(task.dueDate!);
    const existing = groups.find((g) => isSameDay(g.date, due));
    if (existing) {
      existing.tasks.push(task);
    } else {
      groups.push({ date: due, tasks: [task] });
    }
  }
  groups.sort((a, b) => a.date.getTime() - b.date.getTime());
  for (const group of groups) {
    group.tasks = sortTasksLocally(group.tasks, sortBy === "dueDate" ? "manual" : sortBy, members);
  }

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold text-foreground">Upcoming</h1>
        <div className="flex items-center gap-2">
          <SortSelect value={sortBy} onChange={setSortBy} />
          {!selecting && (
            <Button variant="outline" size="sm" onClick={() => startSelecting()}>
              <ListChecks className="w-4 h-4 mr-1" /> Select
            </Button>
          )}
        </div>
      </div>

      {selecting && (
        <BulkActionBar selectedIds={Array.from(selectedIds)} onDone={clear} />
      )}

      {groups.length === 0 && (
        <p className="text-muted-foreground text-sm">No upcoming tasks scheduled.</p>
      )}

      {groups.map((group) => (
        <div key={group.date.toISOString()} className="space-y-2">
          <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-wider">
            {format(group.date, "EEEE, MMM d")}
          </h2>
          <SortableTaskList
            tasks={group.tasks}
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
      ))}
    </div>
  );
}
