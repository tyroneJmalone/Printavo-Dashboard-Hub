import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import {
  useGetCustomerBranding,
  getGetCustomerBrandingQueryKey,
  useUpdateCustomerBranding,
  useListBrandingColors,
  getListBrandingColorsQueryKey,
  useCreateBrandingColor,
  type CustomerBrandingColor,
  type BrandingTypographyEntry,
  type BrandingEvent,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useStaff } from "@/components/auth/StaffGate";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Palette,
  Plus,
  Trash2,
  Edit2,
  Check,
  X,
  Type,
  FileText,
  Copy,
  History,
  Printer,
  Archive,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { hexToRgb, formatEventDate } from "@/lib/branding";

/** One copyable production value. Missing values stay visible as "not on file". */
function CopyChip({ label, value }: { label: string; value: string | null | undefined }) {
  const { toast } = useToast();
  if (!value) {
    return (
      <div className="flex items-baseline gap-1.5 text-xs">
        <span className="text-slate-600 font-semibold uppercase tracking-wide text-[10px] w-14 shrink-0">{label}</span>
        <span className="text-slate-600 italic">not on file</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          toast({ title: `${label} copied`, description: value });
        } catch {
          toast({ title: "Couldn't copy", description: value, variant: "destructive" });
        }
      }}
      className="group flex items-baseline gap-1.5 text-xs text-left w-full rounded hover:bg-slate-800/70 px-1 -mx-1 py-0.5 transition-colors"
      title={`Copy ${label}: ${value}`}
      data-testid={`copy-chip-${label.toLowerCase()}`}
    >
      <span className="text-slate-500 font-semibold uppercase tracking-wide text-[10px] w-14 shrink-0">{label}</span>
      <span className="text-slate-200 break-all">{value}</span>
      <Copy size={11} className="text-slate-600 group-hover:text-slate-300 shrink-0 self-center ml-auto" />
    </button>
  );
}

function ColorStandard({ color }: { color: CustomerBrandingColor }) {
  const retired = color.status === "retired";
  return (
    <div className={`rounded-lg border p-3 ${retired ? "bg-slate-900/30 border-slate-800/60 opacity-75" : "bg-slate-800/40 border-slate-800"}`}>
      <div className="flex items-center gap-3 mb-2.5">
        <div
          className="w-9 h-9 rounded-md border border-slate-700 shadow-sm shrink-0"
          style={{ backgroundColor: color.hex }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-xs text-slate-400 truncate">{color.role}</p>
            {retired && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-medium tracking-wide uppercase shrink-0">
                Retired
              </span>
            )}
            {!retired && !color.colorActive && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 font-medium tracking-wide uppercase shrink-0" title="This catalog color was deactivated — review this assignment.">
                Inactive color
              </span>
            )}
          </div>
          <p className="text-sm font-medium text-slate-200 truncate">{color.name}</p>
        </div>
      </div>
      <div className="space-y-0.5">
        <CopyChip label="Pantone" value={color.pantoneCode} />
        <CopyChip label="Hex" value={color.hex} />
        <CopyChip label="RGB" value={hexToRgb(color.hex)} />
        <CopyChip label="CMYK" value={color.cmyk} />
        <CopyChip label="Ink" value={color.inkReferences} />
        <CopyChip label="Thread" value={color.threadReferences} />
      </div>
      {(color.inkStockNotes || color.threadStockNotes) && (
        <div className="mt-2 pt-2 border-t border-slate-800/70 space-y-0.5">
          {color.inkStockNotes && (
            <p className="text-[11px] text-slate-500"><span className="font-semibold text-slate-400">Ink stock:</span> {color.inkStockNotes}</p>
          )}
          {color.threadStockNotes && (
            <p className="text-[11px] text-slate-500"><span className="font-semibold text-slate-400">Thread stock:</span> {color.threadStockNotes}</p>
          )}
        </div>
      )}
      {retired && color.retiredAt && (
        <p className="mt-2 text-[11px] text-slate-500">
          Retired {formatEventDate(color.retiredAt)}{color.retiredByEmail ? ` by ${color.retiredByEmail}` : ""}
        </p>
      )}
    </div>
  );
}

