import { useState, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Search, RotateCcw, Package, Mail, ArrowLeft, Filter, Image as ImageIcon, Hash, DollarSign, Building2, ChevronDown } from "lucide-react";
import { z } from "zod";

import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { customerLookupSchema, SIZE_LABEL_MAP } from "@/lib/schema";

import { 
  useSearchReorderPortalOrders, 
  useSubmitReorderRequest, 
  getSearchReorderPortalOrdersQueryKey 
} from "@workspace/api-client-react";
import type { ReorderPortalOrder, ReorderPortalLineItem, ReorderRequestInput, ReorderRequestItem } from "@workspace/api-client-react";

function StatusFilterBar({ 
  statuses, 
  activeStatusNames, 
  onToggle 
}: {
  statuses: { name: string; color: string | null }[];
  activeStatusNames: Set<string>;
  onToggle: (name: string) => void;
}) {
  if (statuses.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="status-filter-bar">
      <div className="flex items-center gap-2">
        <Filter className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">Filter by Status</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {statuses.map((status) => {
          const isActive = activeStatusNames.has(status.name);
          return (
            <button
              key={status.name}
              onClick={() => onToggle(status.name)}
              className={`
                relative px-3 py-1.5 rounded-md text-sm font-medium transition-all duration-200 border
                ${isActive
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted/50 text-muted-foreground border-transparent"
                }
              `}
              data-testid={`status-filter-${status.name}`}
            >
              {status.color && (
                <span
                  className="inline-block w-2 h-2 rounded-full mr-1.5"
                  style={{ backgroundColor: status.color }}
                />
              )}
              {status.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function OrderCard({ order, onReorder }: {
  order: ReorderPortalOrder;
  onReorder: (order: ReorderPortalOrder) => void;
}) {
  const [imageError, setImageError] = useState(false);
  const mockupUrl = order.mockupUrls?.[0];
  const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

  return (
    <Card className="group hover-elevate transition-all duration-200" data-testid={`order-card-${order.visualId}`}>
      <CardContent className="p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="sm:w-48 h-40 sm:h-auto bg-muted/30 flex items-center justify-center sm:rounded-l-md overflow-hidden relative">
            {mockupUrl && !imageError ? (
              <img
                src={mockupUrl}
                alt={`Mockup for order ${order.visualId}`}
                className="w-full h-full object-cover"
                onError={() => setImageError(true)}
                data-testid={`mockup-image-${order.visualId}`}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground/50">
                <ImageIcon className="w-10 h-10" />
                <span className="text-xs font-medium">No Mockup</span>
              </div>
            )}
          </div>

          <div className="flex-1 p-4 sm:p-5 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold text-lg tracking-tight" data-testid={`order-nickname-${order.visualId}`}>
                    {order.nickname || `Order #${order.visualId}`}
                  </h3>
                  {order.statusName && (
                    <Badge
                      variant="secondary"
                      className="text-xs font-medium px-2 py-0.5"
                      style={order.statusColor ? { backgroundColor: order.statusColor, color: '#fff' } : {}}
                      data-testid={`order-status-${order.visualId}`}
                    >
                      {order.statusName}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground font-medium">
                  <Hash className="w-3.5 h-3.5" />
                  <span data-testid={`order-id-${order.visualId}`}>{order.visualId}</span>
                  {order.customerCompany && (
                    <>
                      <span className="text-muted-foreground/40">•</span>
                      <Building2 className="w-3.5 h-3.5 ml-1" />
                      <span>{order.customerCompany}</span>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
              {order.total != null && (
                <div className="flex items-center gap-1.5">
                  <DollarSign className="w-3.5 h-3.5" />
                  <span className="font-medium" data-testid={`order-total-${order.visualId}`}>{formatter.format(order.total)}</span>
                </div>
              )}
              {order.invoiceDate && (
                <div className="flex items-center gap-1.5">
                  <span className="font-medium" data-testid={`order-date-${order.visualId}`}>
                    {new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(order.invoiceDate))}
                  </span>
                </div>
              )}
              {order.lineItems && order.lineItems.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <Package className="w-3.5 h-3.5" />
                  <span className="font-medium">{order.lineItems.length} product{order.lineItems.length !== 1 ? 's' : ''}</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 mt-auto pt-2 flex-wrap">
              <Button
                size="sm"
                onClick={() => onReorder(order)}
                data-testid={`button-reorder-${order.visualId}`}
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                Reorder Request
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function OrderCardSkeleton() {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="sm:w-48 h-40 sm:h-auto">
            <Skeleton className="w-full h-full min-h-[160px] rounded-none sm:rounded-l-md" />
          </div>
          <div className="flex-1 p-5 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-5 w-24" />
            </div>
            <Skeleton className="h-4 w-32" />
            <div className="flex gap-4 mt-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-28" />
            </div>
            <div className="flex gap-2 mt-4">
              <Skeleton className="h-9 w-32" />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function LineItemSizeEntry({ lineItem, qtyMap, onQtyChange, expanded, onToggle, fallbackMockupUrl }: {
  lineItem: ReorderPortalLineItem;
  qtyMap: Record<string, number>;
  onQtyChange: (size: string, qty: number) => void;
  expanded: boolean;
  onToggle: () => void;
  fallbackMockupUrl?: string | null;
}) {
  const [imageError, setImageError] = useState(false);
  const productLabel = lineItem.description || "Product";
  const mockupSrc = lineItem.mockupUrls?.[0] || fallbackMockupUrl || null;
  const sizesWithLabels = (lineItem.sizes || []).map(s => ({
    ...s,
    displayLabel: s.label || SIZE_LABEL_MAP[s.size] || s.size,
  }));
  const hasSizes = sizesWithLabels.length > 0;
  const itemTotal = Object.values(qtyMap).reduce((sum, q) => sum + q, 0);

  return (
    <div className="rounded-md border overflow-hidden" data-testid={`lineitem-${lineItem.id}`}>
      <button
        type="button"
        onClick={onToggle}
        className={`w-full text-left px-3 py-3 transition-colors ${expanded ? "bg-primary/5" : "bg-background hover:bg-muted/50"}`}
        data-testid={`toggle-lineitem-${lineItem.id}`}
      >
        <div className="flex items-center gap-4">
          {mockupSrc && !imageError ? (
            <div className="relative group/mockup shrink-0" onClick={(e) => e.stopPropagation()}>
              <img
                src={mockupSrc}
                alt={productLabel}
                className="w-12 h-12 rounded object-cover border border-border/50 cursor-zoom-in"
                onError={() => setImageError(true)}
                data-testid={`img-mockup-${lineItem.id}`}
              />
              <div className="hidden group-hover/mockup:block fixed z-[100] pointer-events-none" style={{ top: "50%", left: "50%", transform: "translate(-50%, -50%)" }}>
                <div className="p-2 bg-background rounded-xl shadow-2xl border border-border">
                  <img
                    src={mockupSrc}
                    alt={productLabel}
                    className="w-[32rem] h-[32rem] max-w-[90vw] max-h-[90vh] rounded-lg object-contain"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="w-12 h-12 rounded border border-border/50 bg-muted/30 flex items-center justify-center shrink-0">
              <ImageIcon className="w-5 h-5 text-muted-foreground/40" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium truncate">{productLabel}</span>
              {itemTotal > 0 && (
                <Badge variant="secondary" className="text-xs shrink-0">{itemTotal} pcs</Badge>
              )}
            </div>
            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
              {lineItem.color && <span className="font-medium">{lineItem.color}</span>}
              {lineItem.itemNumber && <span>#{lineItem.itemNumber}</span>}
              {lineItem.totalQty !== undefined && lineItem.totalQty > 0 && (
                <span className="text-muted-foreground/60">(prev: {lineItem.totalQty})</span>
              )}
            </div>
          </div>
          <ChevronDown className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`} />
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 bg-muted/20 border-t border-border/50">
          {hasSizes ? (
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-3 pt-4">
              {sizesWithLabels.map((s) => (
                <div key={s.size} className="flex flex-col items-center gap-1.5">
                  <label className="text-xs font-semibold text-muted-foreground">{s.displayLabel}</label>
                  <Input
                    type="number"
                    min={0}
                    value={qtyMap[s.size] || ""}
                    onChange={(e) => onQtyChange(s.size, parseInt(e.target.value) || 0)}
                    className="h-8 text-sm px-2 w-full text-center"
                    placeholder="0"
                    data-testid={`input-qty-${lineItem.id}-${s.size}`}
                  />
                  {s.count != null && s.count > 0 && (
                    <span className="text-[10px] text-muted-foreground/60 font-medium">was {s.count}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="pt-4">
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-muted-foreground">Quantity</label>
                <Input
                  type="number"
                  min={0}
                  value={qtyMap["qty"] || ""}
                  onChange={(e) => onQtyChange("qty", parseInt(e.target.value) || 0)}
                  className="h-9 text-sm px-3 w-24"
                  placeholder="0"
                  data-testid={`input-qty-${lineItem.id}-qty`}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const reorderFormSchema = z.object({
  customerName: z.string().min(1, "Name is required"),
  customerEmail: z.string().email("Invalid email address"),
  customerCompany: z.string().optional(),
  notes: z.string().optional(),
});

function ReorderModal({ order, open, onClose }: { order: ReorderPortalOrder | null; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [lineItemQtys, setLineItemQtys] = useState<Record<string, Record<string, number>>>({});

  const form = useForm<z.infer<typeof reorderFormSchema>>({
    resolver: zodResolver(reorderFormSchema),
    defaultValues: {
      customerName: "",
      customerEmail: "",
      customerCompany: "",
      notes: "",
    },
  });

  // Prefill when order changes
  useMemo(() => {
    if (order && open) {
      form.reset({
        customerName: "",
        customerEmail: "",
        customerCompany: order.customerCompany || "",
        notes: "",
      });
      setExpandedItems(new Set());
      
      // Default populate with original quantities
      const initialQtys: Record<string, Record<string, number>> = {};
      if (order.lineItems) {
        for (const item of order.lineItems) {
          const sizesMap: Record<string, number> = {};
          if (item.sizes) {
            for (const size of item.sizes) {
              if (size.count > 0) {
                sizesMap[size.size] = size.count;
              }
            }
          }
          if (Object.keys(sizesMap).length > 0) {
            initialQtys[item.id] = sizesMap;
          }
        }
      }
      setLineItemQtys(initialQtys);
    }
  }, [order, open, form]);

  const submitReorder = useSubmitReorderRequest();

  if (!order) return null;

  const lineItems = order.lineItems || [];

  const toggleItem = (id: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleQtyChange = (lineItemId: string, size: string, qty: number) => {
    setLineItemQtys((prev) => {
      const itemQtys = { ...(prev[lineItemId] || {}) };
      if (qty <= 0) {
        delete itemQtys[size];
      } else {
        itemQtys[size] = qty;
      }
      return { ...prev, [lineItemId]: itemQtys };
    });
  };

  const onSubmit = (data: z.infer<typeof reorderFormSchema>) => {
    const items: ReorderRequestItem[] = [];
    for (const li of lineItems) {
      const qtys = lineItemQtys[li.id] || {};
      const sizesArray = Object.entries(qtys)
        .filter(([, qty]) => qty > 0)
        .map(([sizeKey, qty]) => {
          const matchedSize = li.sizes?.find(s => s.size === sizeKey);
          return { label: matchedSize?.label || SIZE_LABEL_MAP[sizeKey] || sizeKey, qty };
        });
        
      if (sizesArray.length > 0) {
        items.push({
          lineItemId: li.id,
          description: li.description || null,
          color: li.color || null,
          itemNumber: li.itemNumber || null,
          sizes: sizesArray,
        });
      }
    }

    if (items.length === 0) {
      toast({
        title: "No items selected",
        description: "Please enter quantities for at least one product.",
        variant: "destructive",
      });
      return;
    }

    const payload: ReorderRequestInput = {
      orderId: order.id,
      visualId: order.visualId,
      orderNickname: order.nickname,
      customerName: data.customerName,
      customerEmail: data.customerEmail,
      customerCompany: data.customerCompany || null,
      notes: data.notes || null,
      items,
    };

    submitReorder.mutate({ data: payload }, {
      onSuccess: () => {
        toast({
          title: "Request Received",
          description: "Our team will follow up with a quote shortly.",
        });
        onClose();
      },
      onError: (err: any) => {
        const msg = err?.error || "Please try again in a minute.";
        toast({
          title: "Error Sending Request",
          description: msg,
          variant: "destructive",
        });
      }
    });
  };

  const totalQty = Object.values(lineItemQtys).reduce(
    (sum, qtys) => sum + Object.values(qtys).reduce((s, q) => s + q, 0), 0
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-xl max-h-[95vh] flex flex-col p-0 gap-0" data-testid="reorder-modal">
        <DialogHeader className="px-6 py-5 border-b">
          <DialogTitle className="flex items-center gap-2 text-xl font-bold">
            <RotateCcw className="w-5 h-5 text-primary" />
            Reorder Request
          </DialogTitle>
          <DialogDescription className="text-base pt-1">
            Reordering{" "}
            <span className="font-semibold text-foreground">{order.nickname || `Order #${order.visualId}`}</span>.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col flex-1 min-h-0">
            <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
              
              {/* Items Section */}
              {lineItems.length > 0 && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-base font-semibold tracking-tight">Products</h3>
                    {totalQty > 0 && (
                      <Badge variant="secondary" className="px-2" data-testid="text-total-qty">
                        Total: {totalQty} pcs
                      </Badge>
                    )}
                  </div>
                  <div className="space-y-3">
                    {lineItems.map((li) => (
                      <LineItemSizeEntry
                        key={li.id}
                        lineItem={li}
                        qtyMap={lineItemQtys[li.id] || {}}
                        onQtyChange={(size, qty) => handleQtyChange(li.id, size, qty)}
                        expanded={expandedItems.has(li.id)}
                        onToggle={() => toggleItem(li.id)}
                        fallbackMockupUrl={order.mockupUrls?.[0]}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Contact Details Section */}
              <div className="space-y-4">
                <h3 className="text-base font-semibold tracking-tight border-t pt-4">Your Details</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="customerName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Name *</FormLabel>
                        <FormControl>
                          <Input placeholder="Jane Doe" {...field} data-testid="input-reorder-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="customerEmail"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email *</FormLabel>
                        <FormControl>
                          <Input type="email" placeholder="jane@company.com" {...field} data-testid="input-reorder-email" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="customerCompany"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Company (optional)</FormLabel>
                      <FormControl>
                        <Input placeholder="Company LLC" {...field} data-testid="input-reorder-company" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Notes (optional)</FormLabel>
                      <FormControl>
                        <Textarea
                          placeholder="Any design changes, different garment colors, or specific deadlines?"
                          className="resize-none min-h-[100px]"
                          {...field}
                          data-testid="input-reorder-notes"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

            </div>

            <div className="px-6 py-4 bg-muted/30 border-t flex justify-end gap-3 shrink-0">
              <Button type="button" variant="outline" onClick={onClose} data-testid="button-cancel-reorder">
                Cancel
              </Button>
              <Button type="submit" disabled={submitReorder.isPending} data-testid="button-confirm-reorder" className="min-w-[140px]">
                {submitReorder.isPending ? (
                  <>
                    <Mail className="w-4 h-4 mr-2 animate-pulse" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4 mr-2" />
                    Send Request
                  </>
                )}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default function Home() {
  const [searchQuery, setSearchQuery] = useState<{ value: string; type: "email" | "company" } | null>(null);
  const [activeStatusNames, setActiveStatusNames] = useState<Set<string>>(new Set());
  const [reorderOrder, setReorderOrder] = useState<ReorderPortalOrder | null>(null);
  const [statusesInitialized, setStatusesInitialized] = useState(false);

  const lookupForm = useForm<z.infer<typeof customerLookupSchema>>({
    resolver: zodResolver(customerLookupSchema),
    defaultValues: { searchType: "email", searchValue: "" },
  });

  const searchType = lookupForm.watch("searchType");

  const queryClient = useQueryClient();

  const { data: orderList, isLoading, isError, error } = useSearchReorderPortalOrders(
    { q: searchQuery?.value || "", type: searchQuery?.type || "email" },
    {
      query: {
        enabled: !!searchQuery,
        queryKey: getSearchReorderPortalOrdersQueryKey({ q: searchQuery?.value || "", type: searchQuery?.type || "email" }),
      }
    }
  );

  const orders = orderList?.orders || [];

  // Extract unique statuses from the result set client-side
  const statuses = useMemo(() => {
    const statusMap = new Map<string, string | null>();
    for (const o of orders) {
      if (o.statusName) {
        if (!statusMap.has(o.statusName) || o.statusColor) {
          statusMap.set(o.statusName, o.statusColor);
        }
      }
    }
    return Array.from(statusMap.entries()).map(([name, color]) => ({ name, color }));
  }, [orders]);

  // Initialize active filters once per search
  if (orders.length > 0 && !statusesInitialized) {
    setActiveStatusNames(new Set(statuses.map(s => s.name)));
    setStatusesInitialized(true);
  }

  const filteredOrders = orders.filter((order) => {
    if (activeStatusNames.size === 0) return true;
    if (!order.statusName) return true;
    return activeStatusNames.has(order.statusName);
  });

  const handleLookup = lookupForm.handleSubmit((data) => {
    setSearchQuery({ value: data.searchValue, type: data.searchType });
    setStatusesInitialized(false);
  });

  const toggleStatus = (name: string) => {
    setActiveStatusNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const handleBack = () => {
    setSearchQuery(null);
    setStatusesInitialized(false);
    lookupForm.reset();
  };

  if (!searchQuery) {
    return (
      <div className="min-h-[100dvh] bg-muted flex items-center justify-center p-4 sm:p-8">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center space-y-4">
            <div className="mx-auto w-20 h-20 rounded-2xl bg-white shadow-sm border flex items-center justify-center mb-6">
              <Package className="w-10 h-10 text-primary" />
            </div>
            <h1 className="text-4xl font-bold tracking-tight text-foreground" data-testid="text-app-title">
              Mint Printworks
            </h1>
            <p className="text-lg font-medium text-primary">
              Reorder Portal
            </p>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto leading-relaxed">
              Search by email or company name to view your order history and easily place a reorder.
            </p>
          </div>

          <Card className="shadow-lg border-muted">
            <CardContent className="pt-6 sm:p-8">
              <form onSubmit={handleLookup} className="space-y-6">
                <Form {...lookupForm}>
                  <div className="flex gap-1 p-1 bg-muted rounded-xl border border-border/50" data-testid="search-type-toggle">
                    <button
                      type="button"
                      onClick={() => { lookupForm.setValue("searchType", "email"); lookupForm.setValue("searchValue", ""); lookupForm.clearErrors(); }}
                      className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all ${searchType === "email" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      data-testid="toggle-email"
                    >
                      <Mail className="w-4 h-4" />
                      Email
                    </button>
                    <button
                      type="button"
                      onClick={() => { lookupForm.setValue("searchType", "company"); lookupForm.setValue("searchValue", ""); lookupForm.clearErrors(); }}
                      className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all ${searchType === "company" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      data-testid="toggle-company"
                    >
                      <Building2 className="w-4 h-4" />
                      Company
                    </button>
                  </div>
                  <FormField
                    control={lookupForm.control}
                    name="searchValue"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel className="text-foreground">{searchType === "email" ? "Email Address" : "Company Name"}</FormLabel>
                        <FormControl>
                          <div className="relative">
                            {searchType === "email" ? (
                              <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            ) : (
                              <Building2 className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            )}
                            <Input
                              placeholder={searchType === "email" ? "you@company.com" : "Enter company name"}
                              className="pl-10 h-12 text-base"
                              {...field}
                              data-testid="input-search"
                            />
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </Form>
                <Button type="submit" className="w-full h-12 text-base font-semibold" data-testid="button-lookup">
                  <Search className="w-5 h-5 mr-2" />
                  Find My Orders
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-sm">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Button variant="outline" size="icon" onClick={handleBack} className="rounded-full h-9 w-9 shrink-0 hover:bg-muted" data-testid="button-back">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div>
              <h1 className="font-bold text-lg tracking-tight" data-testid="text-dashboard-title">Your Orders</h1>
              <p className="text-sm text-muted-foreground font-medium" data-testid="text-search-query">
                {searchQuery.type === "email" ? searchQuery.value : `Company: ${searchQuery.value}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isLoading && (
              <Badge variant="secondary" className="px-3 py-1 font-semibold" data-testid="text-order-count">
                {filteredOrders.length} order{filteredOrders.length !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-8">
        {statuses.length > 0 && (
          <StatusFilterBar
            statuses={statuses}
            activeStatusNames={activeStatusNames}
            onToggle={toggleStatus}
          />
        )}

        {isLoading && (
          <div className="space-y-4" data-testid="loading-skeleton">
            {[1, 2, 3].map((i) => <OrderCardSkeleton key={i} />)}
          </div>
        )}

        {isError && (
          <Card className="border-destructive/30 bg-destructive/5">
            <CardContent className="pt-6 text-center space-y-4 py-12">
              <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
                <Search className="w-6 h-6 text-destructive" />
              </div>
              <div>
                <p className="text-destructive font-semibold text-lg">Unable to load orders</p>
                <p className="text-sm text-muted-foreground mt-1">
                  {(error as any)?.error || error?.message || "Please try again later."}
                </p>
              </div>
              <Button
                variant="outline"
                className="mt-4 border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground"
                onClick={() => queryClient.invalidateQueries({ queryKey: getSearchReorderPortalOrdersQueryKey({ q: searchQuery.value, type: searchQuery.type }) })}
              >
                Try Again
              </Button>
            </CardContent>
          </Card>
        )}

        {!isLoading && !isError && orders.length === 0 && (
          <Card className="border-dashed">
            <CardContent className="pt-6 text-center space-y-4 py-16">
              <div className="mx-auto w-16 h-16 rounded-full bg-muted flex items-center justify-center">
                <Package className="w-8 h-8 text-muted-foreground" />
              </div>
              <div className="space-y-1">
                <p className="font-semibold text-xl">No orders found</p>
                <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                  We couldn't find any orders matching "{searchQuery.value}". Double check your spelling or try another search.
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleBack}
                className="mt-4"
              >
                Back to Search
              </Button>
            </CardContent>
          </Card>
        )}

        {!isLoading && !isError && filteredOrders.length === 0 && orders.length > 0 && (
          <div className="text-center py-12 space-y-3">
            <Filter className="w-10 h-10 text-muted-foreground/30 mx-auto" />
            <p className="text-lg font-medium text-muted-foreground">All orders filtered out</p>
            <Button variant="link" onClick={() => setActiveStatusNames(new Set(statuses.map(s => s.name)))}>
              Clear filters
            </Button>
          </div>
        )}

        {!isLoading && !isError && filteredOrders.length > 0 && (
          <div className="grid grid-cols-1 gap-4">
            {filteredOrders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                onReorder={setReorderOrder}
              />
            ))}
          </div>
        )}
      </main>

      <ReorderModal 
        order={reorderOrder} 
        open={!!reorderOrder} 
        onClose={() => setReorderOrder(null)} 
      />
    </div>
  );
}