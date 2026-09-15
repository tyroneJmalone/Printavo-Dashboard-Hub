import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { appSettingsTable, db } from "@workspace/db";

/**
 * Knowledge groups are a fixed product boundary. The ids and labels are not
 * configuration: only the editorial rules and category defaults are editable.
 */
export const KNOWLEDGE_GROUP_IDS = [
  "customer_shareable",
  "internal_operational",
  "brand_voice",
] as const;

export type KnowledgeGroupId = (typeof KNOWLEDGE_GROUP_IDS)[number];

export const KNOWLEDGE_GROUP_LABELS: Readonly<Record<KnowledgeGroupId, string>> = {
  customer_shareable: "Customer-Shareable",
  internal_operational: "Internal Operational Knowledge",
  brand_voice: "Brand/Voice Guidance",
};

export const INTERNAL_KNOWLEDGE_GROUP: KnowledgeGroupId = "internal_operational";
export const KNOWLEDGE_CLASSIFICATION_SETTINGS_KEY = "knowledge_classification";
const DEFAULT_CATEGORIES = ["general", "policy", "pricing", "production", "shipping", "faq"];

/**
 * These rules are deliberately explicit and safe by default. They are
 * guidance for consumers, not source breadcrumbs and never become entry text.
 */
export const DEFAULT_KNOWLEDGE_GROUP_RULES: Readonly<
  Record<KnowledgeGroupId, readonly string[]>
> = {
  customer_shareable: [
    "Customer facts may be quoted when approved; preserve every qualification and exception.",
  ],
  internal_operational: [
    "Internal operational knowledge is never customer-facing.",
  ],
  brand_voice: [
    "Brand voice controls tone only; it is never evidence for a factual answer.",
  ],
};

export type KnowledgeClassificationGroup = {
  id: KnowledgeGroupId;
  label: string;
  rules: string[];
  categories: string[];
};

export type KnowledgeClassificationSettings = {
  groups: KnowledgeClassificationGroup[];
  updatedAt: string | null;
};

export const KNOWLEDGE_CLASSIFICATION_SETTINGS_DEFAULT: KnowledgeClassificationSettings = {
  groups: KNOWLEDGE_GROUP_IDS.map((id) => ({
    id,
    label: KNOWLEDGE_GROUP_LABELS[id],
    rules: [...DEFAULT_KNOWLEDGE_GROUP_RULES[id]],
    categories: id === INTERNAL_KNOWLEDGE_GROUP ? [...DEFAULT_CATEGORIES] : [],
  })),
  updatedAt: null,
};

export const knowledgeGroupSchema = z.enum(KNOWLEDGE_GROUP_IDS);

const classificationGroupInputSchema = z.object({
  id: knowledgeGroupSchema,
  label: z.string().trim().min(1).max(100),
  rules: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  categories: z.array(z.string().trim().min(1).max(50)).max(100),
});

export const knowledgeClassificationGroupsSchema = z
  .array(classificationGroupInputSchema)
  .length(KNOWLEDGE_GROUP_IDS.length);

export const knowledgeClassificationSettingsInputSchema = z.object({
  groups: knowledgeClassificationGroupsSchema,
  updatedAt: z.string().datetime({ offset: true }).nullable(),
});

const storedSettingsSchema = z.object({
  groups: knowledgeClassificationGroupsSchema,
});

export class KnowledgeClassificationValidationError extends Error {
  readonly code = "invalid_classification_settings";

  constructor(message: string) {
    super(message);
    this.name = "KnowledgeClassificationValidationError";
  }
}

function canonicalizeGroups(
  groups: Array<{
    id: KnowledgeGroupId;
    label: string;
    rules: string[];
    categories: string[];
  }>,
): KnowledgeClassificationGroup[] {
  if (groups.length !== KNOWLEDGE_GROUP_IDS.length) {
    throw new KnowledgeClassificationValidationError(
      "Knowledge classification settings must contain exactly three groups",
    );
  }

  const ids = new Set(groups.map((group) => group.id));
  if (
    ids.size !== KNOWLEDGE_GROUP_IDS.length ||
    KNOWLEDGE_GROUP_IDS.some((id) => !ids.has(id))
  ) {
    throw new KnowledgeClassificationValidationError(
      "Knowledge classification group ids are immutable and must contain exactly one of each group",
    );
  }

  const categories = new Set<string>();
  for (const group of groups) {
    if (group.label !== KNOWLEDGE_GROUP_LABELS[group.id]) {
      throw new KnowledgeClassificationValidationError(
        `Knowledge classification label for ${group.id} is immutable`,
      );
    }
    for (const category of group.categories) {
      const normalized = category.trim();
      if (!normalized) {
        throw new KnowledgeClassificationValidationError(
          "Knowledge classification categories cannot be empty",
        );
      }
      const categoryKey = normalized.toLocaleLowerCase();
      if (categories.has(categoryKey)) {
        throw new KnowledgeClassificationValidationError(
          `Knowledge classification category "${normalized}" is mapped more than once`,
        );
      }
      categories.add(categoryKey);
    }
  }

  return KNOWLEDGE_GROUP_IDS.map((id) => {
    const group = groups.find((candidate) => candidate.id === id)!;
    return {
      id,
      label: KNOWLEDGE_GROUP_LABELS[id],
      rules: group.rules.map((rule) => rule.trim()),
      categories: Array.from(new Set(group.categories.map((category) => category.trim()))),
    };
  });
}

/**
 * Validate and normalize a proposed editable settings payload. Group ids and
 * labels remain server-owned; categories are globally unique across groups.
 */
