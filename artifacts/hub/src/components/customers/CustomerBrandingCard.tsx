import { useState, useEffect } from "react";
import {
  useGetCustomerBranding,
  getGetCustomerBrandingQueryKey,
  useUpdateCustomerBranding,
  useListBrandingColors,
  getListBrandingColorsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useStaff } from "@/components/auth/StaffGate";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Palette, Plus, Trash2, Edit2, Check, X, Type, FileText } from "lucide-react";

export function CustomerBrandingCard({ customerId }: { customerId: string }) {
  const { role } = useStaff();
  const isAdmin = role === "admin";
  const { toast } = useToast();
  const qc = useQueryClient();
  const queryKey = getGetCustomerBrandingQueryKey(customerId);

  const { data: branding, isLoading } = useGetCustomerBranding(customerId, {
    query: { enabled: !!customerId, queryKey }
  });

  const { data: colorsData } = useListBrandingColors({
    query: { enabled: true, queryKey: getListBrandingColorsQueryKey() }
  });
  const catalogColors = colorsData?.colors || [];

  const [isEditing, setIsEditing] = useState(false);

  // Edit state
  const [notes, setNotes] = useState("");
  const [fonts, setFonts] = useState<string[]>([]);
  const [colors, setColors] = useState<{ role: string; colorId: string }[]>([]);

  useEffect(() => {
    if (branding && !isEditing) {
      setNotes(branding.notes || "");
      setFonts(branding.fonts || []);
      setColors(branding.colors?.map(c => ({ role: c.role, colorId: c.id })) || []);
    }
  }, [branding, isEditing]);

  const updateBranding = useUpdateCustomerBranding({
    mutation: {
      onSuccess: () => {
        toast({ title: "Branding updated" });
        setIsEditing(false);
        qc.invalidateQueries({ queryKey });
      },
      onError: (e: any) => {
        toast({ title: "Update failed", description: e.error || "Please try again.", variant: "destructive" });
      }
    }
  });

  const handleSave = () => {
    updateBranding.mutate({
      id: customerId,
      data: {
        notes: notes || null,
        fonts: fonts.filter(f => f.trim() !== ""),
        colors: colors.filter(c => c.role.trim() !== "" && c.colorId)
      }
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

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden flex flex-col">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-900/60">
        <h2 className="text-sm font-semibold text-slate-200 inline-flex items-center gap-2">
          <Palette size={16} className="text-blue-400" />
          Brand Standards
        </h2>
        {isAdmin && (
          !isEditing ? (
            <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)} className="h-7 px-2 text-slate-400 hover:text-white">
              <Edit2 size={14} className="mr-1.5" /> Edit
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)} className="h-7 px-2 text-slate-400">
                <X size={14} className="mr-1.5" /> Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={updateBranding.isPending} className="h-7 px-3 bg-blue-600 hover:bg-blue-500 text-white">
                <Check size={14} className="mr-1.5" /> Save
              </Button>
            </div>
          )
        )}
      </div>

      <div className="p-5 flex-1">
        {isEditing ? (
          <div className="space-y-6">
            <div>
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 block">Brand Colors</label>
              <div className="space-y-3">
                {colors.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      placeholder="Role (e.g. Primary)"
                      value={c.role}
                      onChange={(e) => {
                        const newC = [...colors];
                        newC[i].role = e.target.value;
                        setColors(newC);
                      }}
                      className="h-8 text-sm w-1/2"
                    />
                    <Select
                      value={c.colorId}
                      onValueChange={(val) => {
                        const newC = [...colors];
                        newC[i].colorId = val;
                        setColors(newC);
                      }}
                    >
                      <SelectTrigger className="h-8 text-sm w-1/2">
                        <SelectValue placeholder="Select color" />
                      </SelectTrigger>
                      <SelectContent>
                        {catalogColors.map(catC => (
                          <SelectItem key={catC.id} value={catC.id}>
                            <div className="flex items-center gap-2">
                              <div className="w-3 h-3 rounded-full border border-slate-700" style={{ backgroundColor: catC.hex }} />
                              {catC.name}
                            </div>
                          </SelectItem>
                        ))}
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
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 block">Brand Fonts</label>
              <div className="space-y-2">
                {fonts.map((f, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      placeholder="Font name"
                      value={f}
                      onChange={(e) => {
                        const newF = [...fonts];
                        newF[i] = e.target.value;
                        setFonts(newF);
                      }}
                      className="h-8 text-sm"
                    />
                    <Button variant="ghost" size="icon" onClick={() => setFonts(fonts.filter((_, idx) => idx !== i))} className="h-8 w-8 text-slate-500 hover:text-red-400">
                      <Trash2 size={14} />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => setFonts([...fonts, ""])} className="h-7 text-xs border-dashed text-slate-400 w-full">
                  <Plus size={14} className="mr-1" /> Add Font
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
            {!branding.configured && !branding.notes && (!branding.fonts || branding.fonts.length === 0) && (!branding.colors || branding.colors.length === 0) ? (
              <div className="text-center py-8 text-slate-500 text-sm flex flex-col items-center">
                <div className="w-12 h-12 rounded-full bg-slate-800/50 flex items-center justify-center mb-3">
                  <Palette size={20} className="text-slate-500" />
                </div>
                No brand standards configured.
              </div>
            ) : (
              <>
                {branding.colors && branding.colors.length > 0 && (
                  <div>
                    <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2.5 flex items-center gap-1.5"><Palette size={12} /> Colors</h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {branding.colors.map(c => (
                        <div key={`${c.role}-${c.id}`} className="flex items-center gap-3 p-2 rounded-lg bg-slate-800/40 border border-slate-800">
                          <div className="w-8 h-8 rounded-md border border-slate-700 shadow-sm shrink-0" style={{ backgroundColor: c.hex }} />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs text-slate-400 truncate">{c.role}</p>
                            <p className="text-sm font-medium text-slate-200 truncate">{c.name}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                
                {branding.fonts && branding.fonts.length > 0 && (
                  <div>
                    <h3 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-2.5 flex items-center gap-1.5"><Type size={12} /> Fonts</h3>
                    <div className="flex flex-wrap gap-2">
                      {branding.fonts.map((f, i) => (
                        <span key={i} className="inline-flex px-2.5 py-1 rounded-md bg-slate-800 border border-slate-700 text-slate-200 text-sm">
                          {f}
                        </span>
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
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
