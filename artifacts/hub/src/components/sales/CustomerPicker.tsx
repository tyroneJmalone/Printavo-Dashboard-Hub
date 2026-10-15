import { useEffect, useState } from "react";
import {
  useListDirectoryCustomers,
  getListDirectoryCustomersQueryKey,
} from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Loader2, Search, X } from "lucide-react";

export interface PickedCustomer {
  id: string;
  name: string;
}

function useDebounced(v: string, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v.trim()), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

function Results({ q, onPick, exclude }: { q: string; onPick: (c: PickedCustomer) => void; exclude: Set<string> }) {
  const params = { search: q, searchScope: "names" as const, sort: "spend" as const, limit: 25, offset: 0 };
  const { data, isLoading, isError } = useListDirectoryCustomers(params, {
    query: { queryKey: getListDirectoryCustomersQueryKey(params), enabled: q.length > 0 },
  });
  if (!q) return null;
  return (
    <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950">
      {isLoading ? (
        <p className="px-3 py-2 text-xs text-slate-500"><Loader2 size={12} className="inline animate-spin mr-1" />Searching…</p>
      ) : isError ? (
        <p className="px-3 py-2 text-xs text-red-400">Search failed.</p>
      ) : (data?.customers ?? []).length === 0 ? (
        <p className="px-3 py-2 text-xs text-slate-500">No customers match.</p>
      ) : (
        <>
          {(data?.customers ?? []).map((c) => (
            <button
              type="button"
              key={c.printavoId}
              disabled={exclude.has(c.printavoId)}
              onClick={() => onPick({ id: c.printavoId, name: c.displayName })}
              className="block w-full text-left px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-40"
              data-testid={`option-customer-${c.printavoId}`}
            >
              {c.displayName}
              {c.contactName ? <span className="text-slate-500 text-xs"> · {c.contactName}</span> : null}
            </button>
          ))}
          {(data?.total ?? 0) > 25 && (
            <p className="px-3 py-1.5 text-[11px] text-slate-500">{data?.total} matches — keep typing to narrow.</p>
          )}
        </>
      )}
    </div>
  );
}

export function CustomerPicker({ value, onChange }: { value: PickedCustomer | null; onChange: (c: PickedCustomer | null) => void }) {
  const [input, setInput] = useState("");
  const q = useDebounced(input);
  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900 px-3 h-9 text-sm text-slate-200">
        <span className="truncate">{value.name}</span>
        <button type="button" onClick={() => onChange(null)} className="text-slate-500 hover:text-slate-200" aria-label="Clear customer">
          <X size={14} />
        </button>
      </div>
    );
  }
  return (
    <div>
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <Input className="pl-8" placeholder="Search customers…" value={input} onChange={(e) => setInput(e.target.value)} data-testid="input-customer-search" />
      </div>
      <Results q={q} exclude={new Set()} onPick={(c) => { onChange(c); setInput(""); }} />
    </div>
  );
}

export function CustomerMultiPicker({ value, onChange }: { value: PickedCustomer[]; onChange: (c: PickedCustomer[]) => void }) {
  const [input, setInput] = useState("");
  const q = useDebounced(input);
  return (
    <div>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {value.map((c) => (
            <span key={c.id} className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800/70 px-2 py-0.5 text-xs text-slate-200">
              {c.name}
              <button type="button" onClick={() => onChange(value.filter((x) => x.id !== c.id))} className="text-slate-500 hover:text-red-400" aria-label={`Remove ${c.name}`}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
        <Input className="pl-8" placeholder="Add specific clients…" value={input} onChange={(e) => setInput(e.target.value)} data-testid="input-client-multisearch" />
      </div>
      <Results q={q} exclude={new Set(value.map((v) => v.id))} onPick={(c) => onChange([...value, c])} />
    </div>
  );
}
