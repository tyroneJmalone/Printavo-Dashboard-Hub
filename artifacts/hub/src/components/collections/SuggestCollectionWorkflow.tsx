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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  Palette, Wand2, Loader2, Check, ChevronRight,
  CheckCircle2, AlertCircle, Save, Trash2, RefreshCw
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
  ReviewedPaletteItemRequestVendor,
  getListCollectionsQueryKey
} from "@workspace/api-client-react";

import { ColorCard } from "./ColorCard";
import { AlternativeColorPicker } from "./AlternativeColorPicker";

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
                      "mr-2 h-4 w-4 shrink-0 text-emerald-500",
                      value?.printavoId === customer.printavoId ? "opacity-100" : "opacity-0"
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

  // Custom added alternatives map: { styleKey: PaletteColorSuggestion[] }
  const [addedAlternatives, setAddedAlternatives] = useState<Record<string, PaletteColorSuggestion[]>>({});
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
    setAddedAlternatives({});
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
          setAddedAlternatives({});
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
  useEffect(() => {
    if (isStale) {
      setPreviewData(null);
      setPreviewSnapshot(null);
      setSelectedColors({});
      setAddedAlternatives({});
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
    if (!selectedCustomer) return;
    const current = parseStyles(stylesInput).filter(style => style.toLowerCase() !== inputVal.toLowerCase());
    setStylesInput(current.join('\n'));
    inputSignatureRef.current = { customerId: selectedCustomer.printavoId, styles: current };
    if (current.length === 0) {
      invalidatePreview();
      return;
    }
    runPreview(selectedCustomer.printavoId, current);
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

  const handleAddAlternative = (styleKey: string, alt: PaletteColorSuggestion) => {
    setAddedAlternatives(prev => {
      const current = prev[styleKey] || [];
      if (current.some(c => c.colorName === alt.colorName)) return prev;
      return { ...prev, [styleKey]: [...current, alt] };
    });
    // Auto-select when added
    toggleColor(styleKey, alt.colorName);
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
              <Palette className="text-emerald-400" size={18} />
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
                className="flex-1 resize-none bg-slate-950 border-slate-800 text-sm font-mono text-slate-300 placeholder:text-slate-600 placeholder:font-sans focus-visible:ring-emerald-500/50 shadow-inner"
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
                    variant="outline"
                    onClick={handlePreview}
                    disabled={previewMut.isPending}
                    className="h-10 w-full shrink-0 border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800 md:w-auto"
                  >
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                    Refresh scores
                  </Button>
                  <Button
              onClick={handlePreview}
              disabled={!selectedCustomer || stylesCount === 0 || previewMut.isPending || stylesCount > 30}
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold h-10 shadow-lg shadow-emerald-500/10"
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
                <div className="absolute inset-0 bg-emerald-500/20 blur-xl rounded-full"></div>
                <Loader2 className="w-10 h-10 animate-spin text-emerald-500 mb-6 relative z-10" />
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
                        className="bg-slate-950 border-slate-700 font-bold text-slate-200 h-10 focus-visible:ring-emerald-500/50"
                        data-testid="input-collection-name"
                      />
                    </div>
                    <div className="w-full md:flex-1">
                      <Input
                        value={collectionNotes}
                        onChange={e => setCollectionNotes(e.target.value)}
                        placeholder="Optional notes for this collection..."
                        className="bg-slate-950 border-slate-700 text-slate-300 h-10 focus-visible:ring-emerald-500/50"
                        data-testid="input-collection-notes"
                      />
                    </div>
                 </div>
                 <Button
                   onClick={handleSave}
                   disabled={createMut.isPending || !hasSelectedColors || !previewSnapshot || isStale}
                   className="bg-emerald-600 hover:bg-emerald-500 text-white w-full md:w-auto flex-shrink-0 font-bold h-10 px-6 shadow-lg shadow-emerald-500/10"
                   data-testid="button-save-collection"
                 >
                   {createMut.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
                   Save Collection
                 </Button>
              </div>

              {/* Review Content */}
              <div className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8 space-y-8 md:space-y-12 custom-scrollbar relative">

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
                                <div>
                                  <div className="font-bold text-slate-200 text-sm group-hover:text-amber-400 transition-colors">
                                    {cand.styleName} <span className="text-slate-500 font-normal ml-1">({cand.brand || 'Unknown'})</span>
                                  </div>
                                  <div className="text-[10px] text-slate-500 truncate max-w-[200px] mt-0.5">{cand.title}</div>
                                </div>
                                <span className="text-[9px] uppercase tracking-wider font-bold text-slate-500 bg-slate-950 px-2 py-1 rounded border border-slate-800 group-hover:border-amber-500/30">
                                  {cand.vendor}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}

                      {previewData.unresolved.length > 0 && (
                        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 shadow-sm">
                           <div className="text-sm font-bold text-slate-200 mb-2">Unrecognized Styles</div>
                           <div className="space-y-2 mb-4">
                             {previewData.unresolved.map((u: PaletteCollectionPreviewResponseUnresolvedItem, i: number) => (
                                <div key={`u-${i}`} className="flex items-center justify-between gap-3 rounded border border-slate-700 bg-slate-950 px-2 py-1.5" title={u.reason}>
                                  <span className="truncate font-mono text-xs text-slate-300">{u.input}</span>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => removeStyle(u.input)}
                                    className="h-6 shrink-0 px-2 text-[10px] text-red-400 hover:bg-red-500/10 hover:text-red-300"
                                    data-testid={`button-remove-unresolved-${u.input.replace(/[^a-zA-Z0-9]/g, '-')}`}
                                  >
                                    <Trash2 className="mr-1 h-3 w-3" /> Remove
                                  </Button>
                               </div>
                             ))}
                           </div>
                           <p className="text-[11px] text-slate-500 leading-relaxed">
                              These inputs didn't match any catalog styles. Check your spelling or ensure they are present in the synced catalogs.
                             They will be skipped if you save.
                           </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Suggestions Grid */}
                {previewData.suggestions.length > 0 && (
                  <div className="space-y-8" data-testid="section-suggestions">
                    {previewData.suggestions.map((suggestion) => {
                      const styleKey = `${suggestion.vendor}:${suggestion.styleName}`;
                       const selectedForStyle = selectedColors[styleKey] || [];

                      const baseColors = suggestion.colors || [];
                      const altColors = addedAlternatives[styleKey] || [];

                      // Combine without duplicates
                      const displayColors = [...baseColors];
                      altColors.forEach(ac => {
                        if (!displayColors.some(dc => dc.colorName === ac.colorName)) {
                          displayColors.push(ac);
                        }
                      });

                      return (
                        <div key={styleKey} className="bg-slate-900 border border-slate-800 rounded-2xl p-5 md:p-6 shadow-sm">
                          {/* Style Header */}
                          <div className="flex gap-4 md:gap-6 mb-6">
                            {suggestion.styleImage ? (
                              <img src={suggestion.styleImage} className="w-16 h-16 md:w-20 md:h-20 object-contain bg-white/5 border border-white/5 rounded-xl shadow-sm" alt={suggestion.styleName} />
                            ) : (
                              <div className="w-16 h-16 md:w-20 md:h-20 rounded-xl bg-slate-950 border border-slate-800 flex items-center justify-center text-xs text-slate-600 flex-shrink-0">
                                No Image
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2 mb-1">
                                <h3 className="text-lg md:text-xl font-bold text-white tracking-tight">{suggestion.styleName}</h3>
                                {suggestion.brand && (
                                  <span className="text-xs font-medium px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-slate-300">
                                    {suggestion.brand}
                                  </span>
                                )}
                                <span className="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-slate-950 border border-slate-800 text-slate-400">
                                  {suggestion.vendor}
                                </span>
                              </div>
                              <p className="text-sm text-slate-300 mb-1">{suggestion.title}</p>
                              {suggestion.description && (
                                <p className="text-xs text-slate-500 line-clamp-2 md:line-clamp-none">{suggestion.description}</p>
                              )}
                              <div className="text-[11px] text-slate-400 mt-2 font-mono bg-slate-950/50 inline-block px-2 py-1 rounded border border-slate-800/50">
                                Sizes: <span className="text-slate-300">{suggestion.sizeRange || suggestion.sizes.join(', ')}</span>
                              </div>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => removeStyle(suggestion.input)}
                              className="h-8 w-8 shrink-0 text-slate-500 hover:bg-red-500/10 hover:text-red-400"
                              title="Remove style"
                              data-testid={`button-remove-style-${suggestion.styleName}`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>

                          {/* Color Options */}
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {displayColors.map(color => (
                              <ColorCard
                                key={color.colorName}
                                styleSuggestion={suggestion}
                                color={color}
                                isSelected={selectedForStyle.includes(color.colorName)}
                                onToggle={() => toggleColor(styleKey, color.colorName)}
                              />
                            ))}
                          </div>

                          {/* Alternative picker if none selected or want more */}
                          <div className="mt-4 md:w-1/3">
                            <AlternativeColorPicker
                              alternatives={suggestion.alternatives || []}
                              onSelect={(c) => handleAddAlternative(styleKey, c)}
                              selectedColorNames={displayColors.map(c => c.colorName)}
                            />
                          </div>
                        </div>
                      );
                    })}
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