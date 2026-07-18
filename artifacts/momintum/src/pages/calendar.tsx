import { useState } from "react";
import { useListTasks } from "@workspace/api-client-react";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  addDays,
  addMonths,
  subMonths,
  format,
  isSameDay,
  isSameMonth,
  isToday,
  parseISO,
} from "date-fns";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOpenTaskDetail } from "@/components/tasks/task-detail";

export function CalendarView() {
  const [anchor, setAnchor] = useState(new Date());
  const { data: tasks, isLoading } = useListTasks({ completed: false });
  const openTaskDetail = useOpenTaskDetail();

  const monthStart = startOfMonth(anchor);
  const monthEnd = endOfMonth(anchor);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 0 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 0 });

  const days: Date[] = [];
  let day = gridStart;
  while (day <= gridEnd) {
    days.push(day);
    day = addDays(day, 1);
  }

  if (isLoading) return <div>Loading...</div>;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-foreground">Calendar</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={() => setAnchor((d) => subMonths(d, 1))}>
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span className="text-sm font-medium text-muted-foreground min-w-[140px] text-center">
            {format(anchor, "MMMM yyyy")}
          </span>
          <Button variant="outline" size="icon" onClick={() => setAnchor((d) => addMonths(d, 1))}>
            <ChevronRight className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setAnchor(new Date())}>
            Today
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-xs font-bold text-muted-foreground uppercase tracking-wider">
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div key={d} className="text-center py-1">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {days.map((d) => {
          const dayTasks = (tasks || []).filter(
            (t) => t.dueDate && isSameDay(parseISO(t.dueDate), d),
          );
          return (
            <div
              key={d.toISOString()}
              className={cn(
                "border border-border rounded-md p-1.5 min-h-[90px] text-xs space-y-1",
                !isSameMonth(d, anchor) && "opacity-40 bg-muted/30",
              )}
            >
              <div
                className={cn(
                  "font-semibold",
                  isToday(d) && "inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary text-primary-foreground",
                )}
              >
                {format(d, "d")}
              </div>
              <div className="space-y-0.5">
                {dayTasks.slice(0, 3).map((task) => (
                  <div
                    key={task.id}
                    onClick={() => openTaskDetail(task.id)}
                    className="truncate rounded px-1 py-0.5 bg-primary/10 text-primary cursor-pointer hover:bg-primary/20"
                    title={task.title}
                  >
                    {task.title}
                  </div>
                ))}
                {dayTasks.length > 3 && (
                  <div className="text-muted-foreground">+{dayTasks.length - 3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
