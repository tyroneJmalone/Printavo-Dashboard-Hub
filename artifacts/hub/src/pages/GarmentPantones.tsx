import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Palette, Search, ShieldCheck, Trash2 } from "lucide-react";
import {
  CatalogPantoneIdentity,
  getListCatalogPantonesQueryKey,
  useListCatalogPantones,
  useSetCatalogPantone,
} from "@workspace/api-client-react";

const formSchema = z.object({
  pantoneCode: z.string().trim().min(1, "Enter the documented Pantone code.").max(64),
  pantoneSource: z.enum(["vendor_documentation", "staff_verification"]),
});
type FormValues = z.infer<typeof formSchema>;

function identityKey(item: CatalogPantoneIdentity): string {
  return `${item.vendor}|${item.styleName}|${item.colorName}`;
}

function sourceLabel(source: CatalogPantoneIdentity["pantoneSource"]): string {
  if (source === "vendor_documentation") return "Vendor documentation";
  if (source === "staff_verification") return "Staff verification";
  return "";
}

export default function GarmentPantones() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<CatalogPantoneIdentity | null>(null);
  const params = { q: search || undefined, limit: 50, offset };
  const query = useListCatalogPantones(params, {
    query: { queryKey: getListCatalogPantonesQueryKey(params), staleTime: 30_000 },
  });
  const qc = useQueryClient();
  const { toast } = useToast();
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { pantoneCode: "", pantoneSource: "vendor_documentation" },
  });

  useEffect(() => {
    if (!selected) return;
    form.reset({
      pantoneCode: selected.pantoneCode ?? "",
      pantoneSource: selected.pantoneSource ?? "vendor_documentation",
    });
  }, [form, selected]);

  const mutation = useSetCatalogPantone({
    mutation: {
      onSuccess: (saved) => {
        setSelected(saved);
        form.reset({
          pantoneCode: saved.pantoneCode ?? "",
          pantoneSource: saved.pantoneSource ?? "vendor_documentation",
        });
        qc.invalidateQueries({ queryKey: getListCatalogPantonesQueryKey() });
        toast({ title: saved.pantoneCode ? "Garment Pantone saved" : "Garment Pantone removed" });
      },
      onError: (error) => {
        toast({ title: "Pantone update failed", description: String(error), variant: "destructive" });
      },
    },
  });

  const save = (values: FormValues) => {
    if (!selected) return;
    mutation.mutate({
      data: {
        vendor: selected.vendor,
        styleName: selected.styleName,
        colorName: selected.colorName,
        pantoneCode: values.pantoneCode,
        pantoneSource: values.pantoneSource,
      },
    });
  };

  const remove = () => {
    if (!selected) return;
    mutation.mutate({
      data: {
        vendor: selected.vendor,
        styleName: selected.styleName,
        colorName: selected.colorName,
        pantoneCode: null,
        pantoneSource: null,
      },
    });
  };

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault();
    setOffset(0);
    setSearch(searchInput.trim());
    setSelected(null);
  };

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-7xl space-y-6 p-6">
        <header>
          <h1 className="flex items-center gap-2 text-xl font-bold text-white" data-testid="text-pantone-page-title">
            <Palette className="text-emerald-400" size={24} />
            Garment Pantones
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Record only Pantones confirmed by vendor documentation or direct staff verification. Never estimate from a swatch.
          </p>
        </header>

        <form onSubmit={submitSearch} className="flex max-w-2xl gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" size={16} />
            <Input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search vendor, style, brand, or exact color…"
              className="pl-9"
              data-testid="input-pantone-search"
            />
          </div>
          <Button type="submit" data-testid="button-pantone-search">Search</Button>
        </form>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(320px,1fr)]">
          <Card className="border-slate-800 bg-slate-900/50">
            <CardHeader>
              <CardTitle className="text-base text-slate-100">
                Imported colors
                {!query.isLoading && <span className="ml-2 text-xs font-normal text-slate-500" data-testid="text-pantone-total">{total} identities</span>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {query.isLoading ? (
                <div className="flex items-center gap-2 py-12 text-sm text-slate-400" data-testid="status-pantones-loading">
                  <Loader2 className="animate-spin" size={18} /> Loading imported colors…
                </div>
              ) : query.isError ? (
                <div className="py-12 text-sm text-red-400" data-testid="status-pantones-error">
                  Could not load imported colors. Please try again.
                </div>
              ) : items.length === 0 ? (
                <div className="py-12 text-sm text-slate-400" data-testid="status-pantones-empty">
                  No imported vendor/style/color identities match this search.
                </div>
              ) : (
                <div className="divide-y divide-slate-800">
                  {items.map((item) => {
                    const key = identityKey(item);
                    const active = selected && identityKey(selected) === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setSelected(item)}
                        className={`grid w-full grid-cols-[48px_1fr_auto] gap-3 px-2 py-3 text-left transition-colors ${active ? "bg-emerald-500/10" : "hover:bg-slate-800/60"}`}
                        data-testid={`button-pantone-identity-${key.replace(/[^a-zA-Z0-9]/g, "-")}`}
                      >
                        {item.swatchImage || item.productImage ? (
                          <img
                            src={item.swatchImage ?? item.productImage ?? ""}
                            alt=""
                            className="h-12 w-12 rounded-md border border-slate-700 object-cover"
                            data-testid={`img-pantone-swatch-${key.replace(/[^a-zA-Z0-9]/g, "-")}`}
                          />
                        ) : <div className="h-12 w-12 rounded-md border border-slate-800 bg-slate-950" />}
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-slate-200">{item.styleName} · {item.colorName}</span>
                          <span className="block truncate text-xs text-slate-500">{item.vendor.toUpperCase()} · {item.brand ?? item.title ?? "Imported product"}</span>
                        </span>
                        <span className="text-right">
                          <span className={`block font-mono text-xs ${item.pantoneCode ? "text-slate-200" : "text-slate-500"}`} data-testid={`text-pantone-code-${key.replace(/[^a-zA-Z0-9]/g, "-")}`}>
                            {item.pantoneCode ?? "Not provided."}
                          </span>
                          {item.pantoneSource && <span className="mt-1 block text-[10px] text-slate-500">{sourceLabel(item.pantoneSource)}</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {!query.isLoading && !query.isError && total > 0 && (
                <div className="mt-4 flex items-center justify-between border-t border-slate-800 pt-4">
                  <Button variant="outline" type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))} data-testid="button-pantones-previous">Previous</Button>
                  <span className="text-xs text-slate-500" data-testid="text-pantones-range">
                    {offset + 1}–{Math.min(offset + items.length, total)} of {total}
                  </span>
                  <Button variant="outline" type="button" disabled={offset + items.length >= total} onClick={() => setOffset(offset + 50)} data-testid="button-pantones-next">Next</Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="h-fit border-slate-800 bg-slate-900/50">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                <ShieldCheck size={18} className="text-emerald-400" /> Verification
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!selected ? (
                <p className="text-sm text-slate-400" data-testid="status-pantone-selection-empty">Select an exact imported color to review it.</p>
              ) : (
                <>
                  <div className="mb-5 rounded-md border border-slate-800 bg-slate-950/60 p-3" data-testid="text-pantone-selected-identity">
                    <div className="font-mono text-sm text-slate-200">{selected.vendor}:{selected.styleName}</div>
                    <div className="mt-1 text-sm text-slate-400">{selected.colorName}</div>
                    {!selected.pantoneCode && <div className="mt-2 text-xs text-slate-500">Not provided.</div>}
                  </div>
                  <Form {...form}>
                    <form onSubmit={form.handleSubmit(save)} className="space-y-4">
                      <FormField control={form.control} name="pantoneCode" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Verified Pantone code</FormLabel>
                          <FormControl>
                            <Input {...field} placeholder="e.g. 186 C" autoComplete="off" data-testid="input-pantone-code" />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <FormField control={form.control} name="pantoneSource" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Provenance</FormLabel>
                          <Select value={field.value} onValueChange={field.onChange}>
                            <FormControl>
                              <SelectTrigger data-testid="select-pantone-source"><SelectValue /></SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              <SelectItem value="vendor_documentation" data-testid="option-source-vendor-documentation">Vendor documentation</SelectItem>
                              <SelectItem value="staff_verification" data-testid="option-source-staff-verification">Staff verification</SelectItem>
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )} />
                      <div className="flex gap-2">
                        <Button type="submit" disabled={mutation.isPending} data-testid="button-save-pantone">
                          {mutation.isPending && <Loader2 className="mr-2 animate-spin" size={15} />} Save verification
                        </Button>
                        {selected.pantoneCode && (
                          <Button type="button" variant="destructive" disabled={mutation.isPending} onClick={remove} data-testid="button-remove-pantone">
                            <Trash2 className="mr-2" size={15} /> Remove
                          </Button>
                        )}
                      </div>
                    </form>
                  </Form>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}