function TypographyRow({ entry }: { entry: BrandingTypographyEntry }) {
  const retired = entry.status === "retired";
  return (
    <div className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border px-3 py-2 ${retired ? "bg-slate-900/30 border-slate-800/60 opacity-75" : "bg-slate-800/40 border-slate-800"}`}>
      <span className="text-xs text-slate-400 w-24 shrink-0">{entry.role}</span>
      <span className="text-sm font-medium text-slate-200">{entry.fontName}</span>
      {entry.capitalization && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300 uppercase tracking-wide">
          {entry.capitalization}
        </span>
      )}
      {retired && (
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-medium tracking-wide uppercase">
          Retired
        </span>
      )}
      {entry.usageNotes && (
        <p className="w-full text-[11px] text-slate-500 leading-relaxed">{entry.usageNotes}</p>
      )}
      {retired && entry.retiredAt && (
        <p className="w-full text-[11px] text-slate-600">
          Retired {formatEventDate(entry.retiredAt)}{entry.retiredByEmail ? ` by ${entry.retiredByEmail}` : ""}
        </p>
      )}
    </div>
  );
}

function HistoryDialog({ events, open, onOpenChange }: { events: BrandingEvent[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const areaLabels: Record<string, string> = {
    colors: "Colors",
    typography: "Fonts",
    notes: "Notes",
    logos: "Logos",
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg bg-slate-950 border-slate-800 max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-slate-200">Brand Standards History</DialogTitle>
          <DialogDescription className="text-slate-500">
            Who changed what, most recent first.
          </DialogDescription>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto -mx-2 px-2">
          {events.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-8">No changes recorded yet.</p>
          ) : (
            <div className="space-y-2 py-2">
              {events.map((event) => (
                <div key={event.id} className="rounded-lg bg-slate-900/60 border border-slate-800/70 px-3 py-2">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 font-semibold uppercase tracking-wide">
                      {areaLabels[event.area] ?? event.area}
                    </span>
                    <span className="text-[11px] text-slate-500">
                      {formatEventDate(event.createdAt)} · {event.actorEmail}
                    </span>
                  </div>
                  <p className="text-sm text-slate-300">{event.summary}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Admin-only inline catalog creation so a color can be assigned the moment it's needed. */
function NewCatalogColorDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: string) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [hex, setHex] = useState("#22C55E");
  const [pantoneCode, setPantoneCode] = useState("");
  const [cmyk, setCmyk] = useState("");
  const [inkReferences, setInkReferences] = useState("");
  const [threadReferences, setThreadReferences] = useState("");
  const [inkStockNotes, setInkStockNotes] = useState("");
  const [threadStockNotes, setThreadStockNotes] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setHex("#22C55E");
      setPantoneCode("");
      setCmyk("");
      setInkReferences("");
      setThreadReferences("");
      setInkStockNotes("");
      setThreadStockNotes("");
    }
  }, [open]);

  const createColor = useCreateBrandingColor({
    mutation: {
      onSuccess: (created) => {
        toast({ title: "Color added to catalog", description: created.name });
        qc.invalidateQueries({ queryKey: getListBrandingColorsQueryKey() });
        onCreated(created.id);
        onOpenChange(false);
      },
      onError: (e: unknown) => {
        const err = e as { error?: string };
        toast({ title: "Couldn't add color", description: err.error || "Please try again.", variant: "destructive" });
      },
    },
  });

  const validHex = /^#[0-9A-Fa-f]{6}$/.test(hex);
  const handleCreate = () => {
    createColor.mutate({
      data: {
        name: name.trim(),
        hex,
        pantoneCode: pantoneCode.trim() || null,
        cmyk: cmyk.trim() || null,
        inkReferences: inkReferences.trim() || null,
        threadReferences: threadReferences.trim() || null,
        inkStockNotes: inkStockNotes.trim() || null,
        threadStockNotes: threadStockNotes.trim() || null,
      },
    });
  };

  const fieldClass = "h-9 text-sm bg-slate-900 border-slate-700";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg bg-slate-950 border-slate-800 max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-slate-200">New Catalog Color</DialogTitle>
          <DialogDescription className="text-slate-500">
            Added to the shared color catalog, so it can be reused for any customer.
            Only name and hex are required — fill in the rest when you have it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-2">
          <div className="col-span-2">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Color name *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mint Green" className={fieldClass} data-testid="input-catalog-color-name" />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Hex *</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={validHex ? hex : "#22C55E"}
                onChange={(e) => setHex(e.target.value.toUpperCase())}
                className="h-9 w-10 rounded border border-slate-700 bg-slate-900 p-0.5 cursor-pointer"
                aria-label="Pick color"
              />
              <Input value={hex} onChange={(e) => setHex(e.target.value)} placeholder="#22C55E" className={fieldClass} data-testid="input-catalog-color-hex" />
            </div>
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Pantone</label>
            <Input value={pantoneCode} onChange={(e) => setPantoneCode(e.target.value)} placeholder="e.g. PMS 354 C" className={fieldClass} />
          </div>
          <div className="col-span-2">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">CMYK</label>
            <Input value={cmyk} onChange={(e) => setCmyk(e.target.value)} placeholder="e.g. 60, 0, 100, 7" className={fieldClass} />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Ink reference</label>
            <Input value={inkReferences} onChange={(e) => setInkReferences(e.target.value)} placeholder="e.g. Wilflex Kelly Green" className={fieldClass} />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Thread reference</label>
            <Input value={threadReferences} onChange={(e) => setThreadReferences(e.target.value)} placeholder="e.g. Madeira 1247" className={fieldClass} />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Ink stock notes</label>
            <Input value={inkStockNotes} onChange={(e) => setInkStockNotes(e.target.value)} placeholder="e.g. Gallon on shelf B2" className={fieldClass} />
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Thread stock notes</label>
            <Input value={threadStockNotes} onChange={(e) => setThreadStockNotes(e.target.value)} placeholder="e.g. 2 cones in stock" className={fieldClass} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="text-slate-300">Cancel</Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!name.trim() || !validHex || createColor.isPending}
            className="bg-blue-600 hover:bg-blue-500 text-white"
            data-testid="button-create-catalog-color"
          >
            {createColor.isPending && <Loader2 size={14} className="animate-spin mr-1.5" />}
            Add Color
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type TypographyDraft = { role: string; fontName: string; capitalization: string; usageNotes: string };

export function CustomerBrandingCard({ customerId }: { customerId: string }) {
  const [, setLocation] = useLocation();
  const { role } = useStaff();
  const isAdmin = role === "admin";
  const { toast } = useToast();
  const qc = useQueryClient();
  const queryKey = getGetCustomerBrandingQueryKey(customerId);

  const { data: branding, isLoading } = useGetCustomerBranding(customerId, {
    query: { enabled: !!customerId, queryKey },
  });

  const { data: colorsData } = useListBrandingColors({
    query: { enabled: true, queryKey: getListBrandingColorsQueryKey() },
  });
  const catalogColors = (colorsData?.colors || []).filter((c) => c.active);

  const [isEditing, setIsEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [newColorDialogOpen, setNewColorDialogOpen] = useState(false);
  const [pendingColorRow, setPendingColorRow] = useState<number | null>(null);

  // Edit state
  const [notes, setNotes] = useState("");
  const [colors, setColors] = useState<{ role: string; colorId: string }[]>([]);
  const [typography, setTypography] = useState<TypographyDraft[]>([]);

  const currentColors = (branding?.colors || []).filter((c) => c.status === "current");
  const retiredColors = (branding?.colors || []).filter((c) => c.status === "retired");
  const currentTypography = (branding?.typography || []).filter((t) => t.status === "current");
  const retiredTypography = (branding?.typography || []).filter((t) => t.status === "retired");

  useEffect(() => {
    if (branding && !isEditing) {
      setNotes(branding.notes || "");
      setColors(
        (branding.colors || [])
          .filter((c) => c.status === "current")
          .map((c) => ({ role: c.role, colorId: c.colorId })),
      );
      setTypography(
        (branding.typography || [])
          .filter((t) => t.status === "current")
          .map((t) => ({
            role: t.role,
            fontName: t.fontName,
            capitalization: t.capitalization || "",
            usageNotes: t.usageNotes || "",
          })),
      );
    }
  }, [branding, isEditing]);

  const updateBranding = useUpdateCustomerBranding({
    mutation: {
      onSuccess: () => {
        toast({ title: "Brand standards updated" });
        setIsEditing(false);
        qc.invalidateQueries({ queryKey });
      },
      onError: (e: unknown) => {
        const err = e as { error?: string };
        toast({ title: "Update failed", description: err.error || "Please try again.", variant: "destructive" });
      },
    },
  });

  const handleSave = () => {
    updateBranding.mutate({
      id: customerId,
      data: {
        notes: notes || null,
        colors: colors.filter((c) => c.role.trim() !== "" && c.colorId),
        typography: typography
          .filter((t) => t.role.trim() !== "" && t.fontName.trim() !== "")
          .map((t) => ({
            role: t.role,
            fontName: t.fontName,
            capitalization: t.capitalization.trim() || null,
            usageNotes: t.usageNotes.trim() || null,
          })),
      },
    });
  };

  if (isLoading) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 flex items-center justify-center">
        <div className="animate-pulse w-full h-32 bg-slate-800/50 rounded-lg"></div>
      </div>
    );
  }

  if (!branding) return null;

  const hasRetired = retiredColors.length > 0 || retiredTypography.length > 0;
  const isEmpty =
    !branding.configured &&
    !branding.notes &&
    currentColors.length === 0 &&
    currentTypography.length === 0;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden flex flex-col">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
        <h2 className="text-sm font-semibold text-slate-200 inline-flex items-center gap-2">
          <Palette size={16} className="text-blue-400" />
          Brand Standards
        </h2>
        <div className="flex items-center gap-1.5">
          {!isEditing && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowHistory(true)}
                className="h-7 px-2 text-slate-400 hover:text-white"
                title="Change history"
                data-testid="button-branding-history"
              >
                <History size={14} />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setLocation(`/customers/${customerId}/brand-sheet`)}
                className="h-7 px-2 text-slate-400 hover:text-white"
                title="Printable brand sheet"
                data-testid="button-brand-sheet"
              >
                <Printer size={14} className="mr-1.5" /> Sheet
              </Button>
            </>
          )}
          {isAdmin &&
            (!isEditing ? (
              <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)} className="h-7 px-2 text-slate-400 hover:text-white" data-testid="button-edit-branding">
                <Edit2 size={14} className="mr-1.5" /> Edit
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)} className="h-7 px-2 text-slate-400">
                  <X size={14} className="mr-1.5" /> Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={updateBranding.isPending} className="h-7 px-3 bg-blue-600 hover:bg-blue-500 text-white" data-testid="button-save-branding">
                  {updateBranding.isPending ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Check size={14} className="mr-1.5" />} Save
                </Button>
              </div>
            ))}
        </div>
      </div>

      <div className="p-5 flex-1">
        {isEditing ? (
          <div className="space-y-6">
            <div>
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 block">Brand Colors</label>
              <p className="text-[11px] text-slate-500 mb-2.5">
                Removing or replacing a color retires it (kept in history) instead of deleting it.
              </p>
              <div className="space-y-3">
                {colors.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      placeholder="Role (e.g. Primary)"
                      value={c.role}
                      onChange={(e) => {
                        const newC = [...colors];
                        newC[i] = { ...newC[i], role: e.target.value };
                        setColors(newC);
                      }}
                      className="h-8 text-sm w-1/2"
                    />
                    <Select
                      value={c.colorId}
                      onValueChange={(val) => {
                        if (val === "__new__") {
                          setPendingColorRow(i);
                          setNewColorDialogOpen(true);
                          return;
                        }
                        const newC = [...colors];
                        newC[i] = { ...newC[i], colorId: val };
                        setColors(newC);
                      }}
                    >
                      <SelectTrigger className="h-8 text-sm w-1/2">
                        <SelectValue placeholder="Select color" />
                      </SelectTrigger>
                      <SelectContent>
                        {catalogColors.map((catC) => (
                          <SelectItem key={catC.id} value={catC.id}>
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 rounded-full border border-slate-700" style={{ backgroundColor: catC.hex }} />
                              {catC.name}
                            </div>
                          </SelectItem>
                        ))}
                        <SelectItem value="__new__">
                          <div className="flex items-center gap-2 text-blue-400">
                            <Plus size={12} /> New catalog color…
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <Button variant="ghost" size="icon" onClick={() => setColors(colors.filter((_, idx) => idx !== i))} className="h-8 w-8 text-slate-500 hover:text-red-400">
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => setColors([...colors, { role: "", colorId: "" }])} className="h-7 text-xs border-dashed text-slate-400 w-full">
                  <Plus size={14} className="mr-1" /> Add Color
                </Button>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 block">Typography</label>
              <div className="space-y-3">
                {typography.map((t, i) => (
                  <div key={i} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="Role (e.g. Headings)"
                        value={t.role}
                        onChange={(e) => {
                          const newT = [...typography];
                          newT[i] = { ...newT[i], role: e.target.value };
                          setTypography(newT);
                        }}
                        className="h-8 text-sm w-1/2"
                      />
                      <Input
                        placeholder="Font name"
                        value={t.fontName}
                        onChange={(e) => {
                          const newT = [...typography];
                          newT[i] = { ...newT[i], fontName: e.target.value };
                          setTypography(newT);
                        }}
                        className="h-8 text-sm w-1/2"
                      />
                      <Button variant="ghost" size="icon" onClick={() => setTypography(typography.filter((_, idx) => idx !== i))} className="h-8 w-8 text-slate-500 hover:text-red-400 shrink-0">
                        <Trash2 size={14} />
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        placeholder="Capitalization (e.g. ALL CAPS)"
                        value={t.capitalization}
                        onChange={(e) => {
                          const newT = [...typography];
                          newT[i] = { ...newT[i], capitalization: e.target.value };
                          setTypography(newT);
                        }}
                        className="h-8 text-sm w-1/2"
                      />
                      <Input
                        placeholder="Usage notes / exceptions"
                        value={t.usageNotes}
                        onChange={(e) => {
                          const newT = [...typography];
                          newT[i] = { ...newT[i], usageNotes: e.target.value };
                          setTypography(newT);
                        }}
                        className="h-8 text-sm flex-1"
                      />
                    </div>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setTypography([...typography, { role: "", fontName: "", capitalization: "", usageNotes: "" }])}
                  className="h-7 text-xs border-dashed text-slate-400 w-full"
                  data-testid="button-add-typography"
                >
                  <Plus size={14} className="mr-1" /> Add Font Rule
                </Button>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 block">Brand Notes</label>
              <Textarea
                placeholder="Specific instructions for this brand..."
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="text-sm min-h-[100px] resize-y"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {isEmpty && !hasRetired ? (
              <div className="text-center py-8 text-slate-500 text-sm flex flex-col items-center">
                <div className="w-12 h-12 rounded-full bg-slate-800/50 flex items-center justify-center mb-3">
                  <Palette size={20} className="text-slate-500" />
                </div>
                No brand standards configured.
              </div>
            ) : (
              <>
                {currentColors.length > 0 && (
                  <div>
                    <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2.5 flex items-center gap-1.5"><Palette size={12} /> Colors</h3>
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                      {currentColors.map((c) => (
                        <ColorStandard key={c.assignmentId} color={c} />
                      ))}
                    </div>
                  </div>
                )}

                {currentTypography.length > 0 && (
                  <div>
                    <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2.5 flex items-center gap-1.5"><Type size={12} /> Typography</h3>
                    <div className="space-y-2">
                      {currentTypography.map((t) => (
                        <TypographyRow key={t.id} entry={t} />
                      ))}
                    </div>
                  </div>
                )}

                {branding.notes && (
                  <div>
                    <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2.5 flex items-center gap-1.5"><FileText size={12} /> Notes</h3>
                    <p className="text-sm text-slate-300 whitespace-pre-wrap leading-relaxed bg-slate-800/20 p-3 rounded-lg border border-slate-800/50">
                      {branding.notes}
                    </p>
                  </div>
                )}

                {hasRetired && (
                  <div className="border-t border-slate-800/70 pt-4">
                    <button
                      type="button"
                      onClick={() => setShowRetired(!showRetired)}
                      className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 uppercase tracking-wider hover:text-slate-300"
                      data-testid="button-toggle-retired"
                    >
                      {showRetired ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <Archive size={12} /> Retired standards ({retiredColors.length + retiredTypography.length})
                    </button>
                    {showRetired && (
                      <div className="mt-3 space-y-3">
                        {retiredColors.length > 0 && (
                          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                            {retiredColors.map((c) => (
                              <ColorStandard key={c.assignmentId} color={c} />
                            ))}
                          </div>
                        )}
                        {retiredTypography.length > 0 && (
                          <div className="space-y-2">
                            {retiredTypography.map((t) => (
                              <TypographyRow key={t.id} entry={t} />
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {branding.audit && (
                  <p className="text-[11px] text-slate-600">
                    Last updated {formatEventDate(branding.audit.updatedAt)} by {branding.audit.updatedByEmail}
                  </p>
                )}

                {currentColors.length > 0 && (
                  <div className="pt-4 border-t border-slate-800/80">
                    <Button
                      variant="outline"
                      onClick={() => setLocation(`/collections?customerId=${customerId}`)}
                      className="w-full text-blue-400 border-blue-500/30 hover:bg-blue-500/10 hover:text-blue-300 shadow-sm"
                      data-testid={`button-suggest-collection-${customerId}`}
                    >
                      <Palette size={14} className="mr-2" />
                      Build Collection from Palette
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <HistoryDialog events={branding.events || []} open={showHistory} onOpenChange={setShowHistory} />
      <NewCatalogColorDialog
        open={newColorDialogOpen}
        onOpenChange={setNewColorDialogOpen}
        onCreated={(newId) => {
          if (pendingColorRow !== null) {
            setColors((prev) => prev.map((c, idx) => (idx === pendingColorRow ? { ...c, colorId: newId } : c)));
            setPendingColorRow(null);
          }
        }}
      />
    </div>
  );
}
