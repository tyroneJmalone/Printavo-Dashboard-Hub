import { useState, useCallback } from "react";
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
import { useListTasks, useListLists, useRestoreTask, getListTasksQueryKey, type Task } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import { TaskItem } from "@/components/tasks/task-item";
import { SortableTaskList } from "@/components/tasks/sortable-task-list";
import { SortSelect, sortTasksLocally, type SortByOption } from "@/components/tasks/sort-select";
import { CreateTask } from "@/components/tasks/create-task";
import { BulkActionBar } from "@/components/tasks/bulk-action-bar";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ListChecks, LayoutList, Layers, ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import { format } from "date-fns";
import { useCurrentUser } from "@/lib/current-user";
import { useTaskSelection } from "@/hooks/use-task-selection";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type GroupByOption = "dueDate" | "list" | "assignee" | "createdBy" | "tags" | "priority";

const GROUP_BY_LABELS: Record<GroupByOption, string> = {
  dueDate: "Due Date",
  list: "List",
  assignee: "Assigned To",
  createdBy: "Created By",
  tags: "Tags",
  priority: "Priority",
};

const PRIORITY_ORDER = ["high", "medium", "low", "none"];
const PRIORITY_LABELS: Record<string, string> = {
  high: "High Priority",
  medium: "Medium Priority",
  low: "Low Priority",
  none: "No Priority",
};
const PRIORITY_ACCENT: Record<string, string> = {
  high: "#f43f5e",
  medium: "#f59e0b",
  low: "#38bdf8",
  none: "#6b7280",
};

interface Group {
  key: string;
  label: string;
  tasks: Task[];
  accent?: string;
}

// ─── LocalStorage helpers ──────────────────────────────────────────────────────

const LS_GROUPBY   = "momintum-alltasks-groupby";
const LS_SORTBY    = "momintum-alltasks-sortby";
const lsCollapsed  = (g: GroupByOption) => `momintum-alltasks-collapsed-${g}`;
const lsOrder      = (g: GroupByOption) => `momintum-alltasks-order-${g}`;

