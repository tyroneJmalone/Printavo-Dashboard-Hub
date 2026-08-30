/**
 * Shared citation validator, generalized from the correspondence AI search
 * pattern: an AI answer that cites sources is only trusted when every
 * declared source id is allowed, every inline citation is allowed, and the
 * declared set exactly matches the inline-cited set. Reusable by any Hub AI
 * surface that requires source-grounded answers.
 */
export interface CitationCheckInput {
  /** The AI answer text containing inline [source:ID] citations. */
  answer: string;
  /** Source ids the AI declared it used. */
  declaredIds: string[];
  /** Source ids the caller actually provided to the AI. */
  allowedIds: string[];
  /** Regex with one capture group extracting inline-cited ids. */
  inlinePattern?: RegExp;
}

export interface CitationCheckResult {
  valid: boolean;
  reason?: string;
  /** Normalized union of valid declared + inline-cited ids. */
  citedIds: string[];
}

const DEFAULT_PATTERN = /\[source:([0-9a-f-]{36})\]/gi;

export function validateCitedAnswer(input: CitationCheckInput): CitationCheckResult {
  const answer = input.answer.trim();
  if (!answer) return { valid: false, reason: "empty answer", citedIds: [] };
  const allowed = new Set(input.allowedIds.map((id) => id.toLowerCase()));
  const pattern = new RegExp(
    (input.inlinePattern ?? DEFAULT_PATTERN).source,
    "gi",
  );
  const inline = [...answer.matchAll(pattern)].map((m) => m[1]!.toLowerCase());
  const declared = new Set(input.declaredIds.map((id) => id.toLowerCase()));
  const cited = new Set(inline);
  if (cited.size === 0) return { valid: false, reason: "no inline citations", citedIds: [] };
  if (inline.some((id) => !allowed.has(id))) {
    return { valid: false, reason: "inline citation outside allowed sources", citedIds: [] };
  }
  if ([...declared].some((id) => !allowed.has(id))) {
    return { valid: false, reason: "declared source outside allowed sources", citedIds: [] };
  }
  if (declared.size !== cited.size || [...declared].some((id) => !cited.has(id))) {
    return { valid: false, reason: "declared sources do not match inline citations", citedIds: [] };
  }
  return { valid: true, citedIds: [...new Set([...declared, ...cited])] };
}
