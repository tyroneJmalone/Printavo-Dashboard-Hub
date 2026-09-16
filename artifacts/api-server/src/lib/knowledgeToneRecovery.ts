import { openai } from "@workspace/integrations-openai-ai-server";
import { z } from "zod";
import {
  chunkExtractedText,
  draftSourceSectionKey,
  isMeaningfulFragment,
  isMeaningfulDraftFragment,
  normalizeDraftTitle,
  toneRecoveryTopicSourceKey,
  semanticBatches,
  validateCandidateSourceIndexes,
  validateSemanticDraftCoverage,
  type KnowledgeSourceSection,
} from "./knowledgeSourceImport";

export const KNOWLEDGE_IMPORT_AI_MODEL = "gpt-5.6-terra";
export const KNOWLEDGE_IMPORT_AI_TIMEOUT_MS = 30_000;
export const MAX_TONE_RECOVERY_TEXT_CHARS = 120_000;
export const MAX_TONE_RECOVERY_CANDIDATES = 100;
export const MAX_TONE_BODY_CHARS = 2_000;

/**
 * candidateType is intentionally not a usage-group selector. `fact` uses the
 * existing category default policy and `tone` is the only value that the
 * source importer may map to brand_voice.
 */
export const DraftCandidateSchema = z.object({
  sourceIndexes: z.array(z.number().int().nonnegative()).min(1).max(200),
  // Titles are editorial metadata. The source section title is used when the
  // model returns an unusably short title.
  title: z.string().trim().max(1000),
  body: z.string().trim().min(1).max(6000),
  category: z.enum(["general", "policy", "pricing", "production", "shipping", "faq"]),
  tags: z.array(z.string().trim().min(1).max(40)).max(8),
  effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  expiresDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  candidateType: z.enum(["fact", "tone"]).default("fact"),
  dateBound: z.boolean().default(false),
  dateNote: z.string().trim().max(500).nullable().default(null),
});

export type DraftCandidate = z.infer<typeof DraftCandidateSchema>;

export type ToneRecoveryPreview = {
  chunks: KnowledgeSourceSection[];
  candidates: DraftCandidate[];
  excludedDateBound: DraftCandidate[];
};

const FACT_AND_TONE_INSTRUCTIONS = [
  "Extract reviewable company-knowledge draft candidates from the complete source window.",
  "Return the smallest coherent set of candidates, never one draft per visual line.",
  "Every factual source window must be covered by at least one candidate in normal import mode.",
  "A candidate may cite multiple source indexes and an index may be reused by multiple candidates.",
  "Never invent, infer, or weaken a fact, qualifier, exception, threshold, date, or only/except/unless rule.",
  "Never turn an illustrative example price, turnaround, timeline, slogan, or promise into a factual policy.",
  "Use candidateType=fact only for explicit company facts, policies, procedures, pricing, shipping, production, or FAQ content.",
  "Use candidateType=tone only for explicit writing guidance: tone adjectives, voice traits, preferred vocabulary, avoided words, and paired say-this/not-that examples.",
  "Tone candidates must preserve preferred terms and avoided terms verbatim where supplied, and must keep each say-this/not-that pair together and faithful to the source.",
  "A tone candidate is wording guidance only. If a tone example mentions a price, deadline, turnaround, or promise, keep it inside the tone candidate as clearly labeled example language and never create a factual candidate from it.",
  "Do not choose a knowledge group. Facts use the existing category-default policy; only explicit tone candidates are eligible for brand_voice.",
  "For explicit exact YYYY-MM-DD applicability dates, preserve effectiveDate/expiresDate. For seasonal, anniversary, or month-only language without exact dates, set dateBound=true and dateNote to the source wording; do not make it evergreen.",
  "Keep each tone body compact (at most 1,800 characters) while preserving every preferred/avoided term and paired example; do not silently truncate.",
  "All results remain human-reviewed drafts, never approvals or customer-facing conclusions.",
].join(" ");

