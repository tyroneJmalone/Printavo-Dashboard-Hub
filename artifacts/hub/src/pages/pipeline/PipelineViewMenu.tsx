import { useState } from "react";
import { 
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue 
} from "@/components/ui/select";
import { 
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger 
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Save, Plus, Star, Edit2, Trash2, Settings, Loader2 } from "lucide-react";
import type { PipelineView } from "@workspace/api-client-react";

interface Props {
  views: PipelineView[];
  selectedViewId: string | null;
  isDirty: boolean;
  isMutating: boolean;
  onSelect: (viewId: string | null) => void;
  onSave: () => void;
  onSaveAs: (name: string) => Promise<boolean>;
  onToggleDefault: () => void;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
}

export function PipelineViewMenu({
  views,
  selectedViewId,
  isDirty,
  isMutating,
  onSelect,
  onSave,
  onSaveAs,
  onToggleDefault,
  onRename,
  onDelete,
}: Props) {
  const selectedView = views.find(v => v.id === selectedViewId);
  
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");

  const handleSaveAsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!saveAsName.trim() || isMutating) return;
    const success = await onSaveAs(saveAsName.trim());
    if (success) {
      setSaveAsOpen(false);
      setSaveAsName("");
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!renameName.trim() || isMutating) return;
    const success = await onRename(renameName.trim());
    if (success) {
      setRenameOpen(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2">
        <Select 
          value={selectedViewId ?? "none"} 
          onValueChange={(val) => onSelect(val === "none" ? null : val)}
        >
          <SelectTrigger className="w-[200px] h-8 text-xs bg-slate-900 border-slate-700">
            <SelectValue placeholder="Select view..." />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Ad-hoc (Unsaved)</SelectItem>
            {views.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {v.name} {v.isDefault ? "(Default)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {selectedViewId && isDirty && (
          <Badge variant="outline" className="text-yellow-500 border-yellow-500/50 bg-yellow-500/10 px-2 py-0 text-[10px] font-medium uppercase tracking-wider">
            Unsaved
          </Badge>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8 text-slate-400 hover:text-slate-200" disabled={isMutating}>
              {isMutating ? <Loader2 size={16} className="animate-spin" /> : <Settings size={16} />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {selectedViewId && isDirty && (
              <DropdownMenuItem onClick={onSave} disabled={isMutating}>
                <Save className="mr-2" size={14} /> Save Changes
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => { setSaveAsName(""); setSaveAsOpen(true); }} disabled={isMutating}>
              <Plus className="mr-2" size={14} /> Save As New...
            </DropdownMenuItem>
            {selectedViewId && selectedView && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={onToggleDefault} disabled={isMutating}>
                  <Star className="mr-2" size={14} /> 
                  {selectedView.isDefault ? "Remove Default" : "Set as Default"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => { setRenameName(selectedView.name); setRenameOpen(true); }} disabled={isMutating}>
                  <Edit2 className="mr-2" size={14} /> Rename...
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-red-500 focus:text-red-400 focus:bg-red-500/10" onClick={onDelete} disabled={isMutating}>
                  <Trash2 className="mr-2" size={14} /> Delete View
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={saveAsOpen} onOpenChange={setSaveAsOpen}>
        <DialogContent className="bg-slate-900 border-slate-700">
          <DialogHeader>
            <DialogTitle>Save View As</DialogTitle>
            <DialogDescription>
              Create a new saved view from your current filter configuration.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveAsSubmit} className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="saveAsName">View Name</Label>
              <Input 
                id="saveAsName"
                autoFocus
                value={saveAsName} 
                onChange={(e) => setSaveAsName(e.target.value)} 
                placeholder="e.g. My Important Quotes"
                className="bg-slate-950 border-slate-800 text-sm"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setSaveAsOpen(false)} disabled={isMutating}>Cancel</Button>
              <Button type="submit" disabled={!saveAsName.trim() || isMutating} className="bg-[#10b981] text-slate-950 hover:bg-[#0ea5e9]">
                {isMutating ? <Loader2 size={16} className="animate-spin mr-2" /> : null} Save View
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="bg-slate-900 border-slate-700">
          <DialogHeader>
            <DialogTitle>Rename View</DialogTitle>
            <DialogDescription>
              Change the name of the selected view.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRenameSubmit} className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="renameName">New Name</Label>
              <Input 
                id="renameName"
                autoFocus
                value={renameName} 
                onChange={(e) => setRenameName(e.target.value)} 
                className="bg-slate-950 border-slate-800 text-sm"
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenameOpen(false)} disabled={isMutating}>Cancel</Button>
              <Button type="submit" disabled={!renameName.trim() || renameName === selectedView?.name || isMutating} className="bg-[#10b981] text-slate-950 hover:bg-[#0ea5e9]">
                {isMutating ? <Loader2 size={16} className="animate-spin mr-2" /> : null} Rename
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
