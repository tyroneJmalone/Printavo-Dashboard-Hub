import { useListTasks } from "@workspace/api-client-react";
import { TaskItem } from "@/components/tasks/task-item";
import { Search } from "lucide-react";

interface SearchPageProps {
  query: string;
}

export function SearchPage({ query }: SearchPageProps) {
  const trimmed = query.trim();
  const { data: tasks, isLoading } = useListTasks(
    { search: trimmed },
    { query: { enabled: trimmed.length > 0, queryKey: ["tasks", "search", trimmed] } },
  );

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center gap-2">
        <Search className="w-5 h-5 text-muted-foreground" />
        <h1 className="text-3xl font-bold text-foreground">
          {trimmed ? `Results for "${trimmed}"` : "Search"}
        </h1>
      </div>

      {!trimmed && (
        <p className="text-muted-foreground text-sm">Start typing in the search bar to find tasks.</p>
      )}

      {trimmed && isLoading && <div>Loading...</div>}

      {trimmed && !isLoading && (tasks?.length ?? 0) === 0 && (
        <p className="text-muted-foreground text-sm">No tasks match "{trimmed}".</p>
      )}

      {trimmed && !!tasks?.length && (
        <div className="space-y-1">
          {tasks.map((task) => (
            <TaskItem key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}
