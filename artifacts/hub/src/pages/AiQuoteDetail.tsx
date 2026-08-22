import { useState, useEffect, useRef } from "react";
import { useRoute, useLocation, Link } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { 
  useGetAiQuoteDraft, 
  useUpdateAiQuoteDraft, 
  useCreatePrintavoQuoteFromDraft,
  useListDecorationMatrices,
  useProductSearch,
  getGetAiQuoteDraftQueryKey,
  type AiQuoteDraftData,
  type AiQuoteGarment,
  type AiQuoteDecoration,
  type AiQuoteGarmentSelection,
  type AiQuoteProductOption,
  type ProductSearchResult,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { 
  Loader2, ArrowLeft, Save, FileText, CheckCircle2, AlertTriangle,
  Info, ShoppingCart, User, Brush, DollarSign, Search
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

// helper to format currency
const money = (val: number) => `$${val.toFixed(2)}`;

function selectionFromOption(
  garment: AiQuoteGarment,
  option: AiQuoteProductOption,
  requestedColor?: string,
): AiQuoteGarmentSelection | null {
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const color =
    option.colors.find(
      (candidate) =>
        normalize(candidate.name) === normalize(requestedColor ?? garment.color),
    ) ?? option.colors[0];
  if (!color) return null;
  const costs = garment.sizes.map((requested) => {
    const offer = color.sizes.find(
      (size) => normalize(size.size) === normalize(requested.size),
    );
    return offer ? offer.salePrice ?? offer.cost : null;
  });
  if (costs.some((cost) => cost === null)) return null;
  return {
    vendor: option.vendor,
    styleName: option.styleName,
    brand: option.brand,
    title: option.title,
    color: color.name,
    garmentCost: Math.max(...(costs as number[])),
    image: color.image ?? option.image,
  };
}

function optionsFromSearch(result: ProductSearchResult): AiQuoteProductOption[] {
  return result.vendors
    .filter(({ lookup }) => lookup.found && lookup.styleName)
    .map(({ lookup }) => ({
      vendor: lookup.vendor,
      matchType: lookup.matchType === "exact" ? "exact" : "closest",
      styleName: lookup.styleName!,
      brand: lookup.brand,
      title: lookup.title,
      image: lookup.styleImage,
      colors: lookup.colors.map((color) => ({
        name: color.colorName,
        image: color.productImage ?? color.swatchImage,
        sizes: color.sizes.map((size) => ({
          size: size.size,
          cost: size.cost,
          salePrice: size.salePrice,
          inventoryTotal: size.inventoryTotal,
        })),
      })),
    }));
}

function MatchBadge({ type }: { type: string }) {
  if (type === 'exact') return <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-[9px] uppercase font-bold px-1.5 py-0.5 rounded">Exact</span>;
  if (type === 'closest' || type === 'possible') return <span className="bg-amber-500/10 text-amber-400 border border-amber-500/20 text-[9px] uppercase font-bold px-1.5 py-0.5 rounded">{type}</span>;
  return null;
}

export default function AiQuoteDetail() {
  const [, params] = useRoute("/ai-quotes/:id");
  const id = params?.id || "";
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: quoteDraft, isLoading, error } = useGetAiQuoteDraft(id, {
    query: { enabled: !!id, queryKey: getGetAiQuoteDraftQueryKey(id) }
  });

  const { data: matricesData } = useListDecorationMatrices();
  const matrices = matricesData?.matrices || [];

  const updateDraft = useUpdateAiQuoteDraft();
  const createQuote = useCreatePrintavoQuoteFromDraft();
  const refreshProducts = useProductSearch();

  const [draft, setDraft] = useState<AiQuoteDraftData | null>(null);
  const initializedId = useRef<string | null>(null);

  useEffect(() => {
    if (quoteDraft && initializedId.current !== quoteDraft.id) {
      setDraft(quoteDraft.draft);
      initializedId.current = quoteDraft.id;
    }
  }, [quoteDraft]);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createConfirmText, setCreateConfirmText] = useState("");

  if (isLoading) {
    return (
      <AppShell>
        <div className="flex h-full items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-[#10b981]" />
        </div>
      </AppShell>
    );
  }

  if (error || !quoteDraft) {
    return (
      <AppShell>
        <div className="p-6 text-center text-red-400 mt-20">
          <AlertTriangle className="w-10 h-10 mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-2">Error Loading Draft</h2>
          <p>{error ? String(error) : "Draft not found"}</p>
          <Button variant="outline" className="mt-6 border-slate-700 text-slate-300 hover:text-white" onClick={() => setLocation("/ai-quotes")}>Back to List</Button>
        </div>
      </AppShell>
    );
  }

  const isDraft = quoteDraft.status === "draft";
  const isCreating = quoteDraft.status === "creating";
  const isCreated = quoteDraft.status === "created";
  const isUnknown = quoteDraft.status === "unknown";
  const isFailed = quoteDraft.status === "failed";

  const handleSave = () => {
    if (!draft) return;
    updateDraft.mutate({ id, data: { revision: quoteDraft.revision, draft } }, {
      onSuccess: (updated) => {
        queryClient.setQueryData(getGetAiQuoteDraftQueryKey(id), updated);
        setDraft(updated.draft);
        toast({ title: "Draft saved", description: "Your changes have been saved." });
      },
      onError: (err: any) => {
        queryClient.invalidateQueries({ queryKey: getGetAiQuoteDraftQueryKey(id) });
        toast({ title: "Failed to save", description: err.message || "Unknown error", variant: "destructive" });
      }
    });
  };

  const handleCreateQuote = () => {
    createQuote.mutate({
      id,
      data: {
        confirmation: "CREATE QUOTE",
        revision: quoteDraft.revision,
      },
    }, {
      onSuccess: () => {
        setCreateDialogOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetAiQuoteDraftQueryKey(id) });
        toast({ title: "Quote Created!", description: "Check Printavo for details." });
      },
      onError: (err: any) => {
        queryClient.invalidateQueries({ queryKey: getGetAiQuoteDraftQueryKey(id) });
        toast({ title: "Failed to create quote", description: err.message || "Unknown error", variant: "destructive" });
      }
    });
  };

  const updateGarment = (index: number, partial: Partial<AiQuoteGarment>) => {
    setDraft(prev => {
      if (!prev) return prev;
      const newGarments = [...prev.garments];
      newGarments[index] = { ...newGarments[index], ...partial };
      return { ...prev, garments: newGarments };
    });
  };

  const updateDecoration = (index: number, partial: Partial<AiQuoteDecoration>) => {
    setDraft(prev => {
      if (!prev) return prev;
      const newDecorations = [...prev.decorations];
      newDecorations[index] = { ...newDecorations[index], ...partial };
      return { ...prev, decorations: newDecorations };
    });
  };

  const isDirty = draft
    ? JSON.stringify(draft) !== JSON.stringify(quoteDraft.draft)
    : false;

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Top Bar */}
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
          <div className="flex items-center gap-4">
            <Link
              href="/ai-quotes"
              className="p-2 -ml-2 rounded-md hover:bg-slate-800 text-slate-400 hover:text-white transition-colors"
            >
              <ArrowLeft size={20} />
            </Link>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-bold text-white tracking-tight">Draft {id.split("-")[0]}</h1>
                <Badge variant="outline" className={`text-[10px] py-0.5 uppercase tracking-wider font-bold ${
                  isDraft ? "bg-blue-500/10 text-blue-400 border-blue-500/20" :
                  isCreated ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                  isFailed ? "bg-red-500/10 text-red-400 border-red-500/20" :
                  isCreating ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                  "bg-slate-500/10 text-slate-400 border-slate-500/20"
                }`}>
                  {quoteDraft.status}
                </Badge>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            {isDraft && (
              <>
                <Button 
                  variant="outline" 
                  onClick={handleSave}
                  disabled={updateDraft.isPending || !draft}
                  className="bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white"
                >
                  {updateDraft.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                  Save Changes
                </Button>
                <Button 
                  onClick={() => setCreateDialogOpen(true)}
                  disabled={
                    !draft ||
                    isDirty ||
                    draft.warnings.length > 0 ||
                    updateDraft.isPending
                  }
                  title={
                    isDirty
                      ? "Save changes before creating the Printavo quote"
                      : draft?.warnings.length
                        ? "Resolve every review warning before creating the Printavo quote"
                        : undefined
                  }
                  className="bg-[#059669] hover:bg-[#047857] text-white"
                >
                  <FileText className="w-4 h-4 mr-2" />
                  Create Printavo Quote
                </Button>
              </>
            )}
            {isCreating && (
              <Button disabled className="bg-slate-800 text-slate-400 border-transparent">
                <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating...
              </Button>
            )}
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar bg-[#020617]">
          <div className="max-w-6xl mx-auto space-y-6 pb-20">

            {isUnknown && (
              <div className="bg-amber-950/30 border border-amber-900/50 p-5 rounded-xl text-amber-400 flex gap-4 items-start shadow-sm">
                <AlertTriangle className="w-6 h-6 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-bold mb-1 text-base">Manual Verification Required</h3>
                  <p className="text-sm text-amber-500/90 leading-relaxed">
                    Quote creation request was sent to Printavo, but the final outcome is unknown. Please verify manually in Printavo to ensure the quote was created successfully. Do not attempt to create it again here to avoid duplicates.
                  </p>
                </div>
              </div>
            )}

            {isCreated && (
              <div className="bg-emerald-950/30 border border-emerald-900/50 p-5 rounded-xl text-emerald-400 flex items-center justify-between shadow-sm">
                <div className="flex gap-4 items-start">
                  <CheckCircle2 className="w-6 h-6 flex-shrink-0 mt-0.5 text-[#10b981]" />
                  <div>
                    <h3 className="font-bold mb-1 text-base text-[#10b981]">Quote Created Successfully</h3>
                    <p className="text-sm text-emerald-500/90">This draft was successfully converted into a Printavo quote.</p>
                  </div>
                </div>
                 {quoteDraft.printavoVisualId && (
                   <div className="font-mono font-bold bg-[#10b981]/20 px-4 py-2 rounded-lg text-[#10b981]">
                     Printavo quote #{quoteDraft.printavoVisualId}
                   </div>
                 )}
              </div>
            )}

            {isFailed && (
              <div className="bg-red-950/30 border border-red-900/50 p-5 rounded-xl text-red-400 flex gap-4 items-start shadow-sm">
                <AlertTriangle className="w-6 h-6 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="font-bold mb-1 text-base">Creation Failed</h3>
                  <p className="text-sm text-red-500/90 leading-relaxed">
                    {quoteDraft.error || "An error occurred while creating the quote in Printavo."}
                  </p>
                </div>
              </div>
            )}

            {draft && (draft.warnings.length > 0 || draft.uncertainties.length > 0) && (
              <div className="bg-amber-950/20 border border-amber-900/30 p-5 rounded-xl text-amber-500 shadow-sm">
                <div className="flex gap-3 items-center mb-3">
                  <Info className="w-5 h-5 text-amber-500" />
                  <h3 className="font-bold text-amber-500">AI Extraction Notes</h3>
                </div>
                <ul className="list-disc pl-9 space-y-1.5 text-sm text-amber-500/90">
                  {draft.uncertainties.map((u, i) => <li key={`u-${i}`}>{u}</li>)}
                  {draft.warnings.map((w, i) => <li key={`w-${i}`}>{w}</li>)}
                </ul>
              </div>
            )}

            {/* Prompt Context */}
            <div className="bg-[#0f172a] border border-slate-800 rounded-xl overflow-hidden shadow-sm">
               <div className="px-5 py-3 border-b border-slate-800 bg-slate-950/50 flex items-center gap-2">
                 <FileText className="w-4 h-4 text-slate-500" />
                 <h3 className="font-semibold text-slate-300 text-sm">Original Prompt</h3>
               </div>
               <div className="p-5 text-sm text-slate-400 leading-relaxed font-mono whitespace-pre-wrap">
                 {quoteDraft.prompt}
               </div>
            </div>

            {draft && (
              <div className="space-y-6">
                
                {/* General Info */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                  {/* Customer */}
                  <div className="bg-[#0f172a] border border-slate-800 rounded-xl overflow-hidden shadow-sm flex flex-col">
                    <div className="px-5 py-3 border-b border-slate-800 bg-slate-950/50 flex items-center gap-2">
                      <User className="w-4 h-4 text-slate-500" />
                      <h3 className="font-semibold text-slate-300 text-sm">Customer</h3>
                    </div>
                    <div className="p-5 flex-1">
                      <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 block">Match</label>
                      <Select 
                        value={draft.selectedCustomer?.customerId || "none"}
                        onValueChange={(val) => {
                          const cust = draft.customerCandidates.find(c => c.customerId === val);
                          setDraft(prev => prev ? { ...prev, selectedCustomer: cust || null } : prev);
                        }}
                        disabled={!isDraft}
                      >
                        <SelectTrigger className="w-full bg-slate-950 border-slate-800 text-sm h-11">
                          <SelectValue placeholder="Select a customer..." />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">None / Manual Entry Later</SelectItem>
                          {draft.customerCandidates.map(c => (
                            <SelectItem key={c.customerId} value={c.customerId}>
                              <div className="flex items-center justify-between w-full pr-4 gap-4">
                                <span className="font-medium">{c.companyName} <span className="text-slate-500 font-normal">{c.contactName ? `(${c.contactName})` : ''}</span></span>
                                <MatchBadge type={c.matchType} />
                              </div>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {draft.selectedCustomer && (
                        <div className="mt-4 p-4 bg-slate-950/80 rounded-lg border border-slate-800/80">
                          <div className="text-sm font-semibold text-slate-200">{draft.selectedCustomer.companyName}</div>
                          <div className="text-xs text-slate-400 mt-1.5 flex flex-col gap-0.5">
                            <span>{draft.selectedCustomer.contactName || "No contact name"}</span>
                            <span>{draft.selectedCustomer.contactEmail || "No email"}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Details */}
                  <div className="bg-[#0f172a] border border-slate-800 rounded-xl overflow-hidden shadow-sm flex flex-col">
                    <div className="px-5 py-3 border-b border-slate-800 bg-slate-950/50 flex items-center gap-2">
                      <Info className="w-4 h-4 text-slate-500" />
                      <h3 className="font-semibold text-slate-300 text-sm">Quote Details</h3>
                    </div>
                    <div className="p-5 flex-1 grid grid-cols-2 gap-5">
                      <div className="col-span-2">
                        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 block">Nickname</label>
                        <Input 
                          value={draft.nickname} 
                          onChange={e => setDraft(prev => prev ? { ...prev, nickname: e.target.value } : prev)}
                          className="bg-slate-950 border-slate-800 h-10 text-sm font-medium"
                          readOnly={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 block">Due Date</label>
                        <Input 
                           value={draft.dueDate?.slice(0, 10) || ""} 
                          onChange={e => setDraft(prev => prev ? { ...prev, dueDate: e.target.value } : prev)}
                          className="bg-slate-950 border-slate-800 h-10 text-sm font-mono text-slate-300"
                          type="date"
                          readOnly={!isDraft}
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 block">Markup</label>
                        <div className="relative">
                          <Input 
                            value={draft.markup} 
                            onChange={e => setDraft(prev => prev ? { ...prev, markup: parseFloat(e.target.value) || 0 } : prev)}
                            className="bg-slate-950 border-slate-800 h-10 text-sm font-mono pl-3 pr-8 text-slate-300"
                            type="number" step="0.01" min="0"
                            readOnly={!isDraft}
                          />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm font-mono">x</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Notes */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="bg-[#0f172a] border border-slate-800 rounded-xl overflow-hidden shadow-sm">
                    <div className="px-5 py-3 border-b border-slate-800 bg-slate-950/50">
                      <h3 className="font-semibold text-slate-300 text-sm">Customer Note</h3>
                    </div>
                    <div className="p-5">
                      <Textarea 
                        value={draft.customerNote} 
                        onChange={e => setDraft(prev => prev ? { ...prev, customerNote: e.target.value } : prev)}
                        className="bg-slate-950 border-slate-800 min-h-[120px] text-sm resize-y text-slate-300 placeholder:text-slate-600"
                        readOnly={!isDraft}
                        placeholder="Notes visible to the customer..."
                      />
                    </div>
                  </div>
                  <div className="bg-[#0f172a] border border-slate-800 rounded-xl overflow-hidden shadow-sm">
                    <div className="px-5 py-3 border-b border-slate-800 bg-slate-950/50">
                      <h3 className="font-semibold text-slate-300 text-sm">Production Note</h3>
                    </div>
                    <div className="p-5">
                      <Textarea 
                        value={draft.productionNote} 
                        onChange={e => setDraft(prev => prev ? { ...prev, productionNote: e.target.value } : prev)}
                        className="bg-slate-950 border-slate-800 min-h-[120px] text-sm resize-y text-slate-300 placeholder:text-slate-600"
                        readOnly={!isDraft}
                        placeholder="Internal notes for the production team..."
                      />
                    </div>
                  </div>
                </div>

                {/* Garments */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2 mb-2 mt-6">
                    <ShoppingCart className="w-5 h-5 text-[#10b981]" />
                    <h2 className="text-lg font-bold text-white tracking-tight">Garments</h2>
                  </div>
                  {draft.garments.map((g, i) => (
                    <div key={g.id} className="bg-[#0f172a] border border-slate-800 rounded-xl overflow-hidden shadow-sm">
                      <div className="px-5 py-3 border-b border-slate-800 bg-slate-950/50 flex justify-between items-center">
                        <h3 className="font-semibold text-slate-300 text-sm">Garment {i + 1}</h3>
                      </div>
                      <div className="p-5 grid grid-cols-1 lg:grid-cols-3 gap-8">
                        <div className="space-y-6">
                          <div>
                            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Parsed Identity</div>
                             <div className="p-4 bg-slate-950 border border-slate-800/80 rounded-lg">
                               <div className="text-xs text-slate-400 mb-2">{g.brand || "Unknown brand"}</div>
                               <div className="flex gap-2">
                                 <Input
                                   value={g.style}
                                   onChange={(event) =>
                                     updateGarment(i, {
                                       style: event.target.value,
                                       selectedProduct: null,
                                     })
                                   }
                                   className="h-9 bg-slate-900 border-slate-700 font-mono text-sm"
                                   readOnly={!isDraft}
                                 />
                                 {isDraft && (
                                   <Button
                                     type="button"
                                     variant="outline"
                                     size="sm"
                                     disabled={!g.style.trim() || refreshProducts.isPending}
                                     onClick={() =>
                                       refreshProducts.mutate(
                                         { data: { query: g.style.trim() } },
                                         {
                                           onSuccess: (result) => {
                                             const options = optionsFromSearch(result);
                                             updateGarment(i, {
                                               productOptions: options,
                                               selectedProduct: null,
                                               brand: options[0]?.brand ?? g.brand,
                                             });
                                             toast({
                                               title: "Products refreshed",
                                               description: `${options.length} verified vendor option${options.length === 1 ? "" : "s"} found.`,
                                             });
                                           },
                                           onError: (error: Error) =>
                                             toast({
                                               title: "Product lookup failed",
                                               description: error.message,
                                               variant: "destructive",
                                             }),
                                         },
                                       )
                                     }
                                     className="h-9 border-slate-700 bg-slate-900 text-slate-300"
                                   >
                                     {refreshProducts.isPending ? (
                                       <Loader2 className="w-4 h-4 animate-spin" />
                                     ) : (
                                       <Search className="w-4 h-4" />
                                     )}
                                     <span className="sr-only">Refresh vendor products</span>
                                   </Button>
                                 )}
                               </div>
                              <div className="text-xs text-slate-400 mt-1 leading-relaxed">{g.description}</div>
                              <div className="text-xs font-mono text-slate-400 mt-3 flex items-center gap-2">
                                <span className="bg-slate-800 px-2 py-0.5 rounded text-slate-300 border border-slate-700">Color: {g.color}</span>
                              </div>
                            </div>
                          </div>
                          <div>
                            <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Quantities</div>
                             <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                              {g.sizes.map((s, idx) => (
                                 <label key={idx} className="bg-slate-950 border border-slate-800 rounded-md px-2 py-1.5">
                                   <span className="block text-[9px] uppercase font-bold tracking-wider text-slate-500 mb-1">{s.size}</span>
                                   <Input
                                     type="number"
                                     min="0"
                                     value={s.quantity}
                                     onChange={(event) => {
                                       const sizes = g.sizes.map((size, sizeIndex) =>
                                         sizeIndex === idx
                                           ? { ...size, quantity: Number.parseInt(event.target.value, 10) || 0 }
                                           : size,
                                       );
                                       updateGarment(i, { sizes });
                                     }}
                                     className="h-7 bg-slate-900 border-slate-700 px-2 text-xs font-mono"
                                     readOnly={!isDraft}
                                   />
                                 </label>
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="lg:col-span-2">
                          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">Product Selection</div>
                          {g.productOptions.length === 0 ? (
                            <div className="p-6 bg-slate-950 border border-slate-800 border-dashed rounded-lg text-center text-slate-500 text-sm">
                              No product matches found. Will map to custom line items in Printavo.
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              {g.productOptions.map((opt, optIdx) => {
                                const isSelected = g.selectedProduct?.styleName === opt.styleName && g.selectedProduct?.vendor === opt.vendor;
                                return (
                                  <div 
                                    key={optIdx} 
                                    onClick={() => {
                                      if (!isDraft) return;
                                      const selection = selectionFromOption(g, opt);
                                      if (!selection) {
                                        toast({
                                          title: "Sizes unavailable",
                                          description: `${opt.styleName} does not have verified cost data for every requested size in ${g.color}.`,
                                          variant: "destructive",
                                        });
                                        return;
                                      }
                                      updateGarment(i, { selectedProduct: selection });
                                    }}
                                    className={`relative p-3 rounded-lg border flex gap-3 transition-colors cursor-pointer ${
                                      isSelected 
                                        ? "bg-[#10b981]/10 border-[#10b981]/30 ring-1 ring-[#10b981]" 
                                        : "bg-slate-950 border-slate-800 hover:border-slate-600 hover:bg-slate-900"
                                    } ${!isDraft && "cursor-default opacity-80"}`}
                                  >
                                    <div className="w-12 h-12 bg-slate-900 border border-slate-800 rounded flex items-center justify-center flex-shrink-0 p-1">
                                      {opt.image ? <img src={opt.image} className="max-w-full max-h-full object-contain mix-blend-screen" alt="" /> : <span className="text-[10px] text-slate-600">No img</span>}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex justify-between items-start">
                                        <div className="font-bold text-[13px] text-slate-200 truncate pr-2" title={opt.styleName}>{opt.styleName}</div>
                                        <MatchBadge type={opt.matchType} />
                                      </div>
                                      <div className="text-[11px] text-slate-400 capitalize truncate mt-0.5">{opt.vendor} &bull; {opt.brand}</div>
                                      <div className="text-[10px] text-slate-500 mt-1 font-mono">{opt.colors.length} colors</div>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                           {g.selectedProduct && (() => {
                             const selectedOption = g.productOptions.find(
                               (option) =>
                                 option.vendor === g.selectedProduct?.vendor &&
                                 option.styleName === g.selectedProduct?.styleName,
                             );
                             if (!selectedOption) return null;
                             return (
                               <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4 rounded-lg border border-slate-800 bg-slate-950 p-4">
                                 <div>
                                   <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 block">Verified color</label>
                                   <Select
                                     value={g.selectedProduct.color}
                                     onValueChange={(colorName) => {
                                       const selection = selectionFromOption(g, selectedOption, colorName);
                                       if (selection) updateGarment(i, { selectedProduct: selection });
                                     }}
                                     disabled={!isDraft}
                                   >
                                     <SelectTrigger className="bg-slate-900 border-slate-700">
                                       <SelectValue />
                                     </SelectTrigger>
                                     <SelectContent>
                                       {selectedOption.colors.map((color) => (
                                         <SelectItem key={color.name} value={color.name}>
                                           {color.name}
                                         </SelectItem>
                                       ))}
                                     </SelectContent>
                                   </Select>
                                 </div>
                                 <div>
                                   <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Verified blank cost</div>
                                   <div className="h-10 flex items-center font-mono text-sm font-bold text-[#10b981]">
                                     {money(g.selectedProduct.garmentCost)}
                                   </div>
                                 </div>
                               </div>
                             );
                           })()}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Decorations */}
                {draft.decorations.length > 0 && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2 mb-2 mt-6">
                      <Brush className="w-5 h-5 text-[#10b981]" />
                      <h2 className="text-lg font-bold text-white tracking-tight">Decorations</h2>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {draft.decorations.map((dec, i) => (
                        <div key={dec.id} className="bg-[#0f172a] border border-slate-800 rounded-xl overflow-hidden shadow-sm">
                           <div className="p-4 border-b border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-3 bg-slate-950/30">
                             <div>
                               <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 block">Location</label>
                               <Input
                                 value={dec.location}
                                 onChange={(event) => updateDecoration(i, { location: event.target.value })}
                                 className="h-9 bg-slate-950 border-slate-800 text-sm font-medium"
                                 readOnly={!isDraft}
                               />
                             </div>
                             <div>
                               <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 block">Method</label>
                               <Input
                                 value={dec.method}
                                 onChange={(event) => updateDecoration(i, { method: event.target.value })}
                                 className="h-9 bg-slate-950 border-slate-800 text-sm"
                                 readOnly={!isDraft}
                               />
                             </div>
                             <div>
                               <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 block">Colors</label>
                               <Input
                                 type="number"
                                 min="1"
                                 max="20"
                                 value={dec.colorCount ?? ""}
                                 onChange={(event) =>
                                   updateDecoration(i, {
                                     colorCount: event.target.value
                                       ? Number.parseInt(event.target.value, 10)
                                       : null,
                                   })
                                 }
                                 className="h-9 bg-slate-950 border-slate-800 text-sm font-mono"
                                 readOnly={!isDraft}
                               />
                             </div>
                             <div>
                               <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1 block">Details</label>
                               <Input
                                 value={dec.details ?? ""}
                                 onChange={(event) =>
                                   updateDecoration(i, { details: event.target.value || null })
                                 }
                                 className="h-9 bg-slate-950 border-slate-800 text-sm"
                                 readOnly={!isDraft}
                               />
                             </div>
                           </div>
                           <div className="p-3 border-b border-slate-800 flex flex-col gap-1.5 bg-slate-950/20">
                            <div className="flex items-center justify-between">
                              <div className="font-bold text-slate-200 text-[15px]">{dec.location}</div>
                              <Badge variant="outline" className="bg-slate-900 text-slate-300 border-slate-700 py-0.5 text-[10px] font-mono tracking-wider">{dec.method}</Badge>
                            </div>
                            <div className="text-[13px] text-slate-400">
                              {dec.colorCount !== null ? `${dec.colorCount} Color${dec.colorCount > 1 ? 's' : ''}` : "Unknown colors"}
                            </div>
                            {dec.details && <div className="text-xs text-slate-500 mt-1 italic leading-relaxed">"{dec.details}"</div>}
                          </div>
                          <div className="p-4 bg-[#0f172a]">
                            <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 block">Pricing Matrix</label>
                            <Select 
                              value={dec.matrixId || "none"}
                              onValueChange={(val) => {
                                updateDecoration(i, { matrixId: val === "none" ? null : val });
                              }}
                              disabled={!isDraft}
                            >
                              <SelectTrigger className="w-full bg-slate-950 border-slate-800 h-10 text-sm">
                                <SelectValue placeholder="Select matrix..." />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">None / Manual Pricing</SelectItem>
                                {matrices.map(m => (
                                  <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            
                            {dec.matrixId && (
                              <div className="mt-4">
                                <label className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2 block">Matrix Column</label>
                                <Select
                                  value={dec.matrixColumnIndex !== null ? dec.matrixColumnIndex.toString() : "none"}
                                  onValueChange={(val) => {
                                    updateDecoration(i, { matrixColumnIndex: val === "none" ? null : parseInt(val, 10) });
                                  }}
                                  disabled={!isDraft}
                                >
                                  <SelectTrigger className="w-full bg-slate-950 border-slate-800 h-10 text-sm">
                                    <SelectValue placeholder="Select column..." />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="none">Auto / First match</SelectItem>
                                    {matrices.find(m => m.id === dec.matrixId)?.data.xValues.map((col, idx) => (
                                      <SelectItem key={idx} value={idx.toString()}>
                                        {col.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Pricing Table */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2 mb-2 mt-6">
                    <DollarSign className="w-5 h-5 text-[#10b981]" />
                    <h2 className="text-lg font-bold text-white tracking-tight">Pricing Review</h2>
                  </div>
                  <div className="bg-[#0f172a] border border-slate-800 rounded-xl overflow-hidden shadow-sm overflow-x-auto custom-scrollbar">
                    <table className="w-full text-sm text-left">
                      <thead className="bg-slate-950 border-b border-slate-800 text-[10px] font-bold text-slate-500 uppercase tracking-wider">
                        <tr>
                          <th className="py-3 px-4">Item (Garment)</th>
                          <th className="py-3 px-4 w-24">Qty</th>
                          <th className="py-3 px-4 w-32">Blank Cost</th>
                          <th className="py-3 px-4 w-32">Decor Cost</th>
                          <th className="py-3 px-4 w-32 text-right">Unit Price</th>
                          <th className="py-3 px-4 w-32 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-800/50 text-slate-300 font-mono text-xs">
                        {draft.pricing.map((p, i) => {
                          const garment = draft.garments.find(g => g.id === p.garmentId);
                          return (
                            <tr key={i} className="hover:bg-slate-800/30 transition-colors">
                              <td className="py-3 px-4 font-sans font-medium text-slate-200">
                                {garment ? `${garment.brand || ''} ${garment.style}` : p.garmentId}
                              </td>
                              <td className="py-3 px-4">{p.quantity}</td>
                              <td className="py-3 px-4">{money(p.garmentCost)}</td>
                              <td className="py-3 px-4">{money(p.decorationCost)}</td>
                              <td className="py-3 px-4 text-right text-[#10b981] font-bold">{money(p.unitPrice)}</td>
                              <td className="py-3 px-4 text-right font-bold text-white text-sm">
                                {money(p.total)}
                              </td>
                            </tr>
                          );
                        })}
                        {draft.pricing.length === 0 && (
                          <tr>
                            <td colSpan={6} className="py-12 text-center text-slate-500 font-sans text-sm">
                              No pricing lines generated.
                            </td>
                          </tr>
                        )}
                        {draft.pricing.length > 0 && (
                          <tr className="bg-slate-950/80">
                            <td colSpan={5} className="py-4 px-4 text-right font-bold text-slate-500 font-sans uppercase tracking-wider text-[10px]">
                              Draft Grand Total
                            </td>
                            <td className="py-4 px-4 text-right font-bold text-[#10b981] text-base">
                              {money(draft.pricing.reduce((acc, p) => acc + p.total, 0))}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="bg-[#0f172a] border border-slate-800 text-slate-100 sm:max-w-md shadow-2xl">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              <FileText className="w-5 h-5 text-[#10b981]" />
              Create Printavo Quote
            </DialogTitle>
            <DialogDescription className="text-slate-400 pt-2 text-sm leading-relaxed">
              This will create a real quote in Printavo. Once created, you cannot edit this draft anymore. 
              Please review all quantities, products, and prices before proceeding.
            </DialogDescription>
          </DialogHeader>
          
          <div className="py-5 space-y-4">
            <div className="bg-amber-950/20 border border-amber-900/40 p-4 rounded-lg">
              <p className="text-sm font-medium text-amber-500/90 mb-3">
                Type <strong className="text-amber-400 font-mono bg-amber-900/40 px-1.5 py-0.5 rounded select-all tracking-wider text-xs">CREATE QUOTE</strong> below to confirm.
              </p>
              <Input 
                value={createConfirmText} 
                onChange={e => setCreateConfirmText(e.target.value)} 
                className="bg-slate-950 border-slate-800 text-slate-100 font-mono tracking-wider text-center h-12 text-sm uppercase placeholder:text-slate-600"
                placeholder="CREATE QUOTE"
                autoFocus
              />
            </div>
          </div>
          
          <DialogFooter className="border-t border-slate-800 pt-4">
            <Button variant="ghost" onClick={() => setCreateDialogOpen(false)} className="text-slate-400 hover:text-white hover:bg-slate-800 border-transparent">
              Cancel
            </Button>
            <Button 
              disabled={createConfirmText !== "CREATE QUOTE" || createQuote.isPending}
              onClick={handleCreateQuote}
              className="bg-[#059669] hover:bg-[#047857] text-white transition-colors"
            >
              {createQuote.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
              Confirm Creation
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
