import {
  useGetModuleAccess,
  getGetModuleAccessQueryKey,
  useUpdateModuleAccess,
  type ModuleAccessModule,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { LayoutGrid, Loader2 } from "lucide-react";

function apiError(err: unknown): string | undefined {
  const e = err as { data?: { error?: string }; message?: string } | undefined;
  return e?.data?.error ?? e?.message;
}

/**
 * Module readiness switches (admin-only). OFF = hidden from the sidebar and
 * blocked at the API for managers/staff. Admins always see everything.
 */
export function ModuleAccessCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useGetModuleAccess({
    query: { queryKey: getGetModuleAccessQueryKey() },
  });

  const update = useUpdateModuleAccess({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetModuleAccessQueryKey() });
      },
      onError: (err) => {
        queryClient.invalidateQueries({ queryKey: getGetModuleAccessQueryKey() });
        toast({
          title: "Couldn't update module access",
          description: apiError(err) ?? "Update failed",
          variant: "destructive",
        });
      },
    },
  });

  const modules = data?.modules ?? [];
  const enabledCount = modules.filter((m) => m.enabled).length;

  const toggle = (key: string) => {
    if (update.isPending) return;
    const enabled = modules
      .filter((m) => (m.key === key ? !m.enabled : m.enabled))
      .map((m) => m.key);
    update.mutate({ data: { enabled } });
  };

  const groups: { heading: string; items: ModuleAccessModule[] }[] = [];
  for (const mod of modules) {
    const existing = groups.find((g) => g.heading === mod.group);
    if (existing) existing.items.push(mod);
    else groups.push({ heading: mod.group, items: [mod] });
  }

  return (
    <div className="bg-slate-900/40 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-2.5">
        <LayoutGrid size={16} className="text-[#10b981]" />
        <div className="flex-1">
          <div className="text-sm font-semibold text-slate-100">Module access</div>
          <div className="text-[11px] text-slate-500 mt-0.5">
            Which parts of the Hub managers and staff can use. Switched-off
            modules are hidden from their menu and blocked on the server.
            Admins always have full access.
          </div>
        </div>
        <span className="text-[10px] font-semibold text-slate-400 bg-slate-800 border border-slate-700 rounded px-2 py-1 flex-shrink-0">
          {enabledCount}/{modules.length} on
        </span>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 size={18} className="animate-spin text-slate-500" />
        </div>
      ) : (
        <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
          {groups.map((group) => (
            <div key={group.heading}>
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500 mb-1.5">
                {group.heading}
              </div>
              <div className="space-y-1">
                {group.items.map((mod) => (
                  <button
                    key={mod.key}
                    type="button"
                    onClick={() => toggle(mod.key)}
                    disabled={update.isPending}
                    className="w-full flex items-center justify-between gap-3 px-2.5 py-1.5 rounded-md hover:bg-slate-800/70 transition-colors disabled:opacity-60 text-left"
                  >
                    <span
                      className={`text-[13px] font-medium ${
                        mod.enabled ? "text-slate-200" : "text-slate-500"
                      }`}
                    >
                      {mod.label}
                    </span>
                    <span
                      role="switch"
                      aria-checked={mod.enabled}
                      className={`relative inline-flex h-4 w-8 flex-shrink-0 items-center rounded-full border transition-colors ${
                        mod.enabled
                          ? "bg-[#059669]/70 border-[#059669]"
                          : "bg-slate-800 border-slate-700"
                      }`}
                    >
                      <span
                        className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                          mod.enabled ? "translate-x-4" : "translate-x-0.5"
                        }`}
                      />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