export function validateKnowledgeClassificationSettings(
  input: unknown,
): { groups: KnowledgeClassificationGroup[]; updatedAt: string | null } {
  const parsed = knowledgeClassificationSettingsInputSchema.parse(input);
  return {
    groups: canonicalizeGroups(parsed.groups),
    updatedAt: parsed.updatedAt,
  };
}

function settingsFromStoredValue(value: unknown): KnowledgeClassificationGroup[] {
  const parsed = storedSettingsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("Stored knowledge classification settings are invalid");
  }
  return canonicalizeGroups(parsed.data.groups);
}

/**
 * Read the current editable classification policy. No row means the safe
 * defaults: all existing common categories remain internal operational.
 */
export async function getKnowledgeClassificationSettings(): Promise<KnowledgeClassificationSettings> {
  const [row] = await db
    .select()
    .from(appSettingsTable)
    .where(eq(appSettingsTable.key, KNOWLEDGE_CLASSIFICATION_SETTINGS_KEY))
    .limit(1);

  if (!row) {
    return {
      groups: KNOWLEDGE_CLASSIFICATION_SETTINGS_DEFAULT.groups.map((group) => ({
        ...group,
        rules: [...group.rules],
        categories: [...group.categories],
      })),
      updatedAt: null,
    };
  }

  return {
    groups: settingsFromStoredValue(row.value),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Return the fixed metadata for one usage group. */
export function getKnowledgeGroup(groupId: KnowledgeGroupId): KnowledgeClassificationGroup {
  return getKnowledgeClassificationGroup(groupId);
}

/** Return one group from a supplied (or default) policy snapshot. */
export function getKnowledgeClassificationGroup(
  groupId: KnowledgeGroupId,
  settings: KnowledgeClassificationSettings = KNOWLEDGE_CLASSIFICATION_SETTINGS_DEFAULT,
): KnowledgeClassificationGroup {
  const defaults = settings.groups.find(
    (group) => group.id === groupId,
  )!;
  if (!defaults) throw new Error(`Unknown knowledge group: ${groupId}`);
  return {
    ...defaults,
    rules: [...defaults.rules],
    categories: [...defaults.categories],
  };
}

/** Read one group from the persisted editable policy for a consumer. */
export async function getConfiguredKnowledgeGroup(
  groupId: KnowledgeGroupId,
): Promise<KnowledgeClassificationGroup> {
  return getKnowledgeClassificationGroup(groupId, await getKnowledgeClassificationSettings());
}

/** Return the editable rules for one usage group. */
export function getKnowledgeGroupRules(
  groupId: KnowledgeGroupId,
  settings: KnowledgeClassificationSettings = KNOWLEDGE_CLASSIFICATION_SETTINGS_DEFAULT,
): string[] {
  const group = settings.groups.find((candidate) => candidate.id === groupId);
  if (!group) throw new Error(`Unknown knowledge group: ${groupId}`);
  return [...group.rules];
}

/**
 * Resolve a future entry/import default from its category. This is only a
 * defaulting helper: callers must use an explicit entry group when supplied.
 */
export function defaultKnowledgeGroupForCategory(
  category: string | null | undefined,
  settings: KnowledgeClassificationSettings = KNOWLEDGE_CLASSIFICATION_SETTINGS_DEFAULT,
): KnowledgeGroupId {
  const normalized = category?.trim();
  if (normalized) {
    const group = settings.groups.find((candidate) =>
      candidate.categories.some(
        (category) => category.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
      ),
    );
    if (group) return group.id;
  }
  return INTERNAL_KNOWLEDGE_GROUP;
}

/** True when a value is one of the three fixed usage groups. */
export function isKnowledgeGroupId(value: unknown): value is KnowledgeGroupId {
  return typeof value === "string" && (KNOWLEDGE_GROUP_IDS as readonly string[]).includes(value);
}

/**
 * Save an editable policy with optimistic stale protection. The caller must
 * provide the value it observed from GET (null for the initial defaults).
 */
export async function updateKnowledgeClassificationSettings(
  groups: unknown,
  expectedUpdatedAt: string | null,
): Promise<KnowledgeClassificationSettings> {
  const normalized = validateKnowledgeClassificationSettings({
    groups,
    updatedAt: expectedUpdatedAt,
  });
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(appSettingsTable)
      .where(eq(appSettingsTable.key, KNOWLEDGE_CLASSIFICATION_SETTINGS_KEY))
      .for("update");

    if (existing && existing.updatedAt.toISOString() !== expectedUpdatedAt) {
      throw new KnowledgeClassificationStaleError();
    }
    if (!existing && expectedUpdatedAt !== null) {
      throw new KnowledgeClassificationStaleError();
    }

    const value = { groups: normalized.groups };
    if (existing) {
      const [updated] = await tx
        .update(appSettingsTable)
        .set({ value, updatedAt: new Date() })
        .where(
          and(
            eq(appSettingsTable.key, KNOWLEDGE_CLASSIFICATION_SETTINGS_KEY),
            eq(appSettingsTable.updatedAt, existing.updatedAt),
          ),
        )
        .returning();
      if (!updated) throw new KnowledgeClassificationStaleError();
      return updated;
    }

    const [created] = await tx
      .insert(appSettingsTable)
      .values({ key: KNOWLEDGE_CLASSIFICATION_SETTINGS_KEY, value })
      .returning();
    if (!created) throw new Error("Knowledge classification settings could not be saved");
    return created;
  });

  return {
    groups: settingsFromStoredValue(result.value),
    updatedAt: result.updatedAt.toISOString(),
  };
}

export class KnowledgeClassificationStaleError extends Error {
  readonly code = "stale_classification_settings";

  constructor() {
    super("Knowledge classification settings changed; refresh and try again.");
    this.name = "KnowledgeClassificationStaleError";
  }
}