import { useEffect, useState } from "react";
import {
  useListCustomerCategories,
  getListCustomerCategoriesQueryKey,
  type SalesEvent,
  type SalesEventRecord,
} from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { CustomerMultiPicker, type PickedCustomer } from "./CustomerPicker";
import { todayIso, useSalesActions } from "./salesUtils";

export function EventDialog({
  open,
  onOpenChange,
  record,
  customerNames,
  owners,
  presetCustomer,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  record?: SalesEventRecord | null;
  customerNames: Map<string, string>;
  owners: string[];
  presetCustomer?: PickedCustomer;
}) {
  const { save, archive, busy } = useSalesActions();
  const { data: catData } = useListCustomerCategories({ query: { queryKey: getListCustomerCategoriesQueryKey() } });
  const categories = catData?.categories ?? [];
  const blank: SalesEvent = {
    title: "",
    startDate: todayIso(),
    endDate: null,
    precision: "day",
    recurrence: "annual",
    leadDays: 42,
    nicheIds: [],
    customerIds: presetCustomer ? [presetCustomer.id] : [],
    owner: "",
    notes: "",
    merchandise: "",
  };
  const [e, setE] = useState<SalesEvent>(blank);
  const [clients, setClients] = useState<PickedCustomer[]>([]);
  const [ranged, setRanged] = useState(false);

  useEffect(() => {
    if (!open) return;
    const src = record?.event ?? blank;
    setE(src);
    setRanged(!!src.endDate);
    setClients(src.customerIds.map((id) => ({ id, name: customerNames.get(id) ?? (presetCustomer?.id === id ? presetCustomer.name : id) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, record?.id, record?.version]);

  const month = e.precision === "month";
  const toMonth = (d: string | null) => (d ? d.slice(0, 7) : "");
  const endBeforeStart = ranged && !!e.endDate && e.endDate < e.startDate;
  const valid = e.title.trim() && e.startDate && (e.nicheIds.length > 0 || clients.length > 0) && !endBeforeStart && (!ranged || !!e.endDate);

  const submit = async () => {
    const event: SalesEvent = { ...e, title: e.title.trim(), endDate: ranged ? e.endDate : null, customerIds: clients.map((c) => c.id) };
    const id = await save({ kind: "event", ...(record ? { id: record.id, version: record.version } : {}), event }, record ? "Event updated" : "Event created");
    if (id) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{record ? "Edit event" : "New seasonal or client event"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <Label className="text-xs text-slate-400">Event name</Label>
            <Input value={e.title} onChange={(x) => setE({ ...e, title: x.target.value })} placeholder="e.g. Fall soccer season kickoff" data-testid="input-event-title" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs text-slate-400">Date precision</Label>
              <Select value={e.precision} onValueChange={(v) => setE({ ...e, precision: v as SalesEvent["precision"], startDate: v === "month" ? e.startDate.slice(0, 7) + "-01" : e.startDate, endDate: e.endDate && v === "month" ? e.endDate.slice(0, 7) + "-01" : e.endDate })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="day">Specific date</SelectItem>
                  <SelectItem value="month">Whole month</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-slate-400">Repeats</Label>
              <Select value={e.recurrence} onValueChange={(v) => setE({ ...e, recurrence: v as SalesEvent["recurrence"] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="annual">Every year</SelectItem>
                  <SelectItem value="once">Once</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-slate-400">{ranged ? "Starts" : month ? "Month" : "Date"}</Label>
              {month ? (
                <Input type="month" value={toMonth(e.startDate)} onChange={(x) => x.target.value && setE({ ...e, startDate: x.target.value + "-01" })} />
              ) : (
                <Input type="date" value={e.startDate} onChange={(x) => setE({ ...e, startDate: x.target.value })} />
              )}
            </div>
            <div>
              <Label className="text-xs text-slate-400">Reach out days before</Label>
              <Input type="number" min={0} value={e.leadDays} onChange={(x) => setE({ ...e, leadDays: Math.max(0, Number(x.target.value) || 0) })} />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <Checkbox checked={ranged} onCheckedChange={(v) => setRanged(!!v)} /> Spans a range
            </label>
            {ranged && (month ? (
              <Input className="w-48" type="month" value={toMonth(e.endDate)} onChange={(x) => setE({ ...e, endDate: x.target.value ? x.target.value + "-01" : null })} />
            ) : (
              <Input className="w-48" type="date" value={e.endDate ?? ""} onChange={(x) => setE({ ...e, endDate: x.target.value || null })} />
            ))}
            {endBeforeStart && <span className="text-xs text-amber-400">End is before start.</span>}
          </div>

          <div className="rounded-lg border border-slate-800 p-3 space-y-3">
            <p className="text-xs font-semibold text-slate-300">Audience — at least one niche or client</p>
            <div className="flex flex-wrap gap-2">
              {categories.filter((c) => c.active || e.nicheIds.includes(c.id)).map((c) => {
                const on = e.nicheIds.includes(c.id);
                return (
                  <button
                    type="button"
                    key={c.id}
                    onClick={() => setE({ ...e, nicheIds: on ? e.nicheIds.filter((x) => x !== c.id) : [...e.nicheIds, c.id] })}
                    className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${on ? "border-emerald-600 bg-emerald-950/60 text-emerald-300" : "border-slate-700 text-slate-400 hover:text-slate-200"}`}
                    data-testid={`toggle-niche-${c.id}`}
                  >
                    {c.name}
                  </button>
                );
              })}
              {categories.length === 0 && <span className="text-xs text-slate-500">No niche categories yet.</span>}
            </div>
            <CustomerMultiPicker value={clients} onChange={setClients} />
            <p className="text-[11px] text-slate-500">Niche events do not create tasks automatically — open the audience to choose who to contact.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-slate-400">Owner</Label>
              <Input list="event-owners" value={e.owner} onChange={(x) => setE({ ...e, owner: x.target.value })} placeholder="Leave blank for unassigned" />
              <datalist id="event-owners">{owners.map((o) => <option key={o} value={o} />)}</datalist>
            </div>
            <div>
              <Label className="text-xs text-slate-400">Merchandise</Label>
              <Input value={e.merchandise} onChange={(x) => setE({ ...e, merchandise: x.target.value })} placeholder="Jerseys, warmups, spirit wear" />
            </div>
          </div>
          <div>
            <Label className="text-xs text-slate-400">Notes</Label>
            <Textarea rows={3} value={e.notes} onChange={(x) => setE({ ...e, notes: x.target.value })} />
          </div>
        </div>
        <div className="flex items-center gap-2 pt-2">
          {record && (
            <Button variant="ghost" className="text-red-400 hover:text-red-300" disabled={busy} onClick={async () => {
              if (!window.confirm("Archive this event? Existing follow-ups are kept.")) return;
              if (await archive(record.id, record.version, "Event archived")) onOpenChange(false);
            }}>Archive</Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button disabled={!valid || busy} onClick={submit} data-testid="button-save-event">
              {busy ? <Loader2 size={14} className="animate-spin" /> : "Save event"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
