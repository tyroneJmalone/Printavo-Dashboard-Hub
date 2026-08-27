import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from "@/components/ui/accordion";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Palette, Wand2, Loader2, Check, ChevronRight,
  CheckCircle2, AlertCircle, Trash2, Save, Image as ImageIcon
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  usePreviewCollectionPalette,
  useCreateCollectionFromSuggestion,
  useListDirectoryCustomers,
  getListDirectoryCustomersQueryKey,
  useGetCustomerBranding,
  getGetCustomerBrandingQueryKey,
  PaletteCollectionPreviewResponse,
  useGetCustomerProfile,
  getGetCustomerProfileQueryKey,
  PaletteColorSuggestion,
  PaletteCollectionPreviewResponseAmbiguousItem,
  PaletteCollectionPreviewResponseAmbiguousItemCandidatesItem,
  PaletteCollectionPreviewResponseUnresolvedItem,
  ReviewedPaletteItemRequestVendor
} from "@workspace/api-client-react";
import { getListCollectionsQueryKey } from "@workspace/api-client-react";

// ----------------------------------------------------------------------
// SUB-COMPONENTS
// ----------------------------------------------------------------------

interface CustomerOption {
  printavoId: string;
  displayName: string;
  contactEmail?: string | null;
}

interface CustomerSearchComboBoxProps {
  value: CustomerOption | null;
  onChange: (v: CustomerOption | null) => void;
  initialId?: string | null;
}

