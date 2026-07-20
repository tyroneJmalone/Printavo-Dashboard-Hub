import { useListTasks, useRestoreTask } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListTasksQueryKey } from "@workspace/api-client-react";
import { TaskItem } from "@/components/tasks/task-item";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import { TaskTitleWithPrintavoLink } from "@/components/tasks/printavo-order-link";
import { format } from "date-fns";

function RestoreButton({ taskId }: { taskId: number }) {
  const restore = useRestoreTask();
  const queryClient = useQueryClient();

  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground shrink-0"
      disabled={restore.isPending}
      onClick={() =>
        restore.mutate(
          { id: taskId },
          {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
            },
          },
        )
      }
    >
      <RotateCcw className="w-3 h-3 mr-1" />
      Restore
    </Button>
  );
}

export function Completed() {
  const { data: completedTasks, isLoading: loadingCompleted } = useListTasks({ completed: true });
  const { data: deletedTasks, isLoading: loadingDeleted } = useListTasks({ deleted: true });

  const isLoading = loadingCompleted || loadingDeleted;
  if (isLoading) return <div>Loading...</div>;

  const sortedCompleted = [...(completedTasks || [])].sort((a, b) => {
    const aTime = a.completedAt ? new Date(a.completedAt).getTime() : 0;
    const bTime = b.completedAt ? new Date(b.completedAt).getTime() : 0;
    return bTime - aTime;
  });

  const sortedDeleted = [...(deletedTasks || [])].sort((a, b) => {
    const aTime = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
    const bTime = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
    return bTime - aTime;
  });

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <h1 className="text-3xl font-bold text-foreground">Completed / Deleted</h1>

      {/* Completed */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="text-sm font-bold text-muted-foreground uppercase tracking-wider">
            Completed
          </div>
          <div className="text-xs text-muted-foreground">({sortedCompleted.length})</div>
        </div>

        {sortedCompleted.length === 0 ? (
          <p className="text-muted-foreground text-sm">No completed tasks yet.</p>
        ) : (
          <div className="space-y-1">
            {sortedCompleted.map((task) => (
              <TaskItem key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>

      {/* Deleted */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="text-sm font-bold text-muted-foreground uppercase tracking-wider">
            Deleted
          </div>
          <div className="text-xs text-muted-foreground">({sortedDeleted.length})</div>
        </div>

        {sortedDeleted.length === 0 ? (
          <p className="text-muted-foreground text-sm">No deleted tasks.</p>
        ) : (
          <div className="space-y-1">
            {sortedDeleted.map((task) => (
              <div key={task.id} className="flex items-center gap-2 group">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-muted-foreground line-through truncate">
                        <TaskTitleWithPrintavoLink title={task.title} notes={task.notes} />
                      </div>
                      {(task.deletedAt || task.listId) && (
                        <div className="text-xs text-muted-foreground/60 mt-0.5 flex items-center gap-3">
                          {task.deletedAt && (
                            <span>Deleted {format(new Date(task.deletedAt), "MMM d, yyyy")}</span>
                          )}
                        </div>
                      )}
                    </div>
                    <RestoreButton taskId={task.id} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
