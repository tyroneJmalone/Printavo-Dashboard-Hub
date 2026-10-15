import { useEffect, useState } from "react";
import type { SalesFollowup, SalesFollowupRecord, SalesFollowupStatus, SalesPerson } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { CustomerPicker, type PickedCustomer } from "./CustomerPicker";
import { STATUSES, addDays, todayIso, useSalesActions } from "./salesUtils";

export interface FollowupDialogProps {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  record?: SalesFollowupRecord | null;
  /** Prefill for new follow-ups (from occurrences / history rows). */
  initial?: Partial<SalesFollowup> & { customerName?: string };
  customerNames: Map<string, string>;
  contacts?: SalesPerson[];
  owners: string[];
  lockCustomer?: boolean;
}

export function FollowupDialog({ open, onOpenChange, record, initial, customerNames, contacts, owners, lockCustomer }: FollowupDialogProps) {
  const { save, archive, busy } = useSalesActions();
  const base: SalesFollowup = record?.followup ?? {
    customerId: initial?.customerId ?? "",
    contactId: initial?.contactId ?? null,
    title: initial?.title ?? "",
    dueDate: initial?.dueDate ?? addDays(todayIso(), 7),
    status: initial?.status ?? "needs_contact",
    owner: initial?.owner ?? "",
    notes: initial?.notes ?? "",
    sourceType: initial?.sourceType ?? "manual",
    sourceId: initial?.sourceId ?? null,
    occurrenceDate: initial?.occurrenceDate ?? null,
    invoiceIds: initial?.invoiceIds ?? [],
  };
  const [f, setF] = useState<SalesFollowup>(base);
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [invoiceText, setInvoiceText] = useState("");

  useEffect(() => {
    if (!open) return;
    setF(base);
    setCustomer(base.customerId ? { id: base.customerId, name: customerNames.get(base.customerId) ?? initial?.customerName ?? base.customerId } : null);
    setInvoiceText(base.invoiceIds.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, record?.id, record?.version]);

  const snoozeInvalid = f.status === "snoozed" && f.dueDate <= todayIso();
  const valid = !!customer && f.title.trim() && f.dueDate && !snoozeInvalid;

  const submit = async () => {
    if (!valid || !customer) return;
    const followup: SalesFollowup = {
      ...f,
      customerId: customer.id,
      title: f.title.trim(),
      invoiceIds: invoiceText.split(/[\s,]+/).map((s) => s.replace(/^#/, "")).filter(Boolean),
    };
    const id = await save(
      { kind: "followup", ...(record ? { id: record.id, version: record.version } : {}), followup },
      record ? "Follow-up updated" : "Follow-up created",
    );
    if (id) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{record ? "Edit follow-up" : "New follow-up"}</DialogTitle>
        </DialogHeader>
        {f.sourceType !== "manual" && (
          <p className="text-[11px] text-slate-400 rounded border border-slate-800 bg-slate-900/60 px-2.5 py-1.5">
            Source: {f.sourceType === "event" ? "seasonal event" : f.sourceType === "anniversary" ? "invoice anniversary" : "custom field reminder"}
            {f.occurrenceDate ? ` · occurrence ${f.occurrenceDate}` : ""}. No message is sent — this is a task for staff.
          </p>
        )}
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-slate-400">Customer</Label>
            {lockCustomer || record ? (
              <p className="text-sm text-slate-200 h-9 flex items-center">{customer?.name ?? "—"}</p>
            ) : (
              <CustomerPicker value={customer} onChange={setCustomer} />
            )}
          </div>
          {contacts && contacts.length > 0 && (
            <div>
              <Label className="text-xs text-slate-400">Contact (optional)</Label>
              <Select value={f.contactId ?? "none"} disabled={!!record} onValueChange={(v) => setF({ ...f, contactId: v === "none" ? null : v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific contact</SelectItem>
                  {contacts.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label className="text-xs text-slate-400">What to follow up on</Label>
            <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. Fall soccer jerseys reorder" data-testid="input-followup-title" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-slate-400">Status</Label>
              <Select value={f.status} onValueChange={(v) => setF({ ...f, status: v as SalesFollowupStatus })}>
                <SelectTrigger data-testid="select-followup-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-slate-400">{f.status === "snoozed" ? "Snooze until" : "Due date"}</Label>
              <Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} data-testid="input-followup-due" />
            </div>
          </div>
          {snoozeInvalid && <p className="text-xs text-amber-400">Choose a future date to snooze until.</p>}
          <div>
            <Label className="text-xs text-slate-400">Owner</Label>
            <Input list="sales-owners" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} placeholder="Leave blank for unassigned" />
            <datalist id="sales-owners">{owners.map((o) => <option key={o} value={o} />)}</datalist>
          </div>
          <div>
            <Label className="text-xs text-slate-400">Linked invoice IDs (optional)</Label>
            <Input disabled={!!record} value={invoiceText} onChange={(e) => setInvoiceText(e.target.value)} placeholder="Comma separated" />
          </div>
          <div>
            <Label className="text-xs text-slate-400">Notes</Label>
            <Textarea rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </div>
        </div>
        <div className="flex items-center gap-2 pt-2">
          {record && (
            <Button
              variant="ghost"
              className="text-red-400 hover:text-red-300"
              disabled={busy}
              onClick={async () => {
                if (!window.confirm("Archive this follow-up? It stays in history.")) return;
                if (await archive(record.id, record.version, "Follow-up archived")) onOpenChange(false);
              }}
            >
              Archive
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={!valid || busy} onClick={submit} data-testid="button-save-followup">
              {busy ? <Loader2 size={14} className="animate-spin" /> : "Save"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
