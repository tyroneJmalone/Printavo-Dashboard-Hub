import { useState } from "react";
import { Task } from "@workspace/api-client-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Calendar, Flag, User as UserIcon, Repeat, ListChecks } from "lucide-react";
import { format, isPast, isToday, isTomorrow } from "date-fns";
import { useUpdateTask, useDeleteTask, useListLists, useListMembers, useListSubtasks, getListSubtasksQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListTasksQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { useOpenTaskDetail } from "@/components/tasks/task-detail";
import { QuickEditControls } from "@/components/tasks/quick-edit-controls";
import { TaskTitleWithPrintavoLink } from "@/components/tasks/printavo-order-link";
import { usePrintavoSyncGuard, isGuardedEdit } from "@/components/tasks/printavo-sync-guard";

interface TaskItemProps {
  task: Task;
  selectionMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: number) => void;
}

export function TaskItem({ task, selectionMode = false, selected = false, onToggleSelect }: TaskItemProps) {
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const queryClient = useQueryClient();
  const openTaskDetail = useOpenTaskDetail();
  const { data: lists } = useListLists();
  const { data: members } = useListMembers();
  const { data: subtasks } = useListSubtasks(task.id, { query: { queryKey: getListSubtasksQueryKey(task.id) } });
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(task.title);

  const list = lists?.find(l => l.id === task.listId);
  const assignee = members?.find(m => m.id === task.assigneeId);
  const creator = members?.find(m => m.id === task.createdById);
  const subtaskDoneCount = subtasks?.filter((s) => s.completed).length ?? 0;

  const confirmSyncGuard = usePrintavoSyncGuard();

  const toggleCompleted = () => {
    const run = () =>
      updateTask.mutate(
        { id: task.id, data: { completed: !task.completed } },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          }
        }
      );
    if (task.printavoLinked) {
      confirmSyncGuard({ action: task.completed ? "reopen" : "complete", onConfirm: run });
    } else {
      run();
    }
  };

  const quickPatch = (data: Record<string, unknown>) => {
    const run = () =>
      updateTask.mutate(
        { id: task.id, data },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          }
        }
      );
    if (task.printavoLinked && isGuardedEdit(data)) {
      confirmSyncGuard({ action: "edit", onConfirm: run });
    } else {
      run();
    }
  };

  const handleDelete = () => {
    const run = () =>
      deleteTask.mutate(
        { id: task.id },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          },
        },
      );
    if (task.printavoLinked) {
      confirmSyncGuard({ action: "delete", onConfirm: run });
    } else {
      run();
    }
  };

  const commitTitle = () => {
    setEditingTitle(false);
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== task.title) {
      quickPatch({ title: trimmed });
    } else {
      setTitleDraft(task.title);
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'text-destructive';
      case 'medium': return 'text-orange-500';
      case 'low': return 'text-blue-500';
      default: return 'text-muted-foreground';
    }
  };

  const formatDueDate = (dateString: string | null) => {
    if (!dateString) return null;
    const date = new Date(dateString);
    if (isToday(date)) return "Today";
    if (isTomorrow(date)) return "Tomorrow";
    return format(date, "MMM d");
  };

  const isOverdue = task.dueDate && isPast(new Date(task.dueDate)) && !isToday(new Date(task.dueDate));

  return (
    <div
      draggable={!selectionMode}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/momintum-task-id", String(task.id));
        e.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "group flex items-start gap-3 p-2 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all",
        selectionMode ? "cursor-pointer" : "cursor-grab active:cursor-grabbing",
        selected && "bg-primary/5 border-primary/30",
        task.completed && "opacity-60"
      )}
      onClick={selectionMode ? () => onToggleSelect?.(task.id) : undefined}
    >
      {selectionMode ? (
        <div className="pt-0.5">
          <Checkbox
            checked={selected}
            onCheckedChange={() => onToggleSelect?.(task.id)}
            className="w-5 h-5"
          />
        </div>
      ) : (
        <div className="pt-0.5">
          <Checkbox 
            checked={task.completed} 
            onCheckedChange={toggleCompleted}
            className="rounded-full w-5 h-5"
          />
        </div>
      )}
      <div
        className="flex-1 min-w-0 cursor-pointer"
        onClick={selectionMode ? undefined : (editingTitle ? undefined : () => openTaskDetail(task.id))}
      >
        <div className="flex items-baseline gap-3">
          {editingTitle ? (
            <Input
              autoFocus
              value={titleDraft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTitle();
                } else if (e.key === "Escape") {
                  setTitleDraft(task.title);
                  setEditingTitle(false);
                }
              }}
              className="h-6 text-sm font-medium py-0 px-1 shrink-0 w-auto min-w-[120px]"
            />
          ) : (
            <div
              className={cn(
                "text-sm font-medium transition-all shrink-0",
                task.completed && "line-through text-muted-foreground",
                !selectionMode && "hover:underline decoration-dotted"
              )}
              onClick={(e) => {
                if (selectionMode) return;
                e.stopPropagation();
                setTitleDraft(task.title);
                setEditingTitle(true);
              }}
            >
              <TaskTitleWithPrintavoLink title={task.title} notes={task.notes} />
            </div>
          )}
          {task.notes && (
            <div className="text-xs text-muted-foreground/70 italic truncate min-w-0">
              {task.notes}
            </div>
          )}
          {task.recurrence && (
            <span title={`Repeats ${task.recurrence}`}>
              <Repeat className="w-3 h-3 text-muted-foreground/70 shrink-0" />
            </span>
          )}
          {(subtasks?.length ?? 0) > 0 && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground/70 shrink-0" title="Subtasks">
              <ListChecks className="w-3 h-3" />
              {subtaskDoneCount}/{subtasks!.length}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 mt-1 text-xs text-muted-foreground">
          <div className="flex flex-wrap items-center gap-3">
            {task.dueDate && (
              <span className={cn(
                "flex items-center gap-1 text-pink-500",
                !task.completed && "font-medium"
              )}>
                <Calendar className="w-3 h-3" />
                Due {formatDueDate(task.dueDate)}
              </span>
            )}

            {task.dueDate && assignee && (
              <span className="flex items-center gap-1 text-pink-500 font-medium">
                <UserIcon className="w-3 h-3" />
                Assigned to {assignee.name}
              </span>
            )}

            {task.createdAt && (
              <span className="flex items-center gap-1 text-amber-500">
                Created {format(new Date(task.createdAt), "MMM d")}
              </span>
            )}

            {creator && (
              <span className="flex items-center gap-1 text-amber-500">
                <UserIcon className="w-3 h-3" />
                by {creator.name}
              </span>
            )}

            {task.priority !== 'none' && (
              <span className={cn("flex items-center gap-1", getPriorityColor(task.priority))}>
                <Flag className="w-3 h-3" />
                {task.priority}
              </span>
            )}

            {assignee && !task.dueDate && (
              <span className="flex items-center gap-1 text-pink-500 font-medium">
                <UserIcon className="w-3 h-3" />
                Assigned to {assignee.name}
              </span>
            )}
          </div>

          {(list || task.tags.length > 0) && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {list && (
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: list.color }} />
                  {list.name}
                </span>
              )}
              {task.tags.length > 0 && (
                <span className="flex items-center gap-1 flex-wrap">
                  {task.tags.map((tag) => (
                    <span
                      key={tag}
                      className="px-1.5 py-0.5 rounded-full bg-muted text-[10px] leading-none text-muted-foreground"
                    >
                      #{tag}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {!selectionMode && <QuickEditControls task={task} onPatch={quickPatch} onDelete={handleDelete} />}
    </div>
  );
}
