import { useState, useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery, useMutation } from "@tanstack/react-query";
import { customerLookupSchema, type CustomerLookup, type PrintavoOrder, type PrintavoStatus, type ReorderRequest, type LineItem, type LineItemReorder, SIZE_LABEL_MAP } from "@shared/schema";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, RotateCcw, ExternalLink, Package, Mail, ArrowLeft, Filter, Image, CalendarDays, Hash, DollarSign, Building2, ChevronDown } from "lucide-react";

function StatusFilterBar({ statuses, activeStatusIds, onToggle }: {
  statuses: PrintavoStatus[];
  activeStatusIds: Set<string>;
  onToggle: (id: string) => void;
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
          const isActive = activeStatusIds.has(status.id);
          return (
            <button
              key={status.id}
              onClick={() => onToggle(status.id)}
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
  order: PrintavoOrder;
  onReorder: (order: PrintavoOrder) => void;
}) {
  return (
    <Card className="group hover-elevate transition-all duration-200" data-testid={`order-card-${order.visualId}`}>
      <CardContent className="p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="sm:w-48 h-40 sm:h-auto bg-muted/30 flex items-center justify-center sm:rounded-l-md overflow-hidden relative">
            {order.mockupUrl ? (
              <img
                src={order.mockupUrl}
                alt={`Mockup for order ${order.visualId}`}
                className="w-full h-full object-cover"
                data-testid={`mockup-image-${order.visualId}`}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-muted-foreground/50">
                <Image className="w-10 h-10" />
                <span className="text-xs">No Mockup</span>
              </div>
            )}
          </div>

          <div className="flex-1 p-4 sm:p-5 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold text-base" data-testid={`order-nickname-${order.visualId}`}>
                    {order.orderNickname || `Order #${order.visualId}`}
                  </h3>
                  {order.status && (
                    <Badge
                      variant="secondary"
                      className="text-xs"
                      style={order.statusColor ? { backgroundColor: order.statusColor, color: '#fff' } : {}}
                      data-testid={`order-status-${order.visualId}`}
                    >
                      {order.status}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1 text-sm text-muted-foreground">
                  <Hash className="w-3.5 h-3.5" />
                  <span data-testid={`order-id-${order.visualId}`}>{order.visualId}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
              {order.total && (
                <div className="flex items-center gap-1.5">
                  <DollarSign className="w-3.5 h-3.5" />
                  <span data-testid={`order-total-${order.visualId}`}>{order.total}</span>
                </div>
              )}
              {order.dueDate && (
                <div className="flex items-center gap-1.5">
                  <CalendarDays className="w-3.5 h-3.5" />
                  <span data-testid={`order-due-${order.visualId}`}>Due: {new Date(order.dueDate).toLocaleDateString()}</span>
                </div>
              )}
              {order.lineItemCount !== undefined && order.lineItemCount > 0 && (
                <div className="flex items-center gap-1.5">
                  <Package className="w-3.5 h-3.5" />
                  <span>{order.lineItemCount} product{order.lineItemCount !== 1 ? 's' : ''}</span>
                </div>
              )}
              {order.orderTotalQty !== undefined && order.orderTotalQty > 0 && (
                <div className="flex items-center gap-1.5">
                  <Hash className="w-3.5 h-3.5" />
                  <span data-testid={`order-totalqty-${order.visualId}`}>{order.orderTotalQty} pcs total</span>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 mt-auto pt-2 flex-wrap">
              {order.publicUrl && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(order.publicUrl!, "_blank")}
                  data-testid={`button-invoice-${order.visualId}`}
                >
                  <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
                  Invoice Link
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => onReorder(order)}
                data-testid={`button-reorder-${order.visualId}`}
              >
                <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                Reorder Now
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
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-5 w-20" />
            </div>
            <Skeleton className="h-4 w-24" />
            <div className="flex gap-4">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-28" />
            </div>
            <div className="flex gap-2 mt-2">
              <Skeleton className="h-8 w-28" />
              <Skeleton className="h-8 w-28" />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}


function LineItemSizeEntry({ lineItem, qtyMap, onQtyChange, expanded, onToggle, fallbackMockupUrl }: {
  lineItem: LineItem;
  qtyMap: Record<string, number>;
  onQtyChange: (size: string, qty: number) => void;
  expanded: boolean;
  onToggle: () => void;
  fallbackMockupUrl?: string | null;
}) {
  const productLabel = lineItem.productName || lineItem.description || "Product";
  const mockupSrc = lineItem.mockupUrl || fallbackMockupUrl || null;
  const sizesWithLabels = (lineItem.sizes || []).map(s => ({
    ...s,
    label: SIZE_LABEL_MAP[s.size] || s.size,
  }));
  const hasSizes = sizesWithLabels.length > 0;
  const itemTotal = Object.values(qtyMap).reduce((sum, q) => sum + q, 0);

  return (
    <div className="rounded-md border overflow-hidden" data-testid={`lineitem-${lineItem.id}`}>
      <button
        type="button"
        onClick={onToggle}
        className={`w-full text-left px-3 py-2.5 transition-colors ${expanded ? "bg-primary/5" : "bg-background hover:bg-muted/50"}`}
        data-testid={`toggle-lineitem-${lineItem.id}`}
      >
        <div className="flex items-center gap-3">
          {mockupSrc ? (
            <div className="relative group/mockup shrink-0" onClick={(e) => e.stopPropagation()}>
              <img
                src={mockupSrc}
                alt={productLabel}
                className="w-10 h-10 rounded object-cover border border-border/50 cursor-zoom-in"
                data-testid={`img-mockup-${lineItem.id}`}
              />
              <div className="hidden group-hover/mockup:block fixed z-[100] pointer-events-none" style={{ top: "50%", left: "50%", transform: "translate(-50%, -50%)" }}>
                <div className="p-1.5 bg-white dark:bg-zinc-900 rounded-lg shadow-2xl border border-border">
                  <img
                    src={mockupSrc}
                    alt={productLabel}
                    className="w-[56rem] h-[56rem] max-w-[90vw] max-h-[90vh] rounded object-contain"
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="w-10 h-10 rounded border border-border/50 bg-muted/30 flex items-center justify-center shrink-0">
              <Image className="w-4 h-4 text-muted-foreground/40" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium truncate">{productLabel}</span>
              {itemTotal > 0 && (
                <Badge variant="secondary" className="text-xs shrink-0">{itemTotal} pcs</Badge>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5 text-xs text-muted-foreground flex-wrap">
              {lineItem.color && <span>{lineItem.color}</span>}
              {lineItem.itemNumber && <span>#{lineItem.itemNumber}</span>}
              {lineItem.totalQty !== undefined && lineItem.totalQty > 0 && (
                <span className="text-muted-foreground/60">(prev: {lineItem.totalQty})</span>
              )}
            </div>
          </div>
          <ChevronDown className={`w-4 h-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`} />
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 bg-muted/20">
          {hasSizes ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 pt-2">
              {sizesWithLabels.map((s) => (
                <div key={s.size} className="flex flex-col items-center gap-1">
                  <label className="text-xs text-muted-foreground">{s.label}</label>
                  <Input
                    type="number"
                    min={0}
                    value={qtyMap[s.size] || ""}
                    onChange={(e) => onQtyChange(s.size, parseInt(e.target.value) || 0)}
                    className="h-7 text-sm px-2 w-14 text-center"
                    placeholder="0"
                    data-testid={`input-qty-${lineItem.id}-${s.size}`}
                  />
                  {s.count != null && s.count > 0 && (
                    <span className="text-[10px] text-muted-foreground/50">was {s.count}</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="pt-2">
              <div className="flex items-center gap-2">
                <label className="text-xs text-muted-foreground">Qty</label>
                <Input
                  type="number"
                  min={0}
                  value={qtyMap["qty"] || ""}
                  onChange={(e) => onQtyChange("qty", parseInt(e.target.value) || 0)}
                  className="h-7 text-sm px-2 w-20"
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

function ReorderModal({ order, open, onClose }: { order: PrintavoOrder | null; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const [notes, setNotes] = useState("");
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const [lineItemQtys, setLineItemQtys] = useState<Record<string, Record<string, number>>>({});

  useEffect(() => {
    if (open) {
      setNotes("");
      setExpandedItems(new Set());
      setLineItemQtys({});
    }
  }, [open]);

  const reorderMutation = useMutation({
    mutationFn: async (data: ReorderRequest) => {
      const res = await apiRequest("POST", "/api/reorder", data);
      return res.json();
    },
    onSuccess: () => {
      toast({
        title: "Reorder Request Sent",
        description: "Our sales team has been notified and will follow up with you shortly.",
      });
      onClose();
    },
    onError: (error: Error) => {
      toast({
        title: "Error Sending Reorder",
        description: error.message,
        variant: "destructive",
      });
    },
  });

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const lineItemOrders: LineItemReorder[] = [];
    for (const li of lineItems) {
      const qtys = lineItemQtys[li.id] || {};
      const filledSizes = Object.entries(qtys)
        .filter(([, qty]) => qty > 0)
        .map(([size, qty]) => ({ size: SIZE_LABEL_MAP[size] || size, qty }));
      if (filledSizes.length > 0) {
        lineItemOrders.push({
          lineItemId: li.id,
          productName: li.productName || li.description || undefined,
          color: li.color || undefined,
          itemNumber: li.itemNumber || undefined,
          sizes: filledSizes,
        });
      }
    }

    reorderMutation.mutate({
      orderId: order.id,
      visualId: order.visualId,
      orderNickname: order.orderNickname || undefined,
      customerName: order.customerName || undefined,
      customerEmail: order.customerEmail || "",
      notes: notes || undefined,
      lineItemOrders: lineItemOrders.length > 0 ? lineItemOrders : undefined,
    });
  };

  const totalQty = Object.values(lineItemQtys).reduce(
    (sum, qtys) => sum + Object.values(qtys).reduce((s, q) => s + q, 0), 0
  );

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] flex flex-col p-0" data-testid="reorder-modal">
        <DialogHeader className="px-6 pt-6 pb-2">
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="w-4 h-4" />
            Reorder Request
          </DialogTitle>
          <DialogDescription>
            We'll notify our sales team about your reorder for{" "}
            <strong>{order.orderNickname || `Order #${order.visualId}`}</strong>.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col flex-1 min-h-0">
          <div className="flex-1 overflow-y-auto px-6 space-y-4 py-2">
            <div className="rounded-md bg-muted/50 p-3 space-y-1.5 text-sm">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Order</span>
                <span className="font-medium">#{order.visualId}</span>
              </div>
              {order.orderNickname && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Name</span>
                  <span className="font-medium">{order.orderNickname}</span>
                </div>
              )}
              {order.customerName && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Customer</span>
                  <span className="font-medium">{order.customerName}</span>
                </div>
              )}
              {order.orderTotalQty !== undefined && order.orderTotalQty > 0 && (
                <div className="flex justify-between gap-2">
                  <span className="text-muted-foreground">Total Qty</span>
                  <span className="font-medium" data-testid="text-order-total-qty">{order.orderTotalQty} pcs</span>
                </div>
              )}
            </div>

            {lineItems.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium leading-none">Products & Quantities</label>
                  {totalQty > 0 && (
                    <span className="text-xs text-muted-foreground" data-testid="text-total-qty">
                      Total: {totalQty} pcs
                    </span>
                  )}
                </div>
                <div className="space-y-2">
                  {lineItems.map((li) => (
                    <LineItemSizeEntry
                      key={li.id}
                      lineItem={li}
                      qtyMap={lineItemQtys[li.id] || {}}
                      onQtyChange={(size, qty) => handleQtyChange(li.id, size, qty)}
                      expanded={expandedItems.has(li.id)}
                      onToggle={() => toggleItem(li.id)}
                      fallbackMockupUrl={order.mockupUrl}
                    />
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <label className="text-sm font-medium leading-none">Additional Notes (optional)</label>
              <Textarea
                placeholder="Any changes or special instructions for this reorder..."
                className="resize-none"
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                data-testid="reorder-notes"
              />
            </div>
          </div>

          <div className="px-6 pb-6 pt-4 border-t mt-2">
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={onClose} data-testid="button-cancel-reorder">
                Cancel
              </Button>
              <Button type="submit" disabled={reorderMutation.isPending} data-testid="button-confirm-reorder">
                {reorderMutation.isPending ? (
                  <>
                    <Mail className="w-3.5 h-3.5 mr-1.5 animate-pulse" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Mail className="w-3.5 h-3.5 mr-1.5" />
                    Send Reorder Request
                  </>
                )}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function Home() {
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState<{ value: string; type: "email" | "company" } | null>(null);
  const [activeStatusIds, setActiveStatusIds] = useState<Set<string>>(new Set());
  const [reorderOrder, setReorderOrder] = useState<PrintavoOrder | null>(null);
  const [statusesInitialized, setStatusesInitialized] = useState(false);

  const lookupForm = useForm<CustomerLookup>({
    resolver: zodResolver(customerLookupSchema),
    defaultValues: { searchType: "email", searchValue: "" },
  });

  const searchType = lookupForm.watch("searchType");

  const statusesQuery = useQuery<PrintavoStatus[]>({
    queryKey: ["/api/statuses"],
    enabled: !!searchQuery,
  });

  useEffect(() => {
    if (statusesQuery.data && !statusesInitialized && statusesQuery.data.length > 0) {
      setActiveStatusIds(new Set(statusesQuery.data.map((s) => s.id)));
      setStatusesInitialized(true);
    }
  }, [statusesQuery.data, statusesInitialized]);

  const ordersQuery = useQuery<PrintavoOrder[]>({
    queryKey: ["/api/orders", searchQuery?.value, searchQuery?.type],
    queryFn: async () => {
      const params = new URLSearchParams({
        q: searchQuery!.value,
        type: searchQuery!.type,
      });
      const res = await fetch(`/api/orders?${params}`);
      if (!res.ok) throw new Error("Failed to fetch orders");
      return res.json();
    },
    enabled: !!searchQuery,
  });

  const filteredOrders = ordersQuery.data?.filter((order) => {
    if (activeStatusIds.size === 0) return true;
    const matchingStatus = statusesQuery.data?.find(s => s.name === order.status);
    return matchingStatus ? activeStatusIds.has(matchingStatus.id) : true;
  }) || [];

  const handleLookup = lookupForm.handleSubmit((data) => {
    setSearchQuery({ value: data.searchValue, type: data.searchType });
    setStatusesInitialized(false);
    queryClient.invalidateQueries({ queryKey: ["/api/orders"] });
  });

  const toggleStatus = (id: string) => {
    setActiveStatusIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
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
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center space-y-3">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
              <Package className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight" data-testid="text-app-title">
              Mint Printworks
            </h1>
            <p className="text-lg text-muted-foreground">
              Reorder Portal
            </p>
            <p className="text-sm text-muted-foreground max-w-sm mx-auto">
              Search by email or company name to view your order history and easily place a reorder.
            </p>
          </div>

          <Card>
            <CardContent className="pt-6">
              <form onSubmit={handleLookup} className="space-y-4">
                <Form {...lookupForm}>
                  <div className="flex gap-1 p-1 bg-muted rounded-lg" data-testid="search-type-toggle">
                    <button
                      type="button"
                      onClick={() => { lookupForm.setValue("searchType", "email"); lookupForm.setValue("searchValue", ""); }}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-all ${searchType === "email" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      data-testid="toggle-email"
                    >
                      <Mail className="w-3.5 h-3.5" />
                      Email
                    </button>
                    <button
                      type="button"
                      onClick={() => { lookupForm.setValue("searchType", "company"); lookupForm.setValue("searchValue", ""); }}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium transition-all ${searchType === "company" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      data-testid="toggle-company"
                    >
                      <Building2 className="w-3.5 h-3.5" />
                      Company
                    </button>
                  </div>
                  <FormField
                    control={lookupForm.control}
                    name="searchValue"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{searchType === "email" ? "Email Address" : "Company Name"}</FormLabel>
                        <FormControl>
                          <div className="relative">
                            {searchType === "email" ? (
                              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            ) : (
                              <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            )}
                            <Input
                              placeholder={searchType === "email" ? "you@company.com" : "Enter company name"}
                              className="pl-9"
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
                <Button type="submit" className="w-full" data-testid="button-lookup">
                  <Search className="w-4 h-4 mr-2" />
                  View My Orders
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={handleBack} data-testid="button-back">
              <ArrowLeft className="w-4 h-4" />
            </Button>
            <div>
              <h1 className="font-semibold text-base" data-testid="text-dashboard-title">Your Orders</h1>
              <p className="text-xs text-muted-foreground" data-testid="text-search-query">
                {searchQuery.type === "email" ? searchQuery.value : `Company: ${searchQuery.value}`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!ordersQuery.isLoading && (
              <Badge variant="secondary" className="text-xs" data-testid="text-order-count">
                {filteredOrders.length} order{filteredOrders.length !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        {statusesQuery.data && statusesQuery.data.length > 0 && (
          <StatusFilterBar
            statuses={statusesQuery.data}
            activeStatusIds={activeStatusIds}
            onToggle={toggleStatus}
          />
        )}

        {ordersQuery.isLoading && (
          <div className="space-y-4" data-testid="loading-skeleton">
            {[1, 2, 3].map((i) => <OrderCardSkeleton key={i} />)}
          </div>
        )}

        {ordersQuery.isError && (
          <Card className="border-destructive/30">
            <CardContent className="pt-6 text-center space-y-3">
              <p className="text-destructive font-medium">Unable to load orders</p>
              <p className="text-sm text-muted-foreground">
                {ordersQuery.error instanceof Error ? ordersQuery.error.message : "Please try again later."}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => ordersQuery.refetch()}
                data-testid="button-retry"
              >
                Try Again
              </Button>
            </CardContent>
          </Card>
        )}

        {ordersQuery.data && filteredOrders.length === 0 && (
          <Card>
            <CardContent className="pt-6 text-center space-y-3 py-16">
              <Package className="w-12 h-12 text-muted-foreground/30 mx-auto" />
              <p className="text-muted-foreground font-medium">No orders found</p>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                {activeStatusIds.size < (statusesQuery.data?.length || 0)
                  ? "Try adjusting your status filters to see more orders."
                  : "We couldn't find any orders associated with this email address."}
              </p>
            </CardContent>
          </Card>
        )}

        {filteredOrders.length > 0 && (
          <div className="space-y-4" data-testid="orders-list">
            {filteredOrders.map((order) => (
              <OrderCard
                key={order.id}
                order={order}
                onReorder={(o) => setReorderOrder(o)}
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
