import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Save, Settings2 } from "lucide-react";
import {
  getGetKnowledgeClassificationSettingsQueryKey,
  type KnowledgeClassificationSettings,
  type KnowledgeGroup,
  useGetKnowledgeClassificationSettings,
  useUpdateKnowledgeClassificationSettings,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";

export const KNOWLEDGE_GROUPS = [
  {
    id: "customer_shareable",
    label: "Customer-Shareable",
    starterRules: "Customer facts preserve exceptions; do not invent promises.",
  },
  {
    id: "internal_operational",
    label: "Internal Operational Knowledge",
    starterRules: "Internal procedures are never exposed to customer replies.",
  },
  {
    id: "brand_voice",
    label: "Brand/Voice Guidance",
    starterRules: "Brand tone is wording only, not evidence for prices, policies, or promises.",
  },
] as const;

export type ClassificationGroupSettings = {
  id: KnowledgeGroup;
  label: string;
  rules: string;
  categories: string[];
};

export type ClassificationSettingsResponse = KnowledgeClassificationSettings;

export const classificationSettingsQueryKey = getGetKnowledgeClassificationSettingsQueryKey();

const inputClass =
  "w-full rounded-md border border-slate-700 bg-[#1e293b] px-2.5 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#059669] focus:outline-none focus:ring-1 focus:ring-[#059669]";
const primaryButton =
  "inline-flex items-center gap-1.5 rounded-md bg-[#059669] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#047857] disabled:cursor-not-allowed disabled:opacity-50";
const ghostButton =
  "inline-flex items-center gap-1.5 rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-50";

const defaultClassificationSettings: ClassificationSettingsResponse = {
  groups: KNOWLEDGE_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    rules: [group.starterRules],
    categories: [],
  })),
  updatedAt: null,
};

type EditableClassificationSettings = {
  groups: ClassificationGroupSettings[];
  updatedAt: string | null;
};

type CategoryInputs = Record<KnowledgeGroup, string>;

function parseCategoryInput(value: string): string[] {
  return value
    .split(",")
    .map((category) => category.trim())
    .filter(Boolean);
}

function categoryInputsFor(groups: ClassificationGroupSettings[]): CategoryInputs {
  return groups.reduce(
    (inputs, group) => {
      inputs[group.id] = group.categories.join(", ");
      return inputs;
    },
    {} as CategoryInputs,
  );
}

export function normalizeClassificationSettings(
  response?: KnowledgeClassificationSettings | null,
): EditableClassificationSettings {
  const incoming = response?.groups ?? [];
  return {
    groups: KNOWLEDGE_GROUPS.map((group) => {
      const saved = incoming.find((candidate) => candidate?.id === group.id);
      return {
        id: group.id,
        // Group ids and labels are immutable. The server may include labels in
        // the response, but the Hub keeps the product labels canonical.
        label: group.label,
        rules: Array.isArray(saved?.rules) ? saved.rules.join("\n") : group.starterRules,
        categories: Array.isArray(saved?.categories)
          ? saved.categories.filter((category): category is string => typeof category === "string")
          : [],
      };
    }),
    updatedAt: typeof response?.updatedAt === "string" ? response.updatedAt : null,
  };
}

export function useClassificationSettings(enabled = true) {
  return useGetKnowledgeClassificationSettings({
    query: {
      queryKey: getGetKnowledgeClassificationSettingsQueryKey(),
      enabled,
    },
  });
}

