import { useRef, useState } from "react";
import { Member } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverAnchor } from "@/components/ui/popover";
import { Command, CommandGroup, CommandItem, CommandList, CommandEmpty } from "@/components/ui/command";
import { Users } from "lucide-react";

export interface MentionableTeam {
  id: number;
  name: string;
  color: string;
  memberIds: number[];
}

interface MentionInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  members: Member[];
  teams?: MentionableTeam[];
  placeholder?: string;
}

export function MentionInput({ value, onChange, onSubmit, members, teams = [], placeholder }: MentionInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionStart, setMentionStart] = useState<number | null>(null);

  const updateMentionState = (text: string, cursor: number) => {
    const uptoCursor = text.slice(0, cursor);
    const match = uptoCursor.match(/(?:^|\s)@([A-Za-z]*)$/);
    if (match) {
      setMentionQuery(match[1]);
      setMentionStart(cursor - match[1].length - 1);
    } else {
      setMentionQuery(null);
      setMentionStart(null);
    }
  };

  const memberSuggestions = mentionQuery !== null
    ? members.filter((m) => m.name.toLowerCase().includes(mentionQuery.toLowerCase()))
    : [];

  const teamSuggestions = mentionQuery !== null
    ? teams.filter((t) => t.name.toLowerCase().includes(mentionQuery.toLowerCase()))
    : [];

  const insertMention = (name: string) => {
    if (mentionStart === null) return;
    const input = inputRef.current;
    const cursor = input?.selectionStart ?? value.length;
    const before = value.slice(0, mentionStart);
    const after = value.slice(cursor);
    const inserted = `@${name} `;
    const next = `${before}${inserted}${after}`;
    onChange(next);
    setMentionQuery(null);
    setMentionStart(null);
    requestAnimationFrame(() => {
      const pos = before.length + inserted.length;
      input?.focus();
      input?.setSelectionRange(pos, pos);
    });
  };

  const hasAnySuggestions = memberSuggestions.length > 0 || teamSuggestions.length > 0;

  return (
    <Popover open={mentionQuery !== null}>
      <PopoverAnchor asChild>
        <Input
          ref={inputRef}
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            updateMentionState(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyUp={(e) => {
            const target = e.target as HTMLInputElement;
            updateMentionState(target.value, target.selectionStart ?? target.value.length);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && mentionQuery === null) {
              e.preventDefault();
              onSubmit();
            } else if (e.key === "Escape") {
              setMentionQuery(null);
              setMentionStart(null);
            }
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        className="w-[220px] p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        align="start"
      >
        <Command shouldFilter={false}>
          <CommandList>
            {!hasAnySuggestions && <CommandEmpty>No matches found</CommandEmpty>}
            {memberSuggestions.length > 0 && (
              <CommandGroup heading="Members">
                {memberSuggestions.map((member) => (
                  <CommandItem key={member.id} onSelect={() => insertMention(member.name)}>
                    <div
                      className="w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                      style={{ backgroundColor: member.color || "#9e4a95" }}
                    >
                      {member.name.slice(0, 1).toUpperCase()}
                    </div>
                    {member.name}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {teamSuggestions.length > 0 && (
              <CommandGroup heading="Teams">
                {teamSuggestions.map((team) => (
                  <CommandItem key={`team-${team.id}`} onSelect={() => insertMention(team.name)}>
                    <div
                      className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                      style={{ backgroundColor: team.color }}
                    >
                      <Users className="w-2.5 h-2.5 text-white" />
                    </div>
                    {team.name}
                    <span className="ml-auto text-[10px] text-muted-foreground">{team.memberIds.length}m</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
