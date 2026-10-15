import { useEffect, useState } from "react";
import { Link } from "wouter";
import type { SalesEventRecord, SalesFollowup, SalesOccurrence, SalesOverrideRecord } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { fmtDay, useSalesActions } from "./salesUtils";

export function OccurrenceDialog({
  occurrence, onOpenChange, event, customerNames, override, onAudience, onEditEvent, onFollowup,
}: {
  occurrence: SalesOccurrence | null;
  onOpenChange: (o: boolean) => void;
  event: SalesEventRecord | null;
  customerNames: Map<string, string>;
  /** Present when viewing within a customer's profile — enables per-customer overrides. */
  override?: { customerId: string; record: SalesOverrideRecord | null };
  onAudience?: () => void;
  onEditEvent?: () => void;
  onFollowup: (init: Partial<SalesFollowup> & { customerName?: string }) => void;
}) {
  const { save, archive, busy } = useSalesActions();
  const [excluded, setExcluded] = useState(false);
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    const o = override?.record?.override;
    setExcluded(o?.excluded ?? false);
    setDate(o?.startDate ?? "");
    setNotes(o?.notes ?? "");
  }, [occurrence?.key, override?.record?.id, override?.record?.version]);
  if (!occurrence) return null;
  const o = occurrence;
  const custId = override?.customerId ?? o.customerId;

  return (
    <Dialog open={!!occurrence} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{o.title}</DialogTitle></DialogHeader>
        <div className="space-y-1.5 text-sm">
          <p className="text-slate-300">{o.endDate ? `${fmtDay(o.date, o.precision)} – ${fmtDay(o.endDate, o.precision)}` : fmtDay(o.date, o.precision)}</p>
          <p className="text-xs text-slate-400">Outreach from {fmtDay(o.outreachDate)}{o.owner ? ` · owner ${o.owner}` : ""}</p>
          <p className="text-xs text-slate-500">
            {o.sourceType === "event" ? (o.customerId == null ? "Shared seasonal/client event" : o.inherited ? "Inherited from a niche event" : "Client-specific event") : "Custom date-field reminder"}
            {o.originalDate !== o.date ? ` · originally ${fmtDay(o.originalDate)}` : ""}
            {o.excluded ? " · excluded for this client" : ""}
          </p>
          {o.customerId && <Link href={`/customers/${o.customerId}`} className="text-xs text-emerald-400 hover:underline">{customerNames.get(o.customerId) ?? "Customer profile"}</Link>}
          {event?.event.merchandise && <p className="text-xs text-slate-400">Merchandise: {event.event.merchandise}</p>}
          {event?.event.notes && <p className="text-xs text-slate-400 whitespace-pre-wrap">{event.event.notes}</p>}
        </div>

        {override && o.sourceType === "event" && (
          <div className="rounded-lg border border-slate-800 p-3 space-y-2">
            <p className="text-xs font-semibold text-slate-300">Adjust for this client only</p>
            <label className="flex items-center gap-2 text-xs text-slate-300"><Checkbox checked={excluded} onCheckedChange={(v) => setExcluded(!!v)} /> Exclude this occurrence</label>
            {!excluded && <div><Label className="text-xs text-slate-400">Client-specific date</Label><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>}
            <div><Label className="text-xs text-slate-400">Notes</Label><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
            <div className="flex gap-2 justify-end">
              {override.record && <Button size="sm" variant="ghost" disabled={busy} onClick={async () => { if (await archive(override.record!.id, override.record!.version, "Occurrence restored")) onOpenChange(false); }}>Restore default</Button>}
              <Button size="sm" disabled={busy || (!excluded && !date && !notes)} onClick={async () => {
                const id = await save({
                  kind: "override",
                  ...(override.record ? { id: override.record.id, version: override.record.version } : {}),
                  override: { eventId: o.sourceId, customerId: override.customerId, occurrenceDate: o.originalDate, excluded, startDate: excluded ? null : date || null, notes },
                }, "Override saved");
                if (id) onOpenChange(false);
              }} data-testid="button-save-override">Save override</Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2 justify-end pt-1">
          {event && onEditEvent && <Button variant="outline" size="sm" onClick={onEditEvent}>Edit event</Button>}
          {event && onAudience && !custId && <Button variant="outline" size="sm" onClick={onAudience} data-testid="button-open-audience">Open audience</Button>}
          {custId && !o.excluded && (
            <Button size="sm" onClick={() => onFollowup({
              customerId: custId, customerName: customerNames.get(custId), title: o.title, dueDate: o.outreachDate, owner: o.owner,
              sourceType: o.sourceType === "event" ? "event" : "custom_field", sourceId: o.sourceId, occurrenceDate: o.originalDate,
            })} data-testid="button-occurrence-followup">Create follow-up</Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