function CustomerSearchComboBox({ value, onChange, initialId }: CustomerSearchComboBoxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setQuery(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Handle exact initial fetch if not yet selected
  const { data: profile } = useGetCustomerProfile(initialId || '', undefined, {
    query: {
      enabled: !!initialId && !value,
      queryKey: getGetCustomerProfileQueryKey(initialId || '')
    }
  });

  useEffect(() => {
    if (initialId && !value && profile && profile.printavoId === initialId) {
      onChange({
        printavoId: profile.printavoId,
        displayName: profile.displayName || "Unknown",
        contactEmail: profile.contactEmail
      });
    }
  }, [initialId, value, profile, onChange]);

  const { data: searchData, isLoading } = useListDirectoryCustomers(
    { search: query, limit: 10 },
    { query: { enabled: open, queryKey: getListDirectoryCustomersQueryKey({ search: query, limit: 10 }) } }
  );

  const results = searchData?.customers || [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between bg-slate-950 border-slate-800 text-slate-200 shadow-sm"
          data-testid="combobox-customer-search"
        >
          <span className="truncate pr-2">
             {value ? value.displayName : "Select a customer..."}
          </span>
          <ChevronRight className="ml-2 h-4 w-4 shrink-0 opacity-50 rotate-90" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0 border-slate-800 bg-slate-950 shadow-xl" align="start">
        <Command className="bg-transparent" shouldFilter={false}>
          <CommandInput
            placeholder="Search customers..."
            value={search}
            onValueChange={setSearch}
            className="border-slate-800"
            data-testid="input-customer-search"
          />
          <CommandList className="custom-scrollbar">
            <CommandEmpty className="py-6 text-center text-sm text-slate-500">
              {isLoading ? "Searching..." : "No customers found."}
            </CommandEmpty>
            <CommandGroup>
              {results.map((customer) => (
                <CommandItem
                  key={customer.printavoId}
                  value={customer.printavoId}
                  onSelect={() => {
                    onChange({
                      printavoId: customer.printavoId,
                      displayName: customer.displayName,
                      contactEmail: customer.contactEmail
                    });
                    setOpen(false);
                  }}
                  className="text-slate-200 hover:bg-slate-800 cursor-pointer"
                  data-testid={`item-customer-${customer.printavoId}`}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4 shrink-0",
                      value?.printavoId === customer.printavoId ? "opacity-100 text-emerald-500" : "opacity-0"
                    )}
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate font-medium">{customer.displayName}</span>
                    {customer.contactEmail && <span className="text-[10px] text-slate-500 truncate">{customer.contactEmail}</span>}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ColorCard({ styleKey, color, isSelected, onToggle }: { styleKey: string, color: PaletteColorSuggestion, isSelected: boolean, onToggle: () => void }) {
  const safeStyleKey = styleKey.replace(/[^a-zA-Z0-9]/g, '-');
  const safeColorName = color.colorName.replace(/[^a-zA-Z0-9]/g, '-');

  return (
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={onToggle}
      className={cn(
        "relative flex flex-col p-3 rounded-xl border cursor-pointer transition-all h-full w-full text-left",
        isSelected
          ? "border-emerald-500/50 bg-emerald-500/10 shadow-[0_0_15px_rgba(16,185,129,0.05)]"
          : "border-slate-800 bg-slate-900/40 hover:border-slate-700 hover:bg-slate-900/80"
      )}
      data-testid={`card-color-${safeStyleKey}-${safeColorName}`}
    >
      <div className="flex gap-3 w-full">
        {color.swatchImage ? (
          <img src={color.swatchImage} alt={color.colorName} className="w-10 h-10 rounded-md object-cover shadow-sm bg-slate-950 border border-slate-800 flex-shrink-0" />
        ) : (
          <div className="w-10 h-10 rounded-md bg-slate-950 border border-slate-800 flex items-center justify-center text-[10px] text-slate-500 text-center leading-none p-1 flex-shrink-0">No Swatch</div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex justify-between items-start">
            <h4 className="text-sm font-bold text-slate-200 truncate pr-6" title={color.colorName}>{color.colorName}</h4>
            <div className={cn(
              "absolute right-3 top-3 w-4 h-4 rounded-full border flex items-center justify-center transition-colors shadow-sm",
              isSelected ? "bg-emerald-500 border-emerald-500 text-white" : "border-slate-600 bg-slate-900/50"
            )}>
              {isSelected && <Check size={10} strokeWidth={4} />}
            </div>
          </div>

          <div className="mt-1 space-y-2">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full shadow-[0_0_0_1px_rgba(255,255,255,0.1)] flex-shrink-0" style={{ backgroundColor: color.matchedCustomer.hex || '#000' }} />
              <span className="text-[11px] text-slate-300 truncate" title={color.matchedCustomer.name}>
                <span className="text-slate-500">For:</span> {color.matchedCustomer.role}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="text-[9px] uppercase tracking-wider py-0 px-1 h-4 bg-slate-900 border-slate-700 text-slate-400">
                {color.matchMethod.replace('_', ' ')}
              </Badge>
              <Badge variant="outline" className={cn(
                "text-[9px] uppercase tracking-wider py-0 px-1 h-4 border",
                color.confidence === 'high' ? "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" :
                color.confidence === 'medium' ? "text-amber-400 border-amber-500/30 bg-amber-500/10" :
                "text-slate-400 border-slate-700 bg-slate-800"
              )}>
                {color.confidence}
              </Badge>
            </div>
          </div>
        </div>
      </div>
      {color.reason && (
        <div className="mt-3 text-[10px] text-slate-400 bg-slate-950/50 p-2 rounded-lg border border-slate-800/50 leading-relaxed italic border-l-2 border-l-slate-700 w-full">
          "{color.reason}"
        </div>
      )}
    </button>
  );
}

// ----------------------------------------------------------------------
// MAIN WORKFLOW COMPONENT
// ----------------------------------------------------------------------

interface SuggestCollectionWorkflowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialCustomerId?: string | null;
}

const parseStyles = (input: string) => {
  const parts = input
    .split(/[\n,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);

  const unique = new Map<string, string>();
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (!unique.has(lower)) {
      unique.set(lower, p);
    }
  }
  return Array.from(unique.values());
};

export default function SuggestCollectionWorkflow({ open, onOpenChange, initialCustomerId }: SuggestCollectionWorkflowProps) {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [selectedCustomer, setSelectedCustomer] = useState<CustomerOption | null>(null);
  const [stylesInput, setStylesInput] = useState("");

  const [collectionName, setCollectionName] = useState("");
  const [collectionNotes, setCollectionNotes] = useState("");

  const [previewData, setPreviewData] = useState<PaletteCollectionPreviewResponse | null>(null);
  const [selectedColors, setSelectedColors] = useState<Record<string, string[]>>({});

  const previewReqIdRef = useRef(0);
  const inputSignatureRef = useRef<{ customerId: string | undefined; styles: string[] }>({ customerId: undefined, styles: [] });
  const [previewSnapshot, setPreviewSnapshot] = useState<{ customerId: string; styles: string[] } | null>(null);

  const [hasManuallyEditedName, setHasManuallyEditedName] = useState(false);

  const invalidatePreview = () => {
    previewReqIdRef.current++;
    setPreviewData(null);
    setPreviewSnapshot(null);
    setSelectedColors({});
  };

  const handleCustomerChange = (c: CustomerOption | null) => {
    setSelectedCustomer(c);
    inputSignatureRef.current = {
      customerId: c?.printavoId,
      styles: parseStyles(stylesInput)
    };
    invalidatePreview();
    setHasManuallyEditedName(false);
    setCollectionName("");
  };

  const handleStylesChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setStylesInput(val);
    inputSignatureRef.current = {
      customerId: selectedCustomer?.printavoId,
      styles: parseStyles(val)
    };
    invalidatePreview();
  };

  // Auto-set name when customer is selected
  useEffect(() => {
    if (selectedCustomer && !hasManuallyEditedName && !collectionName && !previewData) {
      setCollectionName(`${selectedCustomer.displayName} Palette Collection`);
    }
  }, [selectedCustomer, hasManuallyEditedName, collectionName, previewData]);

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setCollectionName(e.target.value);
    setHasManuallyEditedName(true);
  };

  // Fetch customer branding for the left pane
  const { data: branding } = useGetCustomerBranding(selectedCustomer?.printavoId as string, {
    query: {
      enabled: !!selectedCustomer?.printavoId,
      queryKey: getGetCustomerBrandingQueryKey(selectedCustomer?.printavoId as string)
    }
  });

  const previewMut = usePreviewCollectionPalette();

  const runPreview = (customerId: string, styles: string[]) => {
    const reqId = ++previewReqIdRef.current;
    
    // Ensure signature reflects the requested preview
    inputSignatureRef.current = { customerId, styles };

    previewMut.mutate(
      { data: { printavoCustomerId: customerId, styles } },
      {
        onSuccess: (data) => {
          if (previewReqIdRef.current !== reqId) return;
          
          const sig = inputSignatureRef.current;
          if (
            sig.customerId !== customerId || 
            sig.styles.length !== styles.length || 
            sig.styles.some((s, i) => s !== styles[i])
          ) {
            return; // Ignore if current input signature has diverged
          }

          setPreviewData(data);
          setPreviewSnapshot({ customerId, styles });

          // Initialize color selections (default to best match, ignore score=0 or unknown method)
          const initialSelected: Record<string, string[]> = {};
          data.suggestions.forEach(s => {
            const styleKey = `${s.vendor}:${s.styleName}`;
            if (s.colors && s.colors.length > 0) {
              const best = s.colors[0];
              if (best.score > 0 && best.matchMethod !== 'unknown') {
                initialSelected[styleKey] = [best.colorName];
              } else {
                initialSelected[styleKey] = [];
              }
            } else {
              initialSelected[styleKey] = [];
            }
          });
          setSelectedColors(initialSelected);
        },
        onError: (err: unknown) => {
          if (previewReqIdRef.current !== reqId) return;
          const errorObj = err as { error?: string };
          toast({ title: "Preview failed", description: String(errorObj.error || err), variant: "destructive" });
        }
      }
    );
  };

  const createMut = useCreateCollectionFromSuggestion({
    mutation: {
      onSuccess: (data) => {
        toast({ title: "Collection created successfully" });
        qc.invalidateQueries({ queryKey: getListCollectionsQueryKey() });
        onOpenChange(false);
        setLocation(`/collections/${data.id}`);
      },
      onError: (err: unknown) => {
        const errorObj = err as { error?: string };
        toast({ title: "Failed to save collection", description: String(errorObj.error || err), variant: "destructive" });
      }
    }
  });

  const parsedStyles = parseStyles(stylesInput);
  const stylesCount = parsedStyles.length;

  const currentCustomerId = selectedCustomer?.printavoId;
  const isStale = previewSnapshot ? (
    currentCustomerId !== previewSnapshot.customerId ||
    parsedStyles.length !== previewSnapshot.styles.length ||
    parsedStyles.some((s, i) => s !== previewSnapshot.styles[i])
  ) : false;

  // Immediately clear on stale to prevent saving invalid states
  // We keep this to clear the view on generic changes, though Save is now synchronously blocked.
  useEffect(() => {
    if (isStale) {
      setPreviewData(null);
      setPreviewSnapshot(null);
      setSelectedColors({});
    }
  }, [isStale]);

  const handlePreview = () => {
    if (!selectedCustomer || stylesCount === 0) {
      toast({ title: "Input required", description: "Select a customer and enter at least one style.", variant: "destructive" });
      return;
    }
    if (stylesCount > 30) {
      toast({ title: "Too many styles", description: "You can preview up to 30 styles at a time.", variant: "destructive" });
      return;
    }
    runPreview(selectedCustomer.printavoId, parsedStyles);
  };

  const resolveAmbiguous = (originalInput: string, explicitPrefix: string) => {
    const current = parseStyles(stylesInput);
    const lowerInput = originalInput.toLowerCase();
    const idx = current.findIndex(s => s.toLowerCase() === lowerInput);
    if (idx > -1) {
      current[idx] = explicitPrefix;
      const newStr = current.join('\n');
      setStylesInput(newStr);
      inputSignatureRef.current = { customerId: selectedCustomer!.printavoId, styles: current };

      // Auto re-run
      runPreview(selectedCustomer!.printavoId, current);
    }
  };

  const removeStyle = (inputVal: string) => {
    const lowerInput = inputVal.toLowerCase();
    const current = parseStyles(stylesInput).filter(s => s.toLowerCase() !== lowerInput);
    const newStr = current.join('\n');
    setStylesInput(newStr);
    inputSignatureRef.current = { customerId: selectedCustomer!.printavoId, styles: current };

    if (current.length === 0) {
      invalidatePreview();
      return;
    }

    if (current.length <= 30) {
      // Auto re-run
      runPreview(selectedCustomer!.printavoId, current);
    } else {
      invalidatePreview();
    }
  };

  const toggleColor = (styleKey: string, colorName: string) => {
    setSelectedColors(prev => {
      const current = prev[styleKey] || [];
      if (current.includes(colorName)) {
        return { ...prev, [styleKey]: current.filter(c => c !== colorName) };
      } else {
        return { ...prev, [styleKey]: [...current, colorName] };
      }
    });
  };

  const handleSave = () => {
    if (!selectedCustomer || !previewData || !previewSnapshot) return;
    if (isStale) {
      toast({ title: "Stale preview", description: "Please generate a new preview before saving.", variant: "destructive" });
      return;
    }
    
    const items = previewData.suggestions.map(s => {
      const styleKey = `${s.vendor}:${s.styleName}`;
      const selected = selectedColors[styleKey] || [];
      return {
        vendor: s.vendor as ReviewedPaletteItemRequestVendor,
        styleName: s.styleName,
        colors: selected
      };
    }).filter(item => item.colors.length > 0);

    if (items.length === 0) {
      toast({ title: "No items", description: "Select at least one color for a style.", variant: "destructive" });
      return;
    }

    createMut.mutate({
      data: {
        name: collectionName || 'Palette Collection',
        printavoCustomerId: selectedCustomer.printavoId,
        notes: collectionNotes || null,
        items: items
      }
    });
  };

  // Reset state when fully closed
  useEffect(() => {
    if (!open) {
      // Small timeout to allow transition to finish
      const t = setTimeout(() => {
        invalidatePreview();
        setStylesInput("");
        setCollectionName("");
        setCollectionNotes("");
        setHasManuallyEditedName(false);
        if (!initialCustomerId) setSelectedCustomer(null);
      }, 300);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open, initialCustomerId]);

  const hasSelectedColors = Object.values(selectedColors).some(arr => arr.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[95vw] w-full max-h-[90dvh] h-[90dvh] p-0 flex flex-col md:flex-row overflow-hidden border-slate-700 bg-slate-950 shadow-2xl">
        <DialogTitle className="sr-only">Suggest Collection from Palette</DialogTitle>

        {/* Left Pane - Configuration */}
        <div className="w-full md:w-80 border-b md:border-b-0 md:border-r border-slate-800 bg-slate-900/50 flex flex-col flex-shrink-0 z-10 shadow-lg min-h-0 md:min-h-full">
          <div className="p-4 md:p-5 border-b border-slate-800 bg-slate-900/80">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <Palette className="text-blue-400" size={18} />
              Palette Match
            </h2>
            <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
              Suggest exact vendor colors based on a customer's brand standards.
            </p>
          </div>

          <div className="p-4 md:p-5 flex-1 overflow-y-auto flex flex-col gap-4 md:gap-6 custom-scrollbar min-h-[30vh]">
            <div className="space-y-2">
              <Label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Customer</Label>
              <CustomerSearchComboBox
                value={selectedCustomer}
                onChange={handleCustomerChange}
                initialId={initialCustomerId}
              />
            </div>

            <div className="space-y-2 flex-1 flex flex-col min-h-[150px]">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Garment Styles</Label>
                <span className={cn("text-[10px] font-mono", stylesCount > 30 ? "text-red-400" : "text-slate-500")}>
                  {stylesCount}/30
                </span>
              </div>
              <Textarea
                placeholder="Paste styles... e.g. 8000, 3001C, sanmar:PC54"
                className="flex-1 resize-none bg-slate-950 border-slate-800 text-sm font-mono text-slate-300 placeholder:text-slate-600 placeholder:font-sans focus-visible:ring-blue-500/50 shadow-inner"
                value={stylesInput}
                onChange={handleStylesChange}
                data-testid="textarea-styles-input"
              />
              <div className="text-[10px] text-slate-500 leading-tight">
                Comma, space, or newline separated. Provide specific prefixes (sanmar:, ss:) for faster resolution.
              </div>
            </div>

            {/* Contextual Brand Palette */}
            {selectedCustomer && branding?.colors && (
              <div className="space-y-3 pt-5 border-t border-slate-800/80">
                <Label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                  <CheckCircle2 size={12} className="text-emerald-500" />
                  Active Palette
                </Label>
                {branding.colors.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {branding.colors.map(c => (
                      <div key={c.id} className="flex items-center gap-1.5 bg-slate-950 border border-slate-800 rounded px-2 py-1 shadow-sm" title={`${c.role}: ${c.name}`}>
                        <div className="w-2.5 h-2.5 rounded-full border border-slate-700 shadow-[0_0_0_1px_rgba(255,255,255,0.05)]" style={{ backgroundColor: c.hex || 'transparent' }} />
                        <span className="text-[10px] font-medium text-slate-300 max-w-[80px] truncate">{c.role}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-slate-500 italic">No colors defined in brand standards.</div>
                )}
              </div>
            )}
          </div>

          <div className="p-4 md:p-5 border-t border-slate-800 bg-slate-900/80">
            <Button
              onClick={handlePreview}
              disabled={!selectedCustomer || stylesCount === 0 || previewMut.isPending || stylesCount > 30}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold h-10 shadow-lg shadow-blue-500/10"
              data-testid="button-generate-preview"
            >
              {previewMut.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Wand2 className="w-4 h-4 mr-2" />}
              {stylesCount > 30 ? "Too many styles" : "Preview Matches"}
            </Button>
          </div>
        </div>

        {/* Right Pane - Results & Review */}
        <div className="flex-1 flex flex-col min-h-0 bg-slate-950 relative">
          {!previewData && !previewMut.isPending ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-500">
              <div className="w-20 h-20 rounded-3xl bg-slate-900 border border-slate-800 flex items-center justify-center mb-6 shadow-inner">
                <Palette className="w-10 h-10 text-slate-700" />
              </div>
              <h3 className="text-xl font-bold text-slate-300 mb-2 tracking-tight">Ready to match</h3>
              <p className="text-sm max-w-sm leading-relaxed">
                Select a customer and enter garment styles to see automated color suggestions based on their brand palette.
              </p>
            </div>
          ) : previewMut.isPending ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-slate-400">
              <div className="relative">
                <div className="absolute inset-0 bg-blue-500/20 blur-xl rounded-full"></div>
                <Loader2 className="w-10 h-10 animate-spin text-blue-500 mb-6 relative z-10" />
              </div>
              <p className="animate-pulse font-medium">Matching palette and evaluating alternatives...</p>
            </div>
          ) : previewData ? (
            <>
              {/* Review Header */}
              <div className="px-4 py-4 md:px-6 md:py-5 border-b border-slate-800 bg-slate-900/40 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 flex-shrink-0 z-10">
                 <div className="flex flex-col md:flex-row gap-3 md:gap-4 items-stretch md:items-center flex-1 w-full md:mr-6">
                    <div className="w-full md:w-1/3">
                      <Input
                        value={collectionName}
                        onChange={handleNameChange}
                        placeholder="Collection Name"
                        className="bg-slate-950 border-slate-700 font-bold text-slate-200 h-10"
                        data-testid="input-collection-name"
                      />
                    </div>
                    <div className="w-full md:flex-1">
                      <Input
                        value={collectionNotes}
                        onChange={e => setCollectionNotes(e.target.value)}
                        placeholder="Optional notes for this collection..."
                        className="bg-slate-950 border-slate-700 text-slate-300 h-10"
                        data-testid="input-collection-notes"
                      />
                    </div>
                 </div>
                 <Button
                   onClick={handleSave}
                   disabled={createMut.isPending || !hasSelectedColors || !previewSnapshot || isStale}
                   className="bg-[#059669] hover:bg-[#047857] text-white w-full md:w-auto flex-shrink-0 font-bold h-10 px-6 shadow-lg shadow-emerald-500/10"
                   data-testid="button-save-collection"
                 >
                   {createMut.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                   Save Collection
                 </Button>
              </div>

              {/* Review Content */}
              <div className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 space-y-6 md:space-y-10 custom-scrollbar relative">

                {/* Needs Attention */}
                {(previewData.unresolved.length > 0 || previewData.ambiguous.length > 0) && (
                  <div className="space-y-4" data-testid="section-needs-attention">
                    <h3 className="text-[11px] font-bold text-amber-500 flex items-center gap-2 uppercase tracking-wider">
                      <AlertCircle size={14} /> Needs Attention
                    </h3>

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                      {previewData.ambiguous.map((amb: PaletteCollectionPreviewResponseAmbiguousItem, i: number) => (
                        <div key={`amb-${i}`} className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-5 shadow-sm">
                          <div className="text-sm font-bold text-slate-200 mb-1">
                            Multiple matches for <span className="text-amber-400 font-mono bg-amber-500/10 px-1.5 py-0.5 rounded ml-1 border border-amber-500/20">{amb.input}</span>
                          </div>
                          <p className="text-[11px] text-slate-400 mb-4">Select the correct product to resolve the ambiguity.</p>
                          <div className="space-y-2">
                            {amb.candidates.map((cand: PaletteCollectionPreviewResponseAmbiguousItemCandidatesItem) => (
                              <button
                                type="button"
                                key={`${cand.vendor}-${cand.styleName}`}
                                onClick={() => resolveAmbiguous(amb.input, `${cand.vendor}:${cand.styleName}`)}
                                className="w-full flex items-center justify-between p-2.5 rounded-lg bg-slate-900 border border-slate-700 hover:border-amber-500/50 hover:bg-slate-800 transition-all text-left group"
                                data-testid={`button-resolve-${cand.vendor}-${cand.styleName}`}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="text-sm font-bold text-slate-200 truncate group-hover:text-amber-400 transition-colors">
                                    {cand.styleName} <span className="text-slate-500 font-normal ml-1">{cand.brand || cand.vendor}</span>
                                  </div>
                                  {cand.title && <div className="text-[10px] text-slate-400 truncate mt-0.5">{cand.title}</div>}
                                </div>
                                <ChevronRight size={14} className="text-slate-500 ml-3 flex-shrink-0 group-hover:text-amber-400 transition-colors" />
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}

                      {previewData.unresolved.map((unres: PaletteCollectionPreviewResponseUnresolvedItem, i: number) => (
                        <div key={`unres-${i}`} className="bg-red-500/5 border border-red-500/20 rounded-xl p-5 flex flex-col shadow-sm">
                          <div className="text-sm font-bold text-slate-200 mb-1">
                            Could not resolve <span className="text-red-400 font-mono bg-red-500/10 px-1.5 py-0.5 rounded ml-1 border border-red-500/20">{unres.input}</span>
                          </div>
                          <p className="text-xs text-red-400/80 mb-5 flex-1 leading-relaxed">{unres.reason}</p>
                          <Button
                            variant="outline"
                            onClick={() => removeStyle(unres.input)}
                            className="w-full border-red-500/30 text-red-400 hover:bg-red-500/10 hover:text-red-300 hover:border-red-500/50 transition-colors"
                            data-testid={`button-remove-unresolved-${unres.input.replace(/[^a-zA-Z0-9]/g, '-')}`}
                          >
                            <Trash2 size={14} className="mr-1.5" /> Remove from list
                          </Button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Suggestions */}
                {previewData.suggestions.length > 0 && (
                  <div className="space-y-5" data-testid="section-suggestions">
                    <h3 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-2">
                      <CheckCircle2 size={14} className="text-emerald-500" /> Matched Styles ({previewData.suggestions.length})
                    </h3>

                    <div className="space-y-6">
                      {previewData.suggestions.map((sug) => {
                        const styleKey = `${sug.vendor}:${sug.styleName}`;
                        const selectedForStyle = selectedColors[styleKey] || [];

                        return (
                          <div key={styleKey} className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-xl shadow-black/50">
                            {/* Style Header */}
                            <div className="p-4 md:p-5 border-b border-slate-800 bg-slate-900/60 flex items-center gap-4">
                               {sug.styleImage ? (
                                 <img src={sug.styleImage} alt={sug.styleName} className="w-16 h-16 rounded-lg object-contain bg-white/5 p-1 flex-shrink-0 border border-white/5 shadow-sm" />
                               ) : (
                                 <div className="w-16 h-16 rounded-lg bg-slate-800 border border-slate-700 flex items-center justify-center flex-shrink-0 text-slate-500 shadow-sm"><ImageIcon size={24} /></div>
                               )}
                               <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 mb-1.5">
                                    <Badge variant="secondary" className="bg-slate-800 text-slate-300 hover:bg-slate-700 uppercase text-[9px] font-bold tracking-wider py-0.5 px-2 rounded-md shadow-sm border border-slate-700/50">{sug.vendor}</Badge>
                                    <span className="text-xs font-medium text-slate-400 truncate">{sug.brand}</span>
                                  </div>
                                  <h4 className="text-lg font-bold text-white truncate tracking-tight">{sug.styleName} {sug.title && <span className="font-normal text-slate-400">· {sug.title}</span>}</h4>
                               </div>
                               <Button
                                 variant="ghost"
                                 size="icon"
                                 onClick={() => removeStyle(sug.input)}
                                 className="text-slate-500 hover:text-red-400 hover:bg-red-500/10 flex-shrink-0 transition-colors"
                                 title="Remove style"
                                 data-testid={`button-remove-style-${sug.styleName}`}
                               >
                                 <Trash2 size={18} />
                               </Button>
                            </div>

                            {/* Colors Grid */}
                            <div className="p-4 md:p-5">
                              <h5 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-4">Recommended Matches</h5>
                              {sug.colors.length > 0 ? (
                                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
                                  {sug.colors.map(color => (
                                    <ColorCard
                                      key={color.colorName}
                                      styleKey={styleKey}
                                      color={color}
                                      isSelected={selectedForStyle.includes(color.colorName)}
                                      onToggle={() => toggleColor(styleKey, color.colorName)}
                                    />
                                  ))}
                                </div>
                              ) : (
                                <div className="text-sm text-slate-400 bg-slate-950 p-6 rounded-xl border border-slate-800 text-center flex flex-col items-center">
                                  <AlertCircle size={24} className="text-slate-600 mb-3" />
                                  <span className="font-medium">No direct matches found.</span>
                                  <span className="text-xs text-slate-500 mt-1">This product may not offer colors close to the brand palette.</span>
                                </div>
                              )}

                              {sug.alternatives && sug.alternatives.length > 0 && (
                                <Accordion type="single" collapsible className="mt-5 border-t border-slate-800/50 pt-2">
                                  <AccordionItem value="alts" className="border-0">
                                    <AccordionTrigger className="text-xs font-medium text-slate-400 hover:text-slate-300 py-3 hover:no-underline rounded-lg px-2 hover:bg-slate-800/30 transition-colors">
                                      View Alternative Colors ({sug.alternatives.length})
                                    </AccordionTrigger>
                                    <AccordionContent className="pt-4 pb-2 px-2">
                                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
                                        {sug.alternatives.map(color => (
                                          <ColorCard
                                            key={color.colorName}
                                            styleKey={styleKey}
                                            color={color}
                                            isSelected={selectedForStyle.includes(color.colorName)}
                                            onToggle={() => toggleColor(styleKey, color.colorName)}
                                          />
                                        ))}
                                      </div>
                                    </AccordionContent>
                                  </AccordionItem>
                                </Accordion>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

              </div>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}