import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { useStaff } from "@/components/auth/StaffGate";
import { useToast } from "@/hooks/use-toast";
import {
  useListDirectoryCustomers,
  getListDirectoryCustomersQueryKey,
  useListCustomerCategories,
  getListCustomerCategoriesQueryKey,
  useAssignCustomerCategory,
  useCreateCustomerCategory,
  useUpdateCustomerCategory,
  type ListDirectoryCustomersParams,
} from "@workspace/api-client-react";
import { formatMoney, formatNumber } from "@/lib/format";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  Users,
  Search,
  Loader2,
  Tags,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";

const PAGE_SIZE = 50;

function CategoryManagerDialog() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data } = useListCustomerCategories({
    query: { queryKey: getListCustomerCategoriesQueryKey() },
  });
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListCustomerCategoriesQueryKey() });
  };
  const onError = (err: unknown) => {
    const msg =
      (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
      "Something went wrong";
    toast({ title: "Category change failed", description: msg, variant: "destructive" });
  };

  const createCat = useCreateCustomerCategory({
    mutation: {
      onSuccess: () => {
        setNewName("");
        invalidate();
      },
      onError,
    },
  });
  const updateCat = useUpdateCustomerCategory({
    mutation: {
      onSuccess: () => {
        setEditingId(null);
        invalidate();
      },
      onError,
    },
  });

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Tags size={14} /> Manage categories
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Niche categories</DialogTitle>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            placeholder="New category name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newName.trim()) {
                createCat.mutate({ data: { name: newName.trim() } });
              }
            }}
          />
          <Button
            disabled={!newName.trim() || createCat.isPending}
            onClick={() => createCat.mutate({ data: { name: newName.trim() } })}
          >
            Add
          </Button>
        </div>
        <div className="space-y-1 mt-2">
          {(data?.categories ?? []).map((c) => (
            <div
              key={c.id}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-800 ${
                c.active ? "" : "opacity-50"
              }`}
            >
              {editingId === c.id ? (
                <>
                  <Input
                    className="h-8"
                    value={editName}
                    autoFocus
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && editName.trim()) {
                        updateCat.mutate({ id: c.id, data: { name: editName.trim() } });
                      }
                      if (e.key === "Escape") setEditingId(null);
                    }}
                  />
                  <Button
                    size="sm"
                    className="h-8"
                    disabled={!editName.trim() || updateCat.isPending}
                    onClick={() =>
                      updateCat.mutate({ id: c.id, data: { name: editName.trim() } })
                    }
                  >
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2"
                    onClick={() => setEditingId(null)}
                  >
                    <X size={14} />
                  </Button>
                </>
              ) : (
                <>
                  <button
                    className="flex-1 text-left text-sm text-slate-200 hover:text-white truncate"
                    title="Click to rename"
                    onClick={() => {
                      setEditingId(c.id);
                      setEditName(c.name);
                    }}
                  >
                    {c.name}
                  </button>
                  <span className="text-xs text-slate-500 tabular-nums">
                    {c.assignedCount ?? 0} assigned
                  </span>
                  <Switch
                    checked={c.active}
                    onCheckedChange={(active) =>
                      updateCat.mutate({ id: c.id, data: { active } })
                    }
                  />
                </>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          Toggling a category off hides it from assignment; existing assignments and
          report history are kept.
        </p>
      </DialogContent>
    </Dialog>
  );
}

export default function CustomersDirectory() {
  const { role } = useStaff();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  // all | uncategorized | <categoryId> — supports ?filter=uncategorized deep link
  const [filter, setFilter] = useState<string>(() =>
    new URLSearchParams(window.location.search).get("filter") === "uncategorized"
      ? "uncategorized"
      : "all",
  );
  const [sort, setSort] = useState<"spend" | "name">("spend");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState<string>("");

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const params: ListDirectoryCustomersParams = {
    sort,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
    ...(search ? { search } : {}),
    ...(filter === "uncategorized"
      ? { uncategorized: "true" as const }
      : filter !== "all"
        ? { categoryId: filter }
        : {}),
  };

  const { data, isLoading, isFetching } = useListDirectoryCustomers(params, {
    query: { queryKey: getListDirectoryCustomersQueryKey(params) },
  });
  const { data: catData } = useListCustomerCategories({
    query: { queryKey: getListCustomerCategoriesQueryKey() },
  });

  const categories = catData?.categories ?? [];
  const activeCategories = categories.filter((c) => c.active);
  const catById = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name])),
    [categories],
  );
  const categorizedCount = categories.reduce((s, c) => s + (c.assignedCount ?? 0), 0);

  const assign = useAssignCustomerCategory({
    mutation: {
      onSuccess: (r, vars) => {
        toast({
          title:
            vars.data.categoryId == null
              ? `Category cleared for ${r.assigned} customer${r.assigned === 1 ? "" : "s"}`
              : `${r.assigned} customer${r.assigned === 1 ? "" : "s"} categorized`,
        });
        setSelected(new Set());
        // Generated query keys all start with "/api/customers…" — refresh
        // directory, categories (assignedCount), and the niche report.
        qc.invalidateQueries({
          predicate: (q) =>
            typeof q.queryKey[0] === "string" &&
            q.queryKey[0].startsWith("/api/customers"),
        });
      },
      onError: () =>
        toast({
          title: "Assignment failed",
          description: "Please try again.",
          variant: "destructive",
        }),
    },
  });

  const customers = data?.customers ?? [];
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allOnPageSelected =
    customers.length > 0 && customers.every((c) => selected.has(c.printavoId));

  const toggleAllOnPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) customers.forEach((c) => next.delete(c.printavoId));
      else customers.forEach((c) => next.add(c.printavoId));
      return next;
    });
  };

  return (
    <AppShell>
      <div className="sticky top-0 z-10 bg-[#020617]/80 backdrop-blur-md border-b border-slate-800 px-8 py-5 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <Users size={20} className="text-[#10b981]" />
            Customer Directory
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            {formatNumber(categorizedCount)} customer
            {categorizedCount === 1 ? "" : "s"} categorized so far — biggest spenders
            first, so categorizing top-down covers the most revenue
          </p>
        </div>
        {role === "admin" && <CategoryManagerDialog />}
      </div>

      <div className="px-8 py-4 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
          <Input
            className="pl-8 w-64"
            placeholder="Search name or email…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <Select
          value={filter}
          onValueChange={(v) => {
            setFilter(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All customers</SelectItem>
            <SelectItem value="uncategorized">Uncategorized only</SelectItem>
            {activeCategories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sort}
          onValueChange={(v) => {
            setSort(v as "spend" | "name");
            setPage(0);
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="spend">Sort: Lifetime spend</SelectItem>
            <SelectItem value="name">Sort: Name</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-slate-500 ml-auto tabular-nums">
          {isFetching && !isLoading ? (
            <Loader2 size={12} className="inline animate-spin mr-1" />
          ) : null}
          {formatNumber(total)} customer{total === 1 ? "" : "s"}
        </span>
      </div>

      <div className="px-8 pb-28">
        <div className="border border-slate-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-900/60 text-slate-400 text-xs uppercase tracking-wider">
                <th className="px-4 py-3 w-10">
                  <Checkbox checked={allOnPageSelected} onCheckedChange={toggleAllOnPage} />
                </th>
                <th className="px-4 py-3 text-left font-semibold">Customer</th>
                <th className="px-4 py-3 text-left font-semibold">Contact</th>
                <th className="px-4 py-3 text-left font-semibold">Category</th>
                <th className="px-4 py-3 text-right font-semibold">Lifetime spend</th>
                <th className="px-4 py-3 text-right font-semibold">Orders</th>
                <th className="px-4 py-3 text-right font-semibold">Last order</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                    <Loader2 size={18} className="inline animate-spin mr-2" />
                    Loading customers…
                  </td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                    No customers match.
                  </td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr key={c.printavoId} className="hover:bg-slate-900/40">
                    <td className="px-4 py-2.5">
                      <Checkbox
                        checked={selected.has(c.printavoId)}
                        onCheckedChange={(v) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(c.printavoId);
                            else next.delete(c.printavoId);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="px-4 py-2.5 font-medium text-slate-200 max-w-[260px] truncate">
                      {c.displayName}
                    </td>
                    <td className="px-4 py-2.5 text-slate-400 max-w-[220px] truncate">
                      {c.contactName ?? "—"}
                      {c.contactEmail ? (
                        <span className="text-slate-600"> · {c.contactEmail}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2.5 w-56">
                      <Select
                        value={c.categoryId ?? "none"}
                        onValueChange={(v) =>
                          assign.mutate({
                            data: {
                              customerIds: [c.printavoId],
                              categoryId: v === "none" ? null : v,
                            },
                          })
                        }
                      >
                        <SelectTrigger
                          className={`h-8 ${c.categoryId ? "" : "text-slate-500 border-dashed"}`}
                        >
                          <SelectValue>
                            {c.categoryId
                              ? (catById.get(c.categoryId) ?? "Unknown")
                              : "Set category…"}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">— No category —</SelectItem>
                          {activeCategories.map((cat) => (
                            <SelectItem key={cat.id} value={cat.id}>
                              {cat.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-200">
                      {formatMoney(c.lifetimeSpend)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-400">
                      {formatNumber(c.orderCount)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-slate-400">
                      {c.lastOrderAt ?? "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between mt-4">
          <span className="text-xs text-slate-500">
            Page {page + 1} of {formatNumber(pageCount)}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              <ChevronLeft size={14} /> Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page + 1 >= pageCount}
              onClick={() => setPage((p) => p + 1)}
            >
              Next <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl px-5 py-3">
          <span className="text-sm text-slate-200 font-medium tabular-nums">
            {selected.size} selected
          </span>
          <Select value={bulkCategory} onValueChange={setBulkCategory}>
            <SelectTrigger className="w-60 h-9">
              <SelectValue placeholder="Choose category…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— Clear category —</SelectItem>
              {activeCategories.map((cat) => (
                <SelectItem key={cat.id} value={cat.id}>
                  {cat.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={!bulkCategory || assign.isPending}
            onClick={() =>
              assign.mutate({
                data: {
                  customerIds: Array.from(selected),
                  categoryId: bulkCategory === "none" ? null : bulkCategory,
                },
              })
            }
          >
            {assign.isPending ? <Loader2 size={14} className="animate-spin" /> : "Apply"}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            <X size={14} />
          </Button>
        </div>
      )}
    </AppShell>
  );
}
