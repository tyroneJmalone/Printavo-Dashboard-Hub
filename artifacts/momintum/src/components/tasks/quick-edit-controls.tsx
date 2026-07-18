import { useState } from "react";
import { Task, useListLists, useListMembers } from "@workspace/api-client-react";
import { Calendar as CalendarIcon, Flag, User as UserIcon, ListTodo, Tag as TagIcon, StickyNote, Trash2 } from "lucide-react";
import { format } from "date-fns";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { TagsInput } from "@/components/tasks/tags-input";
import { cn } from "@/lib/utils";

interface QuickEditControlsProps {
  task: Task;
  onPatch: (data: Record<string, unknown>) => void;
  onDelete?: () => void;
}

const PRIORITIES: Array<{ value: Task["priority"]; label: string; color: string }> = [
  { value: "none", label: "None", color: "text-muted-foreground" },
  { value: "low", label: "Low", color: "text-blue-500" },
  { value: "medium", label: "Medium", color: "text-orange-500" },
  { value: "high", label: "High", color: "text-destructive" },
];

export function QuickEditControls({ task, onPatch, onDelete }: QuickEditControlsProps) {
  const { data: lists } = useListLists();
  const { data: members } = useListMembers();
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState(task.notes ?? "");

  const iconBtn = "p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors";

  return (
    <div
      className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0"
      onClick={(e) => e.stopPropagation()}
    >
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={iconBtn} title="Set due date">
            <CalendarIcon className="w-3.5 h-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={task.dueDate ? new Date(task.dueDate) : undefined}
            onSelect={(date) => onPatch({ dueDate: date ? date.toISOString() : null })}
          />
          {task.dueDate && (
            <div className="p-2 border-t">
              <Button variant="ghost" size="sm" className="w-full" onClick={() => onPatch({ dueDate: null })}>
                Clear date
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={iconBtn} title="Set priority">
            <Flag className="w-3.5 h-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-40 p-1" align="start">
          {PRIORITIES.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => onPatch({ priority: p.value })}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted text-left",
                task.priority === p.value && "bg-muted",
              )}
            >
              <Flag className={cn("w-3.5 h-3.5", p.color)} />
              {p.label}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={iconBtn} title="Assign to">
            <UserIcon className="w-3.5 h-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1" align="start">
          <button
            type="button"
            onClick={() => onPatch({ assigneeId: null })}
            className={cn(
              "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted text-left",
              !task.assigneeId && "bg-muted",
            )}
          >
            Unassigned
          </button>
          {(members || []).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onPatch({ assigneeId: m.id })}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted text-left",
                task.assigneeId === m.id && "bg-muted",
              )}
            >
              {m.name}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={iconBtn} title="Move to list">
            <ListTodo className="w-3.5 h-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-48 p-1" align="start">
          <button
            type="button"
            onClick={() => onPatch({ listId: null })}
            className={cn(
              "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted text-left",
              !task.listId && "bg-muted",
            )}
          >
            Inbox
          </button>
          {(lists || []).map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => onPatch({ listId: l.id })}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted text-left",
                task.listId === l.id && "bg-muted",
              )}
            >
              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
              {l.name}
            </button>
          ))}
        </PopoverContent>
      </Popover>

      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={iconBtn} title="Edit tags">
            <TagIcon className="w-3.5 h-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64" align="start">
          <TagsInput value={task.tags} onChange={(tags) => onPatch({ tags })} />
        </PopoverContent>
      </Popover>

      <Popover
        open={notesOpen}
        onOpenChange={(open) => {
          setNotesOpen(open);
          if (open) setNotesDraft(task.notes ?? "");
          if (!open && notesDraft !== (task.notes ?? "")) onPatch({ notes: notesDraft });
        }}
      >
        <PopoverTrigger asChild>
          <button type="button" className={iconBtn} title="Edit description">
            <StickyNote className="w-3.5 h-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72" align="start">
          <Textarea
            value={notesDraft}
            onChange={(e) => setNotesDraft(e.target.value)}
            placeholder="Add notes..."
            rows={4}
            autoFocus
          />
        </PopoverContent>
      </Popover>

      {onDelete && (
        <button
          type="button"
          className={cn(iconBtn, "hover:text-destructive")}
          title="Delete task"
          onClick={onDelete}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}