const TONE_ONLY_INSTRUCTIONS = [
  "Extract only explicit writing and brand-voice guidance from the supplied source windows.",
  "Return no candidate for a window that has no explicit tone, terminology, preferred/avoided vocabulary, or paired say-this/not-that guidance.",
  "Use candidateType=tone for every returned candidate; never return facts.",
  "Preserve preferred terms and avoided terms verbatim where supplied, and keep every say-this/not-that pair together and faithful to the source.",
  "Never turn example prices, turnaround times, timelines, deadlines, or promises into facts. If such language appears inside a voice example, preserve it only as clearly labeled example language in the tone body.",
  "Do not paraphrase away qualifiers or pair relationships. Tone is wording guidance only and never evidence for a factual answer.",
  "For exact YYYY-MM-DD applicability dates, preserve effectiveDate/expiresDate. For seasonal, anniversary, or month-only language without exact dates, set dateBound=true and dateNote to the source wording; such a candidate will be flagged instead of imported as evergreen.",
  "Keep each tone body compact (at most 1,800 characters) while preserving every preferred/avoided term and paired example; do not silently truncate.",
  "All results are new human-review drafts; never approvals.",
].join(" ");

function candidateExtractionPrompt(toneOnly: boolean): string {
  const mode = toneOnly
    ? "This is a tone/lexicon recovery preview. It is valid for the drafts array to be empty."
    : "This is a normal import. Do not leave a meaningful factual source window uncovered.";
  return `${toneOnly ? TONE_ONLY_INSTRUCTIONS : FACT_AND_TONE_INSTRUCTIONS} ${mode} Return JSON only in the form {"drafts":[{"sourceIndexes":[0],"title":"...","body":"...","category":"general","tags":[],"effectiveDate":null,"expiresDate":null,"candidateType":"fact","dateBound":false,"dateNote":null}]}. sourceIndexes refer only to the supplied excerpts.`;
}

function meaningfulDraftBody(value: string): boolean {
  return isMeaningfulDraftFragment(value);
}

function labelToneExampleLanguage(value: string): string {
  const mentionsPromiseLikeLanguage =
    /\b(?:turnaround|deadline|price|pricing|cost|promise|guarantee|refund)\b|\$\s?\d|\b\d+\s*(?:-|–|—|to)\s*\d+\s*(?:business\s+)?(?:day|days|week|weeks)\b/i.test(
      value,
    );
  if (
    !mentionsPromiseLikeLanguage ||
    /\b(?:example|illustrative|wording only|not a factual|not a promise|not policy)\b/i.test(value)
  ) {
    return value;
  }
  return `Example wording only (not a factual policy or promise): ${value}`;
}

/**
 * AI-only enrichment. No database or source-row side effects occur here,
 * making this safe for both upload imports and the non-persisting recovery
 * preview.
 */
export async function enrichKnowledgeDrafts(
  chunks: Array<{ title: string; body: string }>,
  sourceName: string,
  options: { toneOnly?: boolean } = {},
): Promise<DraftCandidate[]> {
  const toneOnly = options.toneOnly === true;
  const enriched: DraftCandidate[] = [];
  let offset = 0;

  for (const batch of semanticBatches(chunks)) {
    const batchOffset = offset;
    offset += batch.length;
    const expectedIndexes = new Set(batch.map((_, index) => batchOffset + index));
    const completion = await openai.chat.completions.create(
      {
        model: KNOWLEDGE_IMPORT_AI_MODEL,
        messages: [
          { role: "system", content: candidateExtractionPrompt(toneOnly) },
          {
            role: "user",
            content: JSON.stringify({
              sourceName,
              excerpts: batch.map((chunk, index) => ({
                index: batchOffset + index,
                heading: chunk.title,
                text: chunk.body,
              })),
            }),
          },
        ],
        response_format: { type: "json_object" },
        max_completion_tokens: toneOnly ? 8_000 : 8_192,
      },
      { timeout: KNOWLEDGE_IMPORT_AI_TIMEOUT_MS },
    );

    const raw = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as {
      drafts?: unknown;
    };
    const parsed = z.array(DraftCandidateSchema).safeParse(raw.drafts ?? []);
    if (!parsed.success) {
      throw new Error(`AI draft extraction returned invalid data: ${parsed.error.message}`);
    }

    const candidates = toneOnly
      ? parsed.data.filter((candidate) => candidate.candidateType === "tone")
      : parsed.data;
    if (!toneOnly && !candidates.length) {
      throw new Error("AI draft extraction returned no factual or tone candidates");
    }
    for (const candidate of candidates) {
      // A single preferred/avoided word is valid tone guidance even though a
      // one-token factual draft would be extraction noise.
      const meaningfulToneLexicon =
        candidate.candidateType === "tone" && isMeaningfulFragment(candidate.body);
      if (!meaningfulDraftBody(candidate.body) && !meaningfulToneLexicon) {
        throw new Error("AI draft extraction returned a meaningless draft body");
      }
      const reviewBody =
        candidate.candidateType === "tone"
          ? labelToneExampleLanguage(candidate.body)
          : candidate.body;
      if (candidate.candidateType === "tone" && reviewBody.length > MAX_TONE_BODY_CHARS) {
        throw new Error(
          `AI tone extraction returned a body over the ${MAX_TONE_BODY_CHARS}-character review limit; no tone text was silently truncated`,
        );
      }
    }
    const normalizedIndexes = validateCandidateSourceIndexes(
      expectedIndexes,
      candidates.map((candidate) => candidate.sourceIndexes),
    );
    if (!toneOnly) {
      validateSemanticDraftCoverage(
        expectedIndexes,
        normalizedIndexes,
      );
    }

    enriched.push(
      ...candidates.map((candidate, candidateIndex) => {
        const indexes = normalizedIndexes[candidateIndex]!;
        const firstIndex = indexes[0]!;
        return {
          ...candidate,
          sourceIndexes: indexes,
          body:
            candidate.candidateType === "tone"
              ? labelToneExampleLanguage(candidate.body)
              : candidate.body,
          title: normalizeDraftTitle(
            candidate.title,
            chunks[firstIndex]?.title ?? "",
            sourceName,
            firstIndex,
          ),
          ...(candidate.candidateType === "tone"
            ? { category: "general" as const }
            : {}),
        };
      }),
    );
  }

  if (toneOnly && enriched.length > MAX_TONE_RECOVERY_CANDIDATES) {
    throw new Error(
      `Tone recovery found more than ${MAX_TONE_RECOVERY_CANDIDATES} candidates; narrow the document and review it in sections.`,
    );
  }
  return enriched;
}