export function getDefaultKnowledgeGroup(
  category: string,
  settings?: ClassificationSettingsResponse | null,
): KnowledgeGroup {
  const normalizedCategory = category.trim().toLocaleLowerCase();
  if (!normalizedCategory) return "internal_operational";

  const groups = settings?.groups ?? defaultClassificationSettings.groups;
  const matchingGroup = groups.find((group) =>
    group.categories.some((candidate) => candidate.trim().toLocaleLowerCase() === normalizedCategory),
  );
  return matchingGroup?.id ?? "internal_operational";
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as {
      status?: number;
      error?: unknown;
      message?: unknown;
      data?: { error?: unknown; message?: unknown };
    };
    if (value.status === 409 || value.status === 412) {
      return "These settings changed in another tab. Reload the latest settings before saving.";
    }
    if (typeof value.data?.error === "string") return value.data.error;
    if (typeof value.data?.message === "string") return value.data.message;
    if (typeof value.error === "string") return value.error;
    if (typeof value.message === "string") return value.message;
  }
  return "We couldn't save classification settings. Try again.";
}

function ClassificationSettingsForm({
  groups,
  setGroups,
  categoryInputs,
  setCategoryInputs,
  duplicateCategory,
}: {
  groups: ClassificationGroupSettings[];
  setGroups: React.Dispatch<React.SetStateAction<ClassificationGroupSettings[]>>;
  categoryInputs: CategoryInputs;
  setCategoryInputs: React.Dispatch<React.SetStateAction<CategoryInputs>>;
  duplicateCategory: string | null;
}) {
  const updateGroup = (id: KnowledgeGroup, value: string) => {
    setGroups((current) =>
      current.map((group) =>
        group.id !== id
          ? group
          : {
              ...group,
              rules: value,
            },
      ),
    );
  };

  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <section key={group.id} className="rounded-lg border border-slate-800 bg-slate-950/35 p-3.5">
          <div className="mb-2">
            <h3 className="text-sm font-semibold text-slate-100">{group.label}</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">
              This group is fixed. Edit only its guidance and category mapping.
            </p>
          </div>
          <label className="block text-xs font-medium text-slate-300">
            Rules
            <textarea
              className={`${inputClass} mt-1 min-h-[76px] resize-y leading-relaxed`}
              value={group.rules}
              onChange={(event) => updateGroup(group.id, event.target.value)}
              aria-label={`${group.label} rules`}
              maxLength={4000}
            />
          </label>
          <label className="mt-2 block text-xs font-medium text-slate-300">
            Topic categories
            <input
              className={`${inputClass} mt-1`}
              value={categoryInputs[group.id] ?? ""}
              onChange={(event) =>
                setCategoryInputs((current) => ({
                  ...current,
                  [group.id]: event.target.value,
                }))
              }
              onBlur={() =>
                setCategoryInputs((current) => ({
                  ...current,
                  [group.id]: parseCategoryInput(current[group.id] ?? "").join(", "),
                }))
              }
              placeholder="e.g. pricing, shipping, faq"
              aria-label={`${group.label} topic categories`}
              maxLength={2000}
            />
          </label>
          {duplicateCategory && (
            <p className="mt-1.5 text-[11px] text-amber-300">
              “{duplicateCategory}” is assigned to more than one group. Each category can have only one group.
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

export function KnowledgeClassificationSettings({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, isError } = useClassificationSettings(open);
  const [groups, setGroups] = useState<ClassificationGroupSettings[]>(
    normalizeClassificationSettings(defaultClassificationSettings).groups,
  );
  const [categoryInputs, setCategoryInputs] = useState<CategoryInputs>(() =>
    categoryInputsFor(normalizeClassificationSettings(defaultClassificationSettings).groups),
  );
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const updateSettings = useUpdateKnowledgeClassificationSettings();

  useEffect(() => {
    if (!open || !data) return;
    const normalized = normalizeClassificationSettings(data);
    setGroups(normalized.groups);
    setCategoryInputs(categoryInputsFor(normalized.groups));
    setUpdatedAt(data.updatedAt ?? null);
    setSaveError(null);
  }, [data, open]);

  const duplicateCategory = useMemo(() => {
    const seen = new Set<string>();
    for (const group of groups) {
      const rawCategories = categoryInputs[group.id] ?? group.categories.join(", ");
      for (const category of parseCategoryInput(rawCategories)) {
        const normalized = category.trim().toLocaleLowerCase();
        if (!normalized) continue;
        if (seen.has(normalized)) return category.trim();
        seen.add(normalized);
      }
    }
    return null;
  }, [categoryInputs, groups]);

  const save = async () => {
    if (duplicateCategory) {
      setSaveError(`Each category can have only one group. Resolve “${duplicateCategory}” before saving.`);
      return;
    }

    setSaveError(null);
    const payload = {
      groups: groups.map((group) => ({
        id: group.id,
        label: KNOWLEDGE_GROUPS.find((fixed) => fixed.id === group.id)?.label ?? group.label,
        rules: group.rules.split(/\r?\n/).map((rule) => rule.trim()).filter(Boolean),
        categories: parseCategoryInput(categoryInputs[group.id] ?? ""),
      })),
      updatedAt,
    };
    if (payload.groups.some((group) => group.rules.length === 0)) {
      setSaveError("Each group needs at least one rule. Add guidance or restore its starter rule.");
      return;
    }

    try {
      const next = await updateSettings.mutateAsync({ data: payload });
      const normalized = normalizeClassificationSettings(next);
      setGroups(normalized.groups);
      setCategoryInputs(categoryInputsFor(normalized.groups));
      setUpdatedAt(normalized.updatedAt);
      queryClient.setQueryData(classificationSettingsQueryKey, next);
      await queryClient.invalidateQueries({ queryKey: classificationSettingsQueryKey });
      await queryClient.invalidateQueries({ queryKey: ["/api/knowledge/entries"], exact: false });
      toast({
        title: "Classification settings saved",
        description: "Mappings apply to new imports and entries only; existing entries were not changed.",
      });
    } catch (error) {
      setSaveError(errorMessage(error));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto border-slate-800 bg-slate-950 p-4 text-slate-100 sm:p-5">
        <DialogHeader className="pr-7">
          <DialogTitle className="flex items-center gap-2 text-base text-white">
            <Settings2 size={17} className="text-[#10b981]" aria-hidden="true" />
            Knowledge classification settings
          </DialogTitle>
          <DialogDescription className="text-left text-xs leading-relaxed text-slate-400">
            Configure guidance and topic defaults for the three immutable usage groups. Mappings choose defaults for
            new imports and entries only — they are not retroactive. Uncategorized topics remain Internal Operational
            Knowledge.
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-slate-400" role="status">
            <Loader2 size={15} className="animate-spin text-[#10b981]" aria-hidden="true" />
            Loading classification settings…
          </div>
        )}
        {isError && !data && (
          <div className="flex items-start gap-2 rounded-md border border-amber-800/50 bg-amber-950/20 px-3 py-2.5 text-xs leading-relaxed text-amber-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>Saved settings could not be loaded. Defaults are shown; saving will retry the server request.</span>
          </div>
        )}

        <ClassificationSettingsForm
          groups={groups}
          setGroups={setGroups}
          categoryInputs={categoryInputs}
          setCategoryInputs={setCategoryInputs}
          duplicateCategory={duplicateCategory}
        />

        <div className="rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
          A category may belong to only one group. Changing these mappings does not reclassify existing knowledge
          entries; review each entry explicitly when needed.
        </div>
        {saveError && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-red-900/60 bg-red-950/25 px-3 py-2.5 text-xs leading-relaxed text-red-200">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{saveError}</span>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className={ghostButton}
            onClick={() => onOpenChange(false)}
            disabled={updateSettings.isPending}
          >
            Cancel
          </button>
          <button
            type="button"
            className={primaryButton}
            onClick={() => void save()}
            disabled={updateSettings.isPending || isLoading}
          >
            {updateSettings.isPending ? (
              <Loader2 size={13} className="animate-spin" aria-hidden="true" />
            ) : (
              <Save size={13} aria-hidden="true" />
            )}
            {updateSettings.isPending ? "Saving…" : "Save settings"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
