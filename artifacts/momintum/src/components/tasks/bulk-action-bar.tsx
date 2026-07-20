import { useState } from "react";
import {
  useListLists,
  useBulkUpdateTasks,
  useBulkDeleteTasks,
  type Task,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getListTasksQueryKey, getGetDashboardSummaryQueryKey } from "@workspace/api-client-react";
import { usePrintavoSyncGuard } from "@/components/tasks/printavo-sync-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { X, Trash2, CheckCircle2 } from "lucide-react";

interface BulkActionBarProps {
  selectedIds: number[];
  onDone: () => void;
}

export function BulkActionBar({ selectedIds, onDone }: BulkActionBarProps) {
  const { data: lists } = useListLists();
  const bulkUpdate = useBulkUpdateTasks();
  const bulkDelete = useBulkDeleteTasks();
  const queryClient = useQueryClient();
  const confirmSyncGuard = usePrintavoSyncGuard();
  const [dueDate, setDueDate] = useState("");

  if (selectedIds.length === 0) return null;

  // The bar only receives ids; look the tasks up across every cached task
  // list to find which selected ones carry an active Printavo sync link.
  const countSyncedSelected = (): number => {
    const selected = new Set(selectedIds);
    const linked = new Set<number>();
    for (const [, data] of queryClient.getQueriesData<Task[]>({
      queryKey: getListTasksQueryKey(),
    })) {
      for (const t of data ?? []) {
        if (t.printavoLinked && selected.has(t.id)) linked.add(t.id);
      }
    }
    return linked.size;
  };

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
  };

  const handleListChange = (value: string) => {
    bulkUpdate.mutate(
      { data: { ids: selectedIds, data: { listId: value === "none" ? null : Number(value) } } },
      { onSuccess: () => { invalidate(); onDone(); } },
    );
  };

  const handleDateChange = (value: string) => {
    setDueDate(value);
    if (!value) return;
    const run = () =>
      bulkUpdate.mutate(
        { data: { ids: selectedIds, data: { dueDate: new Date(value).toISOString() } } },
        { onSuccess: () => { invalidate(); onDone(); } },
      );
    const syncedCount = countSyncedSelected();
    if (syncedCount > 0) {
      confirmSyncGuard({ action: "edit", count: syncedCount, onConfirm: run });
    } else {
      run();
    }
  };

  const handleComplete = () => {
    const run = () =>
      bulkUpdate.mutate(
        { data: { ids: selectedIds, data: { completed: true } } },
        { onSuccess: () => { invalidate(); onDone(); } },
      );
    const syncedCount = countSyncedSelected();
    if (syncedCount > 0) {
      confirmSyncGuard({ action: "complete", count: syncedCount, onConfirm: run });
    } else {
      run();
    }
  };

  const handleDelete = () => {
    const run = () =>
      bulkDelete.mutate(
        { data: { ids: selectedIds } },
        { onSuccess: () => { invalidate(); onDone(); } },
      );
    const syncedCount = countSyncedSelected();
    if (syncedCount > 0) {
      confirmSyncGuard({ action: "delete", count: syncedCount, onConfirm: run });
      return;
    }
    if (!confirm(`Delete ${selectedIds.length} task${selectedIds.length === 1 ? "" : "s"}? This cannot be undone.`)) {
      return;
    }
    run();
  };

  const busy = bulkUpdate.isPending || bulkDelete.isPending;

  return (
    <div className="sticky top-2 z-20 flex flex-wrap items-center gap-3 rounded-lg border border-border bg-background shadow-md p-3 mb-4">
      <span className="text-sm font-medium text-foreground shrink-0">
        {selectedIds.length} selected
      </span>

      <Select onValueChange={handleListChange} disabled={busy}>
        <SelectTrigger className="w-[160px]">
          <SelectValue placeholder="Move to list..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">Inbox</SelectItem>
          {(lists || []).map((l) => (
            <SelectItem key={l.id} value={String(l.id)}>
              {l.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        type="date"
        value={dueDate}
        onChange={(e) => handleDateChange(e.target.value)}
        disabled={busy}
        className="w-[150px]"
        aria-label="Set due date"
      />

      <Button variant="outline" size="sm" onClick={handleComplete} disabled={busy}>
        <CheckCircle2 className="w-4 h-4 mr-1" /> Mark complete
      </Button>

      <Button variant="outline" size="sm" onClick={handleDelete} disabled={busy}>
        <Trash2 className="w-4 h-4 mr-1 text-destructive" /> Delete
      </Button>

      <Button variant="ghost" size="sm" onClick={onDone} className="ml-auto" disabled={busy}>
        <X className="w-4 h-4 mr-1" /> Cancel
      </Button>
    </div>
  );
}
