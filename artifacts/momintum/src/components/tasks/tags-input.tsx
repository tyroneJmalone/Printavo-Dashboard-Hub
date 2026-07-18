import { useState } from "react";
import { useListTasks } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";
import { Popover, PopoverContent, PopoverAnchor } from "@/components/ui/popover";
import { Command, CommandGroup, CommandItem, CommandList, CommandEmpty } from "@/components/ui/command";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@/components/ui/alert-dialog";

interface TagsInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
}

export function TagsInput({ value, onChange }: TagsInputProps) {
  const { data: allTasks } = useListTasks({});
  const presetTags = Array.from(new Set((allTasks || []).flatMap((t) => t.tags))).sort((a, b) =>
    a.localeCompare(b),
  );

  const [inputValue, setInputValue] = useState("");
  const [open, setOpen] = useState(false);
  const [pendingTag, setPendingTag] = useState<string | null>(null);

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed) return;
    if (!value.some((t) => t.toLowerCase() === trimmed.toLowerCase())) {
      onChange([...value, trimmed]);
    }
    setInputValue("");
    setOpen(false);
  };

  const removeTag = (tag: string) => {
    onChange(value.filter((t) => t !== tag));
  };

  const handleCommit = () => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;
    const existing = presetTags.find((t) => t.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      addTag(existing);
    } else {
      setOpen(false);
      setPendingTag(trimmed);
    }
  };

  const suggestions = presetTags.filter(
    (t) =>
      t.toLowerCase().includes(inputValue.trim().toLowerCase()) &&
      !value.some((v) => v.toLowerCase() === t.toLowerCase()),
  );

  return (
    <div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {value.map((tag) => (
            <Badge key={tag} variant="secondary" className="gap-1 pr-1">
              #{tag}
              <button
                type="button"
                onClick={() => removeTag(tag)}
                className="ml-0.5 rounded-sm hover:text-destructive"
                aria-label={`Remove tag ${tag}`}
              >
                <X className="w-3 h-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Popover open={open}>
        <PopoverAnchor asChild>
          <Input
            value={inputValue}
            placeholder="Add a tag..."
            onChange={(e) => {
              setInputValue(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                handleCommit();
              } else if (e.key === "Backspace" && !inputValue && value.length > 0) {
                removeTag(value[value.length - 1]);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
          />
        </PopoverAnchor>
        <PopoverContent
          className="w-[240px] p-0"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={() => setOpen(false)}
        >
          <Command shouldFilter={false}>
            <CommandList>
              <CommandEmpty>No matching tags</CommandEmpty>
              {suggestions.length > 0 && (
                <CommandGroup heading="Existing tags">
                  {suggestions.map((tag) => (
                    <CommandItem key={tag} onSelect={() => addTag(tag)}>
                      #{tag}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p className="text-[11px] text-muted-foreground mt-1">
        Press Enter to add. Existing tags appear as suggestions to keep tagging consistent.
      </p>

      <AlertDialog open={!!pendingTag} onOpenChange={(o) => !o && setPendingTag(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Create a new tag?</AlertDialogTitle>
            <AlertDialogDescription>
              "{pendingTag}" doesn't match any existing tag. Create it as a new tag, or cancel and
              pick from the existing list to keep tagging consistent.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingTag(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingTag) addTag(pendingTag);
                setPendingTag(null);
              }}
            >
              Create "{pendingTag}"
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