export async function previewToneRecoveryFromText(
  text: string,
  sourceName: string,
): Promise<ToneRecoveryPreview> {
  const normalizedText = text.trim();
  if (!normalizedText) {
    throw new Error("No extracted text is available for tone recovery");
  }
  if (normalizedText.length > MAX_TONE_RECOVERY_TEXT_CHARS) {
    throw new Error(
      `Stored extracted text is too large for one tone recovery preview (${MAX_TONE_RECOVERY_TEXT_CHARS} characters maximum)`,
    );
  }

  const chunks = chunkExtractedText(normalizedText);
  if (!chunks.length) {
    throw new Error("Stored extracted text contains no usable sections for tone recovery");
  }
  const allCandidates = await enrichKnowledgeDrafts(chunks, sourceName, { toneOnly: true });
  const excludedDateBound = allCandidates.filter(
    (candidate) =>
      candidate.dateBound &&
      candidate.candidateType === "tone" &&
      !candidate.effectiveDate &&
      !candidate.expiresDate,
  );
  const candidates = allCandidates.filter((candidate) => !excludedDateBound.includes(candidate));
  return { chunks, candidates, excludedDateBound };
}

export function recoverySourceKeys(
  candidate: Pick<DraftCandidate, "sourceIndexes">,
  chunks: KnowledgeSourceSection[],
): string[] {
  return candidate.sourceIndexes
    .map((index) => chunks[index])
    .filter((section): section is KnowledgeSourceSection => Boolean(section))
    .map((section) => draftSourceSectionKey(section, "tone"));
}

/**
 * Candidate identity is source section hashes plus an ordered topic slot
 * within that exact source-window group. This is the finest stable granularity
 * available when the model cannot name a topic independently of its wording:
 * two topics from one window save as slots 0 and 1, while a later paraphrase
 * in the same slot is deduplicated.
 */
export function recoverySourceKeysForCandidates(
  candidates: Array<Pick<DraftCandidate, "sourceIndexes">>,
  chunks: KnowledgeSourceSection[],
): string[][] {
  const nextSlot = new Map<string, number>();
  return candidates.map((candidate) => {
    const baseKeys = recoverySourceKeys(candidate, chunks).sort();
    const group = baseKeys.join("|");
    const slot = nextSlot.get(group) ?? 0;
    nextSlot.set(group, slot + 1);
    return baseKeys.map((key) => toneRecoveryTopicSourceKey(key, slot));
  });
}