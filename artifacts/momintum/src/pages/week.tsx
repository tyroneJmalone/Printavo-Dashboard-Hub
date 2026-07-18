import { useState } from "react";
import { useListTasks } from "@workspace/api-client-react";
import { WeekTaskChip } from "@/components/tasks/week-task-chip";
import { CreateTask } from "@/components/tasks/create-task";
import { BulkActionBar } from "@/components/tasks/bulk-action-bar";
import {
  startOfWeek,
  endOfWeek,
  addDays,
  addWeeks,
  subWeeks,
  format,
  isSameDay,
  isToday,
  parseISO,
} from "date-fns";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, ListChecks } from "lucide-react";
import { useTaskSelection } from "@/hooks/use-task-selection";
import { cn } from "@/lib/utils";

export function Week() {
  const [anchor, setAnchor] = useState(new Date());
  const { data: tasks, isLoading } = useListTasks({ completed: false });
  const { selecting, selectedIds, toggle, clear, startSelecting } = useTaskSelection();

  const weekStart = startOfWeek(anchor, { weekStartsOn: 0 });
  const weekEnd = endOfWeek(anchor, { weekStartsOn: 0 });
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  if (isLoading) return <div>Loading...</div>;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">Week</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setAnchor((d) => subWeeks(d, 1))}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm font-medium text-muted-foreground min-w-[160px] text-center">
            {format(weekStart, "MMM d")} – {format(weekEnd, "MMM d, yyyy")}
          </span>
          <Button variant="outline" size="icon" onClick={() => setAnchor((d) => addWeeks(d, 1))}>
            <ChevronRight className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
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

      <div className="grid grid-cols-1 md:grid-cols-7 gap-2">
        {days.map((day) => {
          const dayStr = format(day, "yyyy-MM-dd");
          const dayTasks = (tasks || []).filter(
            (t) => t.dueDate && isSameDay(parseISO(t.dueDate), day),
          );
          const today = isToday(day);
          return (
            <div
              key={day.toISOString()}
              className={cn(
                "flex flex-col rounded-lg border p-2 min-h-[160px] min-w-0 overflow-hidden",
                today ? "border-primary/40 bg-primary/5" : "border-border",
              )}
            >
              {/* Day header */}
              <div className={cn(
                "text-xs font-bold uppercase tracking-wider mb-2 shrink-0",
                today ? "text-primary" : "text-muted-foreground",
              )}>
                {format(day, "EEE d")}
              </div>

              {/* Task list — takes all available height */}
              <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                {dayTasks.map((task) => (
                  <WeekTaskChip
                    key={task.id}
                    task={task}
                    selectionMode={selecting}
                    selected={selectedIds.has(task.id)}
                    onToggleSelect={toggle}
                  />
                ))}
              </div>

              {/* Add task input, compact */}
              <div className="mt-2 shrink-0">
                <CreateTask dueDate={dayStr} placeholder="+" compact />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
