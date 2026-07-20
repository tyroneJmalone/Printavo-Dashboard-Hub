import { createContext, useContext, useState, ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  useGetTask,
  useUpdateTask,
  useDeleteTask,
  useDuplicateTask,
  useListLists,
  useListMembers,
  useListTeams,
  useListComments,
  useCreateComment,
  useListSubtasks,
  useCreateSubtask,
  useUpdateSubtask,
  useDeleteSubtask,
  useGetTaskPrintavoLink,
  useSendTaskToPrintavo,
  getListTasksQueryKey,
  getGetDashboardSummaryQueryKey,
  getListSubtasksQueryKey,
  getGetTaskPrintavoLinkQueryKey,
  ApiError,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Send, Plus, X, Copy, UserCircle, ExternalLink, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { getPrintavoOrderUrl } from "@/components/tasks/printavo-order-link";
import { useCurrentUser } from "@/lib/current-user";
import { TagsInput } from "@/components/tasks/tags-input";
import { MentionInput } from "@/components/tasks/mention-input";
import type { Member } from "@workspace/api-client-react";

function renderCommentBody(body: string, members: Member[]) {
  const names = members
    .map((m) => m.name)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return body;

  const pattern = new RegExp(
    `@(${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );

  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body)) !== null) {
    if (match.index > lastIndex) {
      parts.push(body.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={match.index} className="text-[#9e4a95] font-semibold">
        {match[0]}
      </span>,
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < body.length) {
    parts.push(body.slice(lastIndex));
  }
  return parts;
}

const TaskDetailContext = createContext<((id: number) => void) | null>(null);

export function useOpenTaskDetail() {
  const ctx = useContext(TaskDetailContext);
  if (!ctx) {
    throw new Error("useOpenTaskDetail must be used within TaskDetailProvider");
  }
  return ctx;
}

export function TaskDetailProvider({ children }: { children: ReactNode }) {
  const [taskId, setTaskId] = useState<number | null>(null);

  return (
    <TaskDetailContext.Provider value={setTaskId}>
      {children}
      <TaskDetail taskId={taskId} onClose={() => setTaskId(null)} />
    </TaskDetailContext.Provider>
  );
}

interface TaskDetailProps {
  taskId: number | null;
  onClose: () => void;
}

function TaskDetail({ taskId, onClose }: TaskDetailProps) {
  const queryClient = useQueryClient();
  const { currentUser, members } = useCurrentUser();
  const { data: task } = useGetTask(taskId ?? 0, { query: { enabled: !!taskId, queryKey: ["task", taskId] } });
  const { data: lists } = useListLists();
  const { data: teamsData } = useListTeams();
  const { data: comments } = useListComments(taskId ?? 0, { query: { enabled: !!taskId, queryKey: ["task-comments", taskId] } });
  const { data: subtasks } = useListSubtasks(taskId ?? 0, { query: { enabled: !!taskId, queryKey: getListSubtasksQueryKey(taskId ?? 0) } });
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const createComment = useCreateComment();
  const createSubtask = useCreateSubtask();
  const updateSubtask = useUpdateSubtask();
  const deleteSubtask = useDeleteSubtask();
  const duplicateTask = useDuplicateTask();
  const { toast } = useToast();
  const { data: printavoLink } = useGetTaskPrintavoLink(taskId ?? 0, {
    query: { enabled: !!taskId, queryKey: getGetTaskPrintavoLinkQueryKey(taskId ?? 0) },
  });
  const sendToPrintavo = useSendTaskToPrintavo();
  const [commentBody, setCommentBody] = useState("");
  const [subtaskTitle, setSubtaskTitle] = useState("");
  const [newSubtaskAssigneeId, setNewSubtaskAssigneeId] = useState<string>("none");

  const creator = members.find((m) => m.id === task?.createdById);

  const invalidate = () => {
    if (!taskId) return;
    queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: ["task", taskId] });
  };

  const invalidateSubtasks = () => {
    if (!taskId) return;
    queryClient.invalidateQueries({ queryKey: getListSubtasksQueryKey(taskId) });
  };

  const handleAddSubtask = () => {
    if (!taskId || !subtaskTitle.trim()) return;
    createSubtask.mutate(
      {
        id: taskId,
        data: {
          title: subtaskTitle.trim(),
          assigneeId: newSubtaskAssigneeId !== "none" ? Number(newSubtaskAssigneeId) : null,
        },
      },
      {
        onSuccess: () => {
          setSubtaskTitle("");
          setNewSubtaskAssigneeId("none");
          invalidateSubtasks();
        },
      },
    );
  };

  const handleDuplicate = () => {
    if (!taskId) return;
    duplicateTask.mutate(
      { id: taskId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          onClose();
        },
      },
    );
  };

  const handleToggleSubtask = (subtaskId: number, completed: boolean) => {
    updateSubtask.mutate({ id: subtaskId, data: { completed } }, { onSuccess: invalidateSubtasks });
  };

  const handleDeleteSubtask = (subtaskId: number) => {
    deleteSubtask.mutate({ id: subtaskId }, { onSuccess: invalidateSubtasks });
  };

  const patch = (data: Parameters<typeof updateTask.mutate>[0]["data"]) => {
    if (!taskId) return;
    updateTask.mutate({ id: taskId, data }, { onSuccess: invalidate });
  };

  const handleSendToPrintavo = () => {
    if (!taskId) return;
    sendToPrintavo.mutate(
      { id: taskId },
      {
        onSuccess: (result) => {
          queryClient.invalidateQueries({
            queryKey: getGetTaskPrintavoLinkQueryKey(taskId),
          });
          toast({
            title: "Sent to Printavo",
            description: result.matchedAssignee
              ? "Task created and assigned in Printavo."
              : result.assigneeEmail
                ? `Task created unassigned — no Printavo user matches ${result.assigneeEmail}.`
                : "Task created unassigned in Printavo.",
          });
        },
        onError: (err) => {
          const data = err instanceof ApiError ? (err.data as { error?: string } | null) : null;
          toast({
            title: "Couldn't send to Printavo",
            description: data?.error ?? (err instanceof Error ? err.message : "Something went wrong."),
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleDelete = () => {
    if (!taskId) return;
    deleteTask.mutate(
      { id: taskId },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
          onClose();
        },
      },
    );
  };

  const handleAddComment = () => {
    if (!taskId || !commentBody.trim()) return;
    const lowerBody = commentBody.toLowerCase();
    const directMemberIds = members
      .filter((m) => lowerBody.includes(`@${m.name.toLowerCase()}`))
      .map((m) => m.id);
    const teamExpandedIds = (teamsData || [])
      .filter((t) => lowerBody.includes(`@${t.name.toLowerCase()}`))
      .flatMap((t) => t.memberIds);
    const mentionedMemberIds = [...new Set([...directMemberIds, ...teamExpandedIds])];

    createComment.mutate(
      {
        id: taskId,
        data: {
          body: commentBody.trim(),
          mentionedMemberIds,
        },
      },
      {
        onSuccess: () => {
          setCommentBody("");
          queryClient.invalidateQueries({ queryKey: ["task-comments", taskId] });
        },
      },
    );
  };

  return (
    <Dialog open={!!taskId} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        {task && (
          <>
            <DialogHeader>
              <div className="flex items-start gap-2">
                <DialogTitle className="flex-1">
                  <Input
                    defaultValue={task.title}
                    onBlur={(e) => {
                      if (e.target.value.trim() && e.target.value !== task.title) {
                        patch({ title: e.target.value.trim() });
                      }
                    }}
                    className="text-lg font-bold border-none shadow-none px-0 focus-visible:ring-0"
                  />
                </DialogTitle>
                <div className="flex items-center gap-1 shrink-0 pt-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    onClick={handleDuplicate}
                    disabled={duplicateTask.isPending}
                    title="Duplicate task"
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    onClick={handleDelete}
                    disabled={deleteTask.isPending}
                    title="Delete task"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            </DialogHeader>

            <div className="space-y-4">
              {(printavoLink?.linked ||
                (printavoLink?.available && !printavoLink.previouslyLinked && !task.completed) ||
                getPrintavoOrderUrl(task.notes)) && (
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {printavoLink?.linked ? (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <RefreshCw className="w-3 h-3 text-[#2baeae]" />
                      Synced with Printavo
                    </span>
                  ) : printavoLink?.available && !printavoLink.previouslyLinked && !task.completed ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={handleSendToPrintavo}
                      disabled={sendToPrintavo.isPending}
                    >
                      <Send className="w-3 h-3 mr-1.5" />
                      {sendToPrintavo.isPending ? "Sending…" : "Send to Printavo"}
                    </Button>
                  ) : null}
                  {getPrintavoOrderUrl(task.notes) && (
                    <a
                      href={getPrintavoOrderUrl(task.notes)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <ExternalLink className="w-3 h-3" />
                      Open order in Printavo
                    </a>
                  )}
                </div>
              )}
              <Textarea
                placeholder="Add notes..."
                defaultValue={task.notes ?? ""}
                onBlur={(e) => patch({ notes: e.target.value })}
              />

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">
                    {task.recurrence ? "Next occurrence" : "Due date"}
                  </label>
                  <Input
                    type="date"
                    defaultValue={task.dueDate ? format(new Date(task.dueDate), "yyyy-MM-dd") : ""}
                    onChange={(e) => patch({ dueDate: e.target.value || null })}
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Priority</label>
                  <Select value={task.priority} onValueChange={(v) => patch({ priority: v as typeof task.priority })}>
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
                    value={task.assigneeId ? String(task.assigneeId) : "none"}
                    onValueChange={(v) => patch({ assigneeId: v === "none" ? null : Number(v) })}
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
                    value={task.listId ? String(task.listId) : "none"}
                    onValueChange={(v) => patch({ listId: v === "none" ? null : Number(v) })}
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
                  <Select
                    value={task.recurrence ?? "none"}
                    onValueChange={(v) =>
                      patch({
                        recurrence: v === "none" ? null : (v as "daily" | "weekly" | "monthly"),
                      })
                    }
                  >
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
              </div>

              <div>
                <label className="text-xs font-medium text-muted-foreground">Tags</label>
                <TagsInput value={task.tags} onChange={(tags) => patch({ tags })} />
              </div>

              <div className="text-xs text-muted-foreground">
                Created by {creator?.name ?? "Unknown"} on {format(new Date(task.createdAt), "MMM d, yyyy")}
              </div>

              <div className="border-t pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-bold">Subtasks</h3>
                  {(subtasks?.length ?? 0) > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {subtasks!.filter((s) => s.completed).length}/{subtasks!.length} done
                    </span>
                  )}
                </div>
                <div className="space-y-1">
                  {(subtasks || []).map((s) => {
                    const subtaskAssignee = members.find((m) => m.id === s.assigneeId);
                    return (
                      <div key={s.id} className="group flex items-center gap-2">
                        <Checkbox
                          checked={s.completed}
                          onCheckedChange={(checked) => handleToggleSubtask(s.id, checked === true)}
                          className="w-4 h-4"
                        />
                        <span
                          className={cn(
                            "flex-1 text-sm",
                            s.completed && "line-through text-muted-foreground",
                          )}
                        >
                          {s.title}
                        </span>
                        <Select
                          value={s.assigneeId ? String(s.assigneeId) : "none"}
                          onValueChange={(v) =>
                            updateSubtask.mutate(
                              { id: s.id, data: { assigneeId: v === "none" ? null : Number(v) } },
                              { onSuccess: invalidateSubtasks },
                            )
                          }
                        >
                          <SelectTrigger
                            className={cn(
                              "h-6 text-xs border-dashed transition-opacity py-0 shrink-0",
                              subtaskAssignee ? "min-w-[5rem] opacity-100" : "min-w-[4.5rem] opacity-0 group-hover:opacity-60 focus:opacity-100",
                            )}
                          >
                            {subtaskAssignee ? (
                              <span className="flex items-center gap-1 truncate">
                                <span
                                  className="w-3.5 h-3.5 rounded-full text-[8px] font-bold text-white flex items-center justify-center shrink-0"
                                  style={{ backgroundColor: subtaskAssignee.color }}
                                >
                                  {subtaskAssignee.name.slice(0, 1)}
                                </span>
                                <span className="truncate">{subtaskAssignee.name.split(" ")[0]}</span>
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-muted-foreground">
                                <UserCircle className="w-3 h-3" />
                                Assign
                              </span>
                            )}
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
                        <button
                          type="button"
                          onClick={() => handleDeleteSubtask(s.id)}
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                          aria-label="Delete subtask"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    value={subtaskTitle}
                    onChange={(e) => setSubtaskTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        handleAddSubtask();
                      }
                    }}
                    placeholder="Add a subtask..."
                    className="h-8 text-sm flex-1"
                  />
                  <Select value={newSubtaskAssigneeId} onValueChange={setNewSubtaskAssigneeId}>
                    <SelectTrigger className="h-8 text-xs w-auto min-w-[6rem] shrink-0">
                      {newSubtaskAssigneeId !== "none" ? (
                        <span className="flex items-center gap-1 truncate">
                          <span
                            className="w-3.5 h-3.5 rounded-full text-[8px] font-bold text-white flex items-center justify-center shrink-0"
                            style={{ backgroundColor: members.find(m => String(m.id) === newSubtaskAssigneeId)?.color }}
                          >
                            {members.find(m => String(m.id) === newSubtaskAssigneeId)?.name.slice(0, 1)}
                          </span>
                          <span className="truncate">{members.find(m => String(m.id) === newSubtaskAssigneeId)?.name.split(" ")[0]}</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <UserCircle className="w-3 h-3" />
                          Assign
                        </span>
                      )}
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
                  <Button
                    size="icon"
                    variant="outline"
                    className="h-8 w-8 shrink-0"
                    onClick={handleAddSubtask}
                    disabled={!subtaskTitle.trim()}
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              <div className="border-t pt-4 space-y-3">
                <h3 className="text-sm font-bold">Comments</h3>
                <div className="space-y-3 max-h-48 overflow-y-auto">
                  {(comments || []).map((c) => {
                    const author = members.find((m) => m.id === c.authorId);
                    return (
                      <div key={c.id} className="text-sm">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{author?.name ?? "Unknown"}</span>
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(c.createdAt), "MMM d, h:mm a")}
                          </span>
                        </div>
                        <p className="text-muted-foreground whitespace-pre-wrap">
                          {renderCommentBody(c.body, members)}
                        </p>
                      </div>
                    );
                  })}
                  {(comments?.length ?? 0) === 0 && (
                    <p className="text-sm text-muted-foreground">No comments yet.</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    <MentionInput
                      placeholder="Write a comment... type @ to mention someone or a team"
                      value={commentBody}
                      onChange={setCommentBody}
                      onSubmit={handleAddComment}
                      members={members}
                      teams={(teamsData || []).map((t) => ({ id: t.id, name: t.name, color: t.color, memberIds: t.memberIds }))}
                    />
                  </div>
                  <Button size="icon" onClick={handleAddComment} disabled={!commentBody.trim()}>
                    <Send className="w-4 h-4" />
                  </Button>
                </div>
              </div>

              <div className="border-t pt-4 flex justify-end">
                <Button variant="ghost" size="sm" onClick={handleDelete} className="text-destructive">
                  <Trash2 className="w-4 h-4 mr-1" /> Delete task
                </Button>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
