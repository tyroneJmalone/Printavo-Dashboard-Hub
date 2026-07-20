import { createContext, useContext, useState, ReactNode, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type SyncGuardAction = "complete" | "reopen" | "delete" | "edit";

interface SyncGuardRequest {
  action: SyncGuardAction;
  /** Number of Printavo-synced tasks affected (bulk actions). Defaults to 1. */
  count?: number;
  onConfirm: () => void;
}

type ConfirmSyncGuard = (request: SyncGuardRequest) => void;

const SyncGuardContext = createContext<ConfirmSyncGuard | null>(null);

export function usePrintavoSyncGuard(): ConfirmSyncGuard {
  const ctx = useContext(SyncGuardContext);
  if (!ctx) {
    throw new Error(
      "usePrintavoSyncGuard must be used within PrintavoSyncGuardProvider",
    );
  }
  return ctx;
}

function copyFor(action: SyncGuardAction, count: number) {
  const many = count > 1;
  const subject = many
    ? `${count} of the selected tasks are synced with Printavo.`
    : "This task is synced with Printavo.";
  switch (action) {
    case "complete":
      return {
        title: many ? "Complete synced tasks?" : "Complete synced task?",
        description: `${subject} Completing ${many ? "them" : "it"} here will also mark ${many ? "them" : "it"} complete in Printavo.`,
        confirm: "Complete",
      };
    case "reopen":
      return {
        title: "Reopen synced task?",
        description: `${subject} Reopening it here will also reopen it in Printavo.`,
        confirm: "Reopen",
      };
    case "delete":
      return {
        title: many ? "Delete synced tasks?" : "Delete synced task?",
        description: `${subject} The Printavo ${many ? "tasks stay" : "task stays"} untouched, but the sync connection is permanently removed — ${many ? "these tasks" : "this task"} can never sync again.`,
        confirm: "Delete",
      };
    case "edit":
      return {
        title: "Edit synced task?",
        description: `${subject} Your change only applies here — it is not sent to Printavo, and title or due-date edits may be overwritten if the task changes in Printavo.`,
        confirm: "Save edit",
      };
  }
}

export function PrintavoSyncGuardProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<SyncGuardRequest | null>(null);

  const confirm = useCallback<ConfirmSyncGuard>((request) => {
    setPending(request);
  }, []);

  const copy = pending ? copyFor(pending.action, pending.count ?? 1) : null;

  return (
    <SyncGuardContext.Provider value={confirm}>
      {children}
      <AlertDialog
        open={!!pending}
        onOpenChange={(open) => !open && setPending(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <RefreshCw className="w-4 h-4 text-[#2baeae]" />
              {copy?.title}
            </AlertDialogTitle>
            <AlertDialogDescription>{copy?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={
                pending?.action === "delete"
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              onClick={() => {
                const request = pending;
                setPending(null);
                request?.onConfirm();
              }}
            >
              {copy?.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SyncGuardContext.Provider>
  );
}

/** Task-update fields whose edits warrant the sync-guard confirmation. */
const GUARDED_EDIT_FIELDS = ["title", "notes", "dueDate"] as const;

export function isGuardedEdit(data: object): boolean {
  return GUARDED_EDIT_FIELDS.some((field) => field in data);
}
