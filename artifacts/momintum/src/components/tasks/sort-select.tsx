import { ArrowUpDown } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type SortByOption = "manual" | "dueDate" | "priority" | "title" | "createdAt" | "assignee" | "tags";

const OPTIONS: { value: SortByOption; label: string }[] = [
  { value: "manual", label: "Manual (drag to reorder)" },
  { value: "dueDate", label: "Due date" },
  { value: "priority", label: "Priority" },
  { value: "title", label: "Title" },
  { value: "createdAt", label: "Date created" },
  { value: "assignee", label: "Assigned to" },
  { value: "tags", label: "Tags" },
];

interface SortSelectProps {
  value: SortByOption;
  onChange: (value: SortByOption) => void;
}

export function SortSelect({ value, onChange }: SortSelectProps) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as SortByOption)}>
      <SelectTrigger className="w-[190px] h-8 text-xs gap-2">
        <ArrowUpDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <SelectValue placeholder="Sort by" />
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function sortTasksLocally<T extends {
  dueDate?: string | null;
  priority: string;
  title: string;
  createdAt: string;
  sortOrder: number;
  assigneeId?: number | null;
  tags?: string[] | null;
}>(
  tasks: T[],
  sortBy: SortByOption,
  members: { id: number; name: string }[] = [],
): T[] {
  const list = [...tasks];
  switch (sortBy) {
    case "dueDate":
      return list.sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return a.sortOrder - b.sortOrder;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
      });
    case "priority": {
      const rank: Record<string, number> = { high: 0, medium: 1, low: 2, none: 3 };
      return list.sort((a, b) => (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3));
    }
    case "title":
      return list.sort((a, b) => a.title.localeCompare(b.title));
    case "createdAt":
      return list.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    case "assignee": {
      const nameOf = (id?: number | null) =>
        (id != null ? members.find((m) => m.id === id)?.name : undefined) ?? null;
      return list.sort((a, b) => {
        const aName = nameOf(a.assigneeId);
        const bName = nameOf(b.assigneeId);
        if (!aName && !bName) return a.sortOrder - b.sortOrder;
        if (!aName) return 1;
        if (!bName) return -1;
        return aName.localeCompare(bName);
      });
    }
    case "tags": {
      const firstTag = (t: T) =>
        t.tags && t.tags.length > 0 ? [...t.tags].sort((a, b) => a.localeCompare(b))[0] : null;
      return list.sort((a, b) => {
        const aTag = firstTag(a);
        const bTag = firstTag(b);
        if (!aTag && !bTag) return a.sortOrder - b.sortOrder;
        if (!aTag) return 1;
        if (!bTag) return -1;
        return aTag.localeCompare(bTag);
      });
    }
    case "manual":
    default:
      return list.sort((a, b) => a.sortOrder - b.sortOrder);
  }
}
