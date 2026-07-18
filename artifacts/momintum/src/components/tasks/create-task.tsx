import { useState } from "react";
import { useCreateTask, useListLists } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListTasksQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus } from "lucide-react";
import { useCurrentUser } from "@/lib/current-user";

interface CreateTaskProps {
  listId?: number;
  dueDate?: string;
  assigneeId?: number;
  placeholder?: string;
  compact?: boolean;
}

export function CreateTask({ listId, dueDate, assigneeId, placeholder = "Add a task...", compact = false }: CreateTaskProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [taskDueDate, setTaskDueDate] = useState(dueDate ?? "");
  const [priority, setPriority] = useState<"none" | "low" | "medium" | "high">("none");
  const [taskAssigneeId, setTaskAssigneeId] = useState<number | undefined>(assigneeId);
  const [taskListId, setTaskListId] = useState<number | undefined>(listId);
  const [tags, setTags] = useState("");
  const [recurrence, setRecurrence] = useState<"none" | "daily" | "weekly" | "monthly" | "yearly">("none");

  const createTask = useCreateTask();
  const queryClient = useQueryClient();
  const { data: lists } = useListLists();
  const { members } = useCurrentUser();

  const reset = () => {
    setTitle("");
    setNotes("");
    setTaskDueDate(dueDate ?? "");
    setPriority("none");
    setTaskAssigneeId(assigneeId);
    setTaskListId(listId);
    setTags("");
    setRecurrence("none" as const);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    createTask.mutate(
      {
        data: {
          title: title.trim(),
          notes: notes.trim() || undefined,
          listId: taskListId ?? null,
          dueDate: taskDueDate || null,
          assigneeId: taskAssigneeId ?? null,
          priority,
          tags: tags
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
          recurrence: recurrence === "none" ? null : recurrence,
        },
      },
      {
        onSuccess: () => {
          reset();
          setOpen(false);
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        },
      },
    );
  };

  return (
    <>
      {compact ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground py-1 rounded hover:bg-accent transition-colors"
        >
          <Plus className="w-3 h-3" />
          <span>{placeholder}</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full flex items-center gap-2 text-left text-muted-foreground hover:text-foreground py-2 border-b border-transparent hover:border-border transition-colors"
        >
          <Plus className="w-4 h-4" />
          <span className="text-base font-medium">{placeholder}</span>
        </button>
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) reset();
        }}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <form onSubmit={handleSubmit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>New task</DialogTitle>
            </DialogHeader>

            <Input
              autoFocus
              placeholder="Task title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="text-lg font-bold border-none shadow-none px-0 focus-visible:ring-0"
            />

            <Textarea
              placeholder="Add notes..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Due date</label>
                <Input
                  type="date"
                  value={taskDueDate}
                  onChange={(e) => setTaskDueDate(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Priority</label>
                <Select value={priority} onValueChange={(v) => setPriority(v as typeof priority)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="medium">Medium</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Assignee</label>
                <Select
                  value={taskAssigneeId ? String(taskAssigneeId) : "none"}
                  onValueChange={(v) => setTaskAssigneeId(v === "none" ? undefined : Number(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.id} value={String(m.id)}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">List</label>
                <Select
                  value={taskListId ? String(taskListId) : "none"}
                  onValueChange={(v) => setTaskListId(v === "none" ? undefined : Number(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Inbox</SelectItem>
                    {(lists || []).map((l) => (
                      <SelectItem key={l.id} value={String(l.id)}>
                        {l.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Repeat</label>
                <Select value={recurrence} onValueChange={(v) => setRecurrence(v as typeof recurrence)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Does not repeat</SelectItem>
                    <SelectItem value="daily">Daily</SelectItem>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="yearly">Yearly</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {recurrence !== "none" && (
                <div>
                  <label className="text-xs font-medium text-muted-foreground">First occurrence</label>
                  <Input
                    type="date"
                    value={taskDueDate}
                    onChange={(e) => setTaskDueDate(e.target.value)}
                    required
                  />
                </div>
              )}
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">Tags (comma separated)</label>
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="design, urgent" />
            </div>

            <div className="flex justify-end gap-2 border-t pt-4">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!title.trim() || createTask.isPending}>
                Create task
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