function readLS<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw !== null ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writeLS(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// Merge a freshly-computed group key list with a saved order:
// saved keys stay in position, new keys are appended, deleted keys are dropped.
function mergeOrder(saved: string[], fresh: string[]): string[] {
  const freshSet = new Set(fresh);
  const kept = saved.filter((k) => freshSet.has(k));
  const added = fresh.filter((k) => !kept.includes(k));
  return [...kept, ...added];
}

// ─── Sortable group row ────────────────────────────────────────────────────────

interface SortableGroupProps {
  group: Group;
  collapsed: boolean;
  onToggle: (key: string) => void;
  sortBy: SortByOption;
  selecting: boolean;
  selectedIds: Set<number>;
  toggle: (id: number) => void;
}

function SortableGroup({
  group,
  collapsed,
  onToggle,
  sortBy,
  selecting,
  selectedIds,
  toggle,
}: SortableGroupProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: group.key });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="mb-6">
      {/* Header */}
      <div className="flex items-center gap-1 mb-2 group/groupheader">
        {/* Drag handle */}
        <button
          type="button"
          className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/30 opacity-0 group-hover/groupheader:opacity-100 transition-opacity touch-none p-0.5"
          aria-label="Drag to reorder group"
          {...attributes}
          {...listeners}
        >
          <GripVertical className="w-4 h-4" />
        </button>

        {/* Collapse toggle */}
        <button
          type="button"
          onClick={() => onToggle(group.key)}
          className="flex items-center gap-2 flex-1 text-left hover:text-foreground transition-colors py-0.5"
        >
          {collapsed
            ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
            : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />}

          {group.accent && (
            <div
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: group.accent }}
            />
          )}

          <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
            {group.label}
          </span>
          <span className="text-xs font-normal normal-case text-muted-foreground/50">
            ({group.tasks.length})
          </span>
        </button>
      </div>

      {/* Tasks */}
      {!collapsed && (
        <SortableTaskList
          tasks={group.tasks}
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
      )}
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function AllTasks() {
  const { data: tasks, isLoading } = useListTasks({ completed: false });
  const { data: completedTasks } = useListTasks({ completed: true });
  const { data: deletedTasks } = useListTasks({ deleted: true });
  const { data: lists } = useListLists();
  const queryClient = useQueryClient();
  const restore = useRestoreTask();

  const [completedOpen, setCompletedOpen] = useState(true);
  const [deletedOpen, setDeletedOpen] = useState(true);
  const { members } = useCurrentUser();
  const { selecting, selectedIds, toggle, clear, startSelecting } = useTaskSelection();

  const [groupBy, setGroupByState] = useState<GroupByOption>(
    () => readLS<GroupByOption>(LS_GROUPBY, "dueDate"),
  );
  const [sortBy, setSortByState] = useState<SortByOption>(
    () => readLS<SortByOption>(LS_SORTBY, "manual"),
  );

  const setGroupBy = (v: GroupByOption) => { setGroupByState(v); writeLS(LS_GROUPBY, v); };
  const setSortBy  = (v: SortByOption)  => { setSortByState(v);  writeLS(LS_SORTBY, v); };

  // Collapsed state per groupBy
  const [collapsedKeys, setCollapsedKeys] = useState<string[]>(
    () => readLS<string[]>(lsCollapsed(groupBy), []),
  );

  const handleChangeGroupBy = (v: GroupByOption) => {
    setGroupBy(v);
    setCollapsedKeys(readLS<string[]>(lsCollapsed(v), []));
    // order is loaded lazily inside buildGroups
  };

  const toggleCollapse = useCallback((key: string) => {
    setCollapsedKeys((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      writeLS(lsCollapsed(groupBy), next);
      return next;
    });
  }, [groupBy]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // ── Build fresh groups from data ───────────────────────────────────────────
  const sorted = sortTasksLocally(tasks ?? [], sortBy, members);

  const buildFreshGroups = (): Group[] => {
    switch (groupBy) {
      case "dueDate": return [
        { key: "scheduled",  label: "Scheduled",   tasks: sorted.filter((t) => t.dueDate) },
        { key: "none",       label: "No Due Date",  tasks: sorted.filter((t) => !t.dueDate) },
      ];

      case "list": {
        const map = new Map<string, Group>();
        for (const task of sorted) {
          const list = lists?.find((l) => l.id === task.listId);
          const key = list ? String(list.id) : "__none__";
          if (!map.has(key)) map.set(key, { key, label: list?.name ?? "No List", tasks: [], accent: list?.color ?? undefined });
          map.get(key)!.tasks.push(task);
        }
        return Array.from(map.values());
      }

      case "assignee": {
        const map = new Map<string, Group>();
        for (const task of sorted) {
          const m = members.find((m) => m.id === task.assigneeId);
          const key = m ? String(m.id) : "__none__";
          if (!map.has(key)) map.set(key, { key, label: m?.name ?? "Unassigned", tasks: [], accent: m?.color ?? undefined });
          map.get(key)!.tasks.push(task);
        }
        return Array.from(map.values());
      }

      case "createdBy": {
        const map = new Map<string, Group>();
        for (const task of sorted) {
          const m = members.find((m) => m.id === task.createdById);
          const key = m ? String(m.id) : "__none__";
          if (!map.has(key)) map.set(key, { key, label: m?.name ?? "Unknown", tasks: [], accent: m?.color ?? undefined });
          map.get(key)!.tasks.push(task);
        }
        return Array.from(map.values());
      }

      case "tags": {
        const map = new Map<string, Group>();
        const noTag: Task[] = [];
        for (const task of sorted) {
          const tags: string[] = (task.tags as string[] | null) ?? [];
          if (tags.length === 0) { noTag.push(task); continue; }
          for (const tag of tags) {
            if (!map.has(tag)) map.set(tag, { key: tag, label: tag, tasks: [] });
            map.get(tag)!.tasks.push(task);
          }
        }
        const groups = Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
        if (noTag.length > 0) groups.push({ key: "__none__", label: "No Tags", tasks: noTag });
        return groups;
      }

      case "priority":
        return PRIORITY_ORDER.map((p) => ({
          key: p,
          label: PRIORITY_LABELS[p] ?? p,
          tasks: sorted.filter((t) => (t.priority ?? "none") === p),
          accent: PRIORITY_ACCENT[p],
        }));

      default: return [];
    }
  };

  const freshGroups = buildFreshGroups();

  // Apply saved order, merging any new or removed groups
  const savedOrder = readLS<string[]>(lsOrder(groupBy), freshGroups.map((g) => g.key));
  const orderedKeys = mergeOrder(savedOrder, freshGroups.map((g) => g.key));
  const groupMap = new Map(freshGroups.map((g) => [g.key, g]));
  const groups = orderedKeys.map((k) => groupMap.get(k)).filter(Boolean) as Group[];

  // ── Group drag-end handler ─────────────────────────────────────────────────
  const handleGroupDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = groups.findIndex((g) => g.key === active.id);
    const newIdx = groups.findIndex((g) => g.key === over.id);
    if (oldIdx === -1 || newIdx === -1) return;
    const newOrder = arrayMove(groups, oldIdx, newIdx).map((g) => g.key);
    writeLS(lsOrder(groupBy), newOrder);
    // Force a re-render by updating a dummy piece of state via a workaround:
    // We can't set state here easily without a separate state var, so we'll
    // use a forced re-render key.
    setOrderVersion((v) => v + 1);
  };

  // Tiny counter to force re-render after group reorder (localStorage is the source of truth)
  const [orderVersion, setOrderVersion] = useState(0);
  void orderVersion; // suppress lint

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        {/* Page header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <LayoutList className="w-6 h-6 text-muted-foreground" />
            <h1 className="text-3xl font-bold text-foreground">All Tasks</h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5 text-muted-foreground" />
              <Select value={groupBy} onValueChange={(v) => handleChangeGroupBy(v as GroupByOption)}>
                <SelectTrigger className="h-8 text-xs w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(GROUP_BY_LABELS) as GroupByOption[]).map((opt) => (
                    <SelectItem key={opt} value={opt} className="text-xs">
                      {GROUP_BY_LABELS[opt]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <SortSelect value={sortBy} onChange={setSortBy} />
            {!selecting && (
              <Button variant="outline" size="sm" onClick={() => startSelecting()}>
                <ListChecks className="w-4 h-4 mr-1" /> Select
              </Button>
            )}
          </div>
        </div>

        <div className="mb-4">
          <CreateTask placeholder="Add a task..." />
        </div>

        {selecting && (
          <BulkActionBar selectedIds={Array.from(selectedIds)} onDone={clear} />
        )}

        {/* Sortable groups */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleGroupDragEnd}
        >
          <SortableContext
            items={groups.map((g) => g.key)}
            strategy={verticalListSortingStrategy}
          >
            {groups.map((group) => (
              <SortableGroup
                key={group.key}
                group={group}
                collapsed={collapsedKeys.includes(group.key)}
                onToggle={toggleCollapse}
                sortBy={sortBy}
                selecting={selecting}
                selectedIds={selectedIds}
                toggle={toggle}
              />
            ))}
          </SortableContext>
        </DndContext>

        {(tasks ?? []).length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-12">No tasks yet.</p>
        )}
      </div>

      {/* Completed */}
      {(completedTasks ?? []).length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setCompletedOpen((o) => !o)}
            className="flex items-center gap-2 mb-2 text-left hover:text-foreground transition-colors py-0.5 w-full"
          >
            {completedOpen
              ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
              : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />}
            <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Completed</span>
            <span className="text-xs font-normal normal-case text-muted-foreground/50">({completedTasks!.length})</span>
          </button>
          {completedOpen && (
            <div className="space-y-1">
              {[...(completedTasks ?? [])].sort((a, b) => {
                const at = a.completedAt ? new Date(a.completedAt).getTime() : 0;
                const bt = b.completedAt ? new Date(b.completedAt).getTime() : 0;
                return bt - at;
              }).map((task) => (
                <TaskItem key={task.id} task={task} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Deleted */}
      {(deletedTasks ?? []).length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setDeletedOpen((o) => !o)}
            className="flex items-center gap-2 mb-2 text-left hover:text-foreground transition-colors py-0.5 w-full"
          >
            {deletedOpen
              ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
              : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />}
            <span className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Deleted</span>
            <span className="text-xs font-normal normal-case text-muted-foreground/50">({deletedTasks!.length})</span>
          </button>
          {deletedOpen && (
            <div className="space-y-1">
              {[...(deletedTasks ?? [])].sort((a, b) => {
                const at = a.deletedAt ? new Date(a.deletedAt).getTime() : 0;
                const bt = b.deletedAt ? new Date(b.deletedAt).getTime() : 0;
                return bt - at;
              }).map((task) => (
                <div key={task.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-transparent hover:border-border hover:bg-muted/50 transition-all">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-muted-foreground line-through truncate">{task.title}</div>
                    {task.deletedAt && (
                      <div className="text-xs text-muted-foreground/50 mt-0.5">
                        Deleted {format(new Date(task.deletedAt), "MMM d, yyyy")}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground shrink-0"
                    disabled={restore.isPending}
                    onClick={() => restore.mutate(
                      { id: task.id },
                      { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() }) },
                    )}
                  >
                    <RotateCcw className="w-3 h-3 mr-1" />
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
