import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PaletteColorSuggestion } from "@workspace/api-client-react";

interface AlternativeColorPickerProps {
  alternatives: PaletteColorSuggestion[];
  onSelect: (color: PaletteColorSuggestion) => void;
  selectedColorNames: string[];
}

export function AlternativeColorPicker({ alternatives, onSelect, selectedColorNames }: AlternativeColorPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const unselectedAlternatives = alternatives.filter(a => !selectedColorNames.includes(a.colorName));

  if (unselectedAlternatives.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-300 hover:bg-slate-800 text-xs shadow-sm h-8"
        >
          Search other color options...
          <ChevronsUpDown className="ml-2 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0 border-slate-800 bg-slate-950 shadow-xl" align="start">
        <Command className="bg-transparent" filter={(value, search) => {
          if (value.toLowerCase().includes(search.toLowerCase())) return 1;
          return 0;
        }}>
          <CommandInput
            placeholder="Search colors..."
            value={search}
            onValueChange={setSearch}
            className="border-slate-800 text-xs h-9"
          />
          <CommandList className="custom-scrollbar max-h-[200px]">
            <CommandEmpty className="py-4 text-center text-xs text-slate-500">
              No matching colors found.
            </CommandEmpty>
            <CommandGroup>
              {unselectedAlternatives.map((alt) => (
                <CommandItem
                  key={alt.colorName}
                  value={alt.colorName}
                  onSelect={() => {
                    onSelect(alt);
                    setOpen(false);
                    setSearch("");
                  }}
                  className="text-slate-300 hover:bg-slate-800 cursor-pointer text-xs"
                >
                  <div className="flex items-center gap-2 flex-1">
                    {alt.swatchImage ? (
                      <img src={alt.swatchImage} alt="" className="w-4 h-4 rounded-sm object-cover bg-slate-900" />
                    ) : (
                      <div className="w-4 h-4 rounded-sm bg-slate-800 border border-slate-700" />
                    )}
                    <span className="truncate">{alt.colorName}</span>
                  </div>
                  <Check
                    className={cn(
                      "ml-2 h-3 w-3 shrink-0 text-emerald-500",
                      selectedColorNames.includes(alt.colorName) ? "opacity-100" : "opacity-0"
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
