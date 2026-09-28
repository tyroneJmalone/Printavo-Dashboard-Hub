import { Copy, Mail, Search } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";

export function parsePipelineEmails(value: string): string[] {
  const matches: string[] = value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi) ?? [];
  const seen = new Set<string>();
  return matches.filter((email) => {
    const key = email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function missiveEmailSearchUrl(email: string): string {
  // Missive's search mailbox routes encode the search text in the hash.
  return `https://mail.missiveapp.com/#search/${encodeURIComponent(email)}`;
}

export function PipelineEmails({ value }: { value?: string | null }) {
  const { toast } = useToast();
  if (!value?.trim()) return <span className="text-slate-500">—</span>;
  const emails = parsePipelineEmails(value);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Email copied" });
    } catch {
      toast({
        title: "Could not copy",
        description: "Select the address in this panel and copy it manually.",
        variant: "destructive",
      });
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Show ${emails.length || ""} customer email${emails.length === 1 ? "" : "s"}`}
          title="Show emails, copy, or search in Missive"
          className="inline-flex h-7 items-center gap-1.5 rounded border border-slate-700 px-2 text-xs text-slate-300 hover:border-emerald-500 hover:text-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          <Mail size={14} aria-hidden="true" />
          <span>{emails.length || "View"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] border-slate-700 bg-slate-900 text-slate-200">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Customer emails</h3>
          {emails.length > 1 && (
            <button type="button" onClick={() => void copy(emails.join("; "))} className="text-xs text-emerald-400 hover:underline">
              Copy all
            </button>
          )}
        </div>
        <p className="mb-3 text-xs text-slate-400">Click an address to search existing conversations in Missive.</p>
        <div className="max-h-64 space-y-2 overflow-y-auto">
          {emails.length ? emails.map((email) => (
            <div key={email} className="flex items-start gap-2 rounded bg-slate-950/60 p-2">
              <a
                href={missiveEmailSearchUrl(email)}
                target="_blank"
                rel="noopener noreferrer"
                title={`Search Missive for ${email} (opens a new tab)`}
                className="flex min-w-0 flex-1 items-start gap-2 rounded text-sm text-emerald-400 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              >
                <Search size={14} className="mt-1 shrink-0" aria-hidden="true" />
                <span className="break-all">{email}</span>
              </a>
              <button type="button" aria-label={`Copy ${email}`} title="Copy email" onClick={() => void copy(email)} className="shrink-0 rounded p-1 text-slate-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500">
                <Copy size={14} aria-hidden="true" />
              </button>
            </div>
          )) : (
            <div className="text-sm">
              <p className="break-all select-text">{value}</p>
              <p className="mt-2 text-xs text-slate-400">No recognizable email address. You can still copy the original value.</p>
              <button type="button" onClick={() => void copy(value)} className="mt-2 text-xs text-emerald-400 hover:underline">Copy original value</button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}