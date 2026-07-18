import { Task } from "@workspace/api-client-react";
import { useUpdateTask, useListMembers, getListTasksQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useOpenTaskDetail } from "@/components/tasks/task-detail";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

const PRIORITY_COLOR: Record<string, string> = {
  high: "bg-rose-500",
  medium: "bg-amber-400",
  low: "bg-sky-400",
};

interface WeekTaskChipProps {
  task: Task;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
}

export function WeekTaskChip({ task, selectionMode = false, selected = false, onToggleSelect }: WeekTaskChipProps) {
  const updateTask = useUpdateTask();
  const queryClient = useQueryClient();
  const openTaskDetail = useOpenTaskDetail();
  const { data: members } = useListMembers();
  const assignee = members?.find((m) => m.id === task.assigneeId);

  const toggleCompleted = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateTask.mutate(
      { id: task.id, data: { completed: !task.completed } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        },
      },
    );
  };

  const handleClick = () => {
    if (selectionMode) {
      onToggleSelect?.(task.id);
    } else {
      openTaskDetail(task.id);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={cn(
        "group flex items-center gap-1.5 rounded px-1.5 py-1 cursor-pointer transition-colors text-xs w-full overflow-hidden",
        selected
          ? "bg-primary/15 ring-1 ring-primary"
          : "hover:bg-accent",
        task.completed && "opacity-50",
      )}
    >
      {/* Priority stripe */}
      {task.priority && (
        <div className={cn("w-1 h-4 rounded-full shrink-0", PRIORITY_COLOR[task.priority] ?? "bg-muted")} />
      )}

      {/* Checkbox */}
      <div onClick={toggleCompleted} className="shrink-0">
        <Checkbox
          checked={task.completed}
          className="w-3.5 h-3.5 pointer-events-none"
        />
      </div>

      {/* Title — truncates */}
      <span
        className={cn(
          "flex-1 truncate font-medium leading-tight",
          task.completed && "line-through text-muted-foreground",
        )}
      >
        {task.title}
      </span>

      {/* Assignee avatar */}
      {assignee && (
        <div
          className="w-4 h-4 rounded-full shrink-0 flex items-center justify-center text-[9px] font-bold text-white"
          style={{ backgroundColor: assignee.color ?? "#9e4a95" }}
          title={assignee.name}
        >
          {assignee.name.slice(0, 1).toUpperCase()}
        </div>
      )}
    </div>
  );
}
