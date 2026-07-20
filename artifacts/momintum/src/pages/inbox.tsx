import { useState } from "react";
import { useListTasks, useListMentions, useGetTask } from "@workspace/api-client-react";
import { TaskItem } from "@/components/tasks/task-item";
import { SortableTaskList } from "@/components/tasks/sortable-task-list";
import { SortSelect, sortTasksLocally, type SortByOption } from "@/components/tasks/sort-select";
import { CreateTask } from "@/components/tasks/create-task";
import { BulkActionBar } from "@/components/tasks/bulk-action-bar";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/lib/current-user";
import { useOpenTaskDetail } from "@/components/tasks/task-detail";
import { useTaskSelection } from "@/hooks/use-task-selection";
import { AtSign, ListChecks } from "lucide-react";
import { format } from "date-fns";

function MentionRow({ comment }: { comment: { id: number; taskId: number; body: string; createdAt: string; authorId: number | null } }) {
  const { members } = useCurrentUser();
  const openTask = useOpenTaskDetail();
  const { data: task } = useGetTask(comment.taskId, { query: { queryKey: ["task", comment.taskId] } });
  const author = members.find((m) => m.id === comment.authorId);

  return (
    <button
      onClick={() => openTask(comment.taskId)}
      className="w-full text-left flex items-start gap-3 p-3 rounded-md border border-border hover:bg-accent transition-colors"
    >
      <div
        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
        style={{ backgroundColor: author?.color || "#9e4a95" }}
      >
        {(author?.name || "?").slice(0, 1).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{author?.name ?? "Unknown"}</span>
          <span className="text-xs text-muted-foreground">
            {format(new Date(comment.createdAt), "MMM d, h:mm a")}
          </span>
        </div>
        <p className="text-sm text-muted-foreground line-clamp-2">{comment.body}</p>
        {task && (
          <p className="text-xs text-primary font-medium mt-1 truncate">on "{task.title}"</p>
        )}
      </div>
    </button>
  );
}

export function Inbox() {
  const { data: tasks, isLoading } = useListTasks({ completed: false });
  const { currentUser } = useCurrentUser();
  const { data: mentions } = useListMentions(
    { memberId: currentUser?.id ?? 0 },
    { query: { enabled: !!currentUser?.id, queryKey: ["mentions", currentUser?.id] } },
  );
  const [sortBy, setSortBy] = useState<SortByOption>("manual");
  const { members } = useCurrentUser();
  const { selecting, selectedIds, toggle, clear, startSelecting } = useTaskSelection();

  if (isLoading) return <div>Loading...</div>;

  // Synced Printavo tasks never belong in the inbox: private twins have no
  // list on purpose (they're routed, not "unsorted") and would flood admins.
  const inboxTasks = sortTasksLocally(
    tasks?.filter((t) => !t.listId && t.source !== "printavo") || [],
    sortBy,
    members,
  );

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {!!mentions?.length && (
        <div>
          <h2 className="text-lg font-bold mb-3 text-foreground flex items-center gap-2">
            <AtSign className="w-4 h-4 text-[#9e4a95]" /> Mentions
          </h2>
          <div className="space-y-2">
            {mentions.map((c) => (
              <MentionRow key={c.id} comment={c} />
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-3xl font-bold text-foreground">Inbox</h1>
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
          <CreateTask placeholder="Add a task to Inbox..." />
        </div>

        {selecting && (
          <BulkActionBar selectedIds={Array.from(selectedIds)} onDone={clear} />
        )}

        <div className="space-y-2">
          <SortableTaskList
            tasks={inboxTasks}
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
