import { ReactNode } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import { useUpdateTask } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListTasksQueryKey } from "@workspace/api-client-react";
import type { Task } from "@workspace/api-client-react";

interface SortableTaskItemProps {
  id: number;
  children: ReactNode;
}

function SortableTaskItem({ id, children }: SortableTaskItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="flex items-start group/sortable">
      <button
        type="button"
        className="mt-3 mr-1 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/40 opacity-0 group-hover/sortable:opacity-100 transition-opacity touch-none"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

interface SortableTaskListProps {
  tasks: Task[];
  enabled: boolean;
  renderItem: (task: Task) => ReactNode;
}

export function SortableTaskList({ tasks, enabled, renderItem }: SortableTaskListProps) {
  const updateTask = useUpdateTask();
  const queryClient = useQueryClient();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  if (!enabled) {
    return <div className="space-y-0.5">{tasks.map((task) => <div key={task.id}>{renderItem(task)}</div>)}</div>;
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = tasks.findIndex((t) => t.id === active.id);
    const newIndex = tasks.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(tasks, oldIndex, newIndex);
    const moved = reordered[newIndex];
    const before = reordered[newIndex - 1];
    const after = reordered[newIndex + 1];

    let newSortOrder: number;
    if (!before && after) {
      newSortOrder = after.sortOrder - 1000;
    } else if (before && !after) {
      newSortOrder = before.sortOrder + 1000;
    } else if (before && after) {
      newSortOrder = (before.sortOrder + after.sortOrder) / 2;
    } else {
      newSortOrder = 0;
    }

    queryClient.setQueriesData(
      { queryKey: getListTasksQueryKey() },
      (old: Task[] | undefined) =>
        old?.map((t) => (t.id === moved.id ? { ...t, sortOrder: newSortOrder } : t)),
    );

    updateTask.mutate(
      { id: moved.id, data: { sortOrder: newSortOrder } },
      {
        onSettled: () => {
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
        },
      },
    );
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-0.5">
          {tasks.map((task) => (
            <SortableTaskItem key={task.id} id={task.id}>
              {renderItem(task)}
            </SortableTaskItem>
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
