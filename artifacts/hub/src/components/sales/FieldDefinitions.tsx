import { useEffect, useState } from "react";
import type { SalesField, SalesFieldRecord } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Plus, SlidersHorizontal } from "lucide-react";
import { useSalesActions } from "./salesUtils";

export const FIELD_TYPE_LABEL: Record<string, string> = {
  text: "Text", number: "Number", date: "Date", annual_date: "Annual date (MM-DD)", dropdown: "Dropdown", boolean: "Yes / No",
};

function FieldDialog({ open, onOpenChange, record }: { open: boolean; onOpenChange: (o: boolean) => void; record: SalesFieldRecord | null }) {
  const { save, archive, busy } = useSalesActions();
  const blank: SalesField = { name: "", scope: "customer", type: "text", options: [], reminderEnabled: false, leadDays: 14 };
  const [f, setF] = useState<SalesField>(blank);
  const [opts, setOpts] = useState("");
  useEffect(() => {
    if (!open) return;
    const src = record?.field ?? blank;
    setF(src);
    setOpts(src.options.join(", "));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, record?.id, record?.version]);
  const isDate = f.type === "date" || f.type === "annual_date";
  const options = opts.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = f.name.trim() && (f.type !== "dropdown" || options.length > 0);
  const submit = async () => {
    const field: SalesField = { ...f, name: f.name.trim(), options: f.type === "dropdown" ? options : [], reminderEnabled: isDate && f.reminderEnabled };
    if (await save({ kind: "field", ...(record ? { id: record.id, version: record.version } : {}), field }, record ? "Field updated" : "Field created")) onOpenChange(false);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{record ? "Edit field" : "New custom field"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label className="text-xs text-slate-400">Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Season start, Birthday" data-testid="input-field-name" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-slate-400">Applies to</Label>
              <Select value={f.scope} disabled={!!record} onValueChange={(v) => setF({ ...f, scope: v as SalesField["scope"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="customer">Company</SelectItem><SelectItem value="contact">Each contact</SelectItem></SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-slate-400">Type</Label>
              <Select value={f.type} disabled={!!record} onValueChange={(v) => setF({ ...f, type: v as SalesField["type"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{Object.entries(FIELD_TYPE_LABEL).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          {record && <p className="text-[11px] text-slate-500">Type and scope are fixed after creation so saved values stay valid. Options still used by saved values cannot be removed.</p>}
          {f.scope === "contact" && <p className="text-[11px] text-slate-500">Personal details such as birthdays belong on contact scope. Values are internal only.</p>}
          {f.type === "dropdown" && <div><Label className="text-xs text-slate-400">Options (comma separated)</Label><Input value={opts} onChange={(e) => setOpts(e.target.value)} /></div>}
          {isDate && (
            <div className="rounded-lg border border-slate-800 p-3 space-y-2">
              <label className="flex items-center justify-between text-sm text-slate-200">Show reminders on calendar <Switch checked={f.reminderEnabled} onCheckedChange={(v) => setF({ ...f, reminderEnabled: v })} /></label>
              {f.reminderEnabled && <div><Label className="text-xs text-slate-400">Days of lead time</Label><Input type="number" min={0} value={f.leadDays} onChange={(e) => setF({ ...f, leadDays: Math.max(0, Number(e.target.value) || 0) })} /></div>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 pt-2">
          {record && <Button variant="ghost" className="text-red-400" disabled={busy} onClick={async () => {
            if (!window.confirm("Archive this field? Saved values are kept in history and hidden from profiles.")) return;
            if (await archive(record.id, record.version, "Field archived")) onOpenChange(false);
          }}>Archive</Button>}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={!valid || busy} onClick={submit} data-testid="button-save-field">{busy ? <Loader2 size={14} className="animate-spin" /> : "Save"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function FieldDefinitions({ fields }: { fields: SalesFieldRecord[] }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SalesFieldRecord | null>(null);
  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-200 inline-flex items-center gap-1.5"><SlidersHorizontal size={14} className="text-slate-400" /> Custom client and contact fields</h2>
          <p className="text-xs text-slate-500 mt-0.5">Internal-only data on customer profiles. Date fields can drive reminders.</p>
        </div>
        <Button size="sm" className="gap-1" onClick={() => { setEditing(null); setOpen(true); }} data-testid="button-new-field"><Plus size={14} /> New field</Button>
      </div>
      {fields.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-800 px-6 py-10 text-center text-sm text-slate-500">No custom fields defined.</div>
      ) : (
        <div className="border border-slate-800 rounded-xl divide-y divide-slate-800/70">
          {fields.map((r) => (
            <button key={r.id} onClick={() => { setEditing(r); setOpen(true); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-slate-900/40" data-testid={`row-field-${r.id}`}>
              <span className="flex-1 text-sm text-slate-100">{r.field.name}</span>
              <span className="text-xs text-slate-500">{r.field.scope === "customer" ? "Company" : "Contact"}</span>
              <span className="text-xs text-slate-400 w-40">{FIELD_TYPE_LABEL[r.field.type]}</span>
              <span className="text-xs w-32 text-right text-slate-500">{r.field.reminderEnabled ? `Reminder ${r.field.leadDays}d ahead` : ""}</span>
            </button>
          ))}
        </div>
      )}
      <FieldDialog open={open} onOpenChange={setOpen} record={editing} />
    </div>
  );
}
