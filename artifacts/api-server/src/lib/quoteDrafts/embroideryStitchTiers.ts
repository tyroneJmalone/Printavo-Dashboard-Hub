type MatrixColumn = { label: string };

type DecorationFacts = {
  method: string;
  colorCount: number | null;
  details: string | null;
};

type StitchRange = {
  low: number;
  high: number;
};

function parseCount(value: string): number | null {
  const normalized = value.replace(/,/g, "").trim();
  const match = /^(\d+(?:\.\d+)?)(k)?$/i.exec(normalized);
  if (!match) return null;
  const count = Number(match[1]) * (match[2] ? 1_000 : 1);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

function parseStitchRange(label: string): StitchRange | null {
  const normalized = label
    .toLowerCase()
    .replace(/stitches?/g, "")
    .replace(/[–—]/g, "-")
    .trim();
  const match = /^(\d+(?:\.\d+)?k?)\s*(?:-|to)\s*(\d+(?:\.\d+)?k?)$/i.exec(
    normalized,
  );
  if (!match) return null;
  const low = parseCount(match[1]);
  const high = parseCount(match[2]);
  if (low === null || high === null || low > high) return null;
  return { low, high };
}

/**
 * Finds the configured embroidery column that contains a stitch count stated
 * in the decoration details. K means thousand: "12K stitches" is 12,000.
 * Returns null for omitted/invalid/ambiguous counts so a person can review it.
 */
export function embroideryStitchTierIndex(
  details: string | null,
  columns: MatrixColumn[],
): number | null {
  if (!details) return null;

  const countToken =
    String.raw`(?:\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?\s*k|\d{1,6})`;
  const rangeOperator =
    String.raw`(?:-|–|—|/|,(?=\s)|;|&|\bto\b|\bthrough\b|\band\b|\bor\b)`;
  const boundQualifier =
    String.raw`(?:up\s+to|under|below|less\s+than|no\s+more\s+than|over|above|more\s+than|at\s+least|at\s+most|about|around|roughly|approximately?|estimated(?:\s+at)?)`;
  const stitchCountRange = new RegExp(
    String.raw`\b(?:between\s+)?${countToken}\s*${rangeOperator}\s*${countToken}\s*(?:stitch(?:es)?|sts?)\b`,
    "i",
  );
  const prefixedStitchCountRange = new RegExp(
    String.raw`\b(?:stitch(?:es)?|stitch\s+count)\s*(?:is|:|=|of|between)?\s*${countToken}\s*${rangeOperator}\s*${countToken}\b`,
    "i",
  );
  const boundedStitchCount = new RegExp(
    String.raw`\b${boundQualifier}\s*${countToken}\s*(?:stitch(?:es)?|sts?)\b`,
    "i",
  );
  const prefixedBoundedStitchCount = new RegExp(
    String.raw`\b(?:stitch(?:es)?|stitch\s+count)\s*(?:is|:|=|of)?\s*${boundQualifier}\s*${countToken}\b`,
    "i",
  );
  const trailingBoundedStitchCount = new RegExp(
    String.raw`\b${countToken}\s*(?:stitch(?:es)?|sts?)\s*(?:or\s+(?:less|fewer|more)|minimum|maximum|min|max)\b`,
    "i",
  );
  const symbolApproximateStitchCount = new RegExp(
    String.raw`~\s*${countToken}\s*(?:stitch(?:es)?|sts?)\b`,
    "i",
  );
  if (
    stitchCountRange.test(details) ||
    prefixedStitchCountRange.test(details) ||
    boundedStitchCount.test(details) ||
    prefixedBoundedStitchCount.test(details) ||
    trailingBoundedStitchCount.test(details) ||
    symbolApproximateStitchCount.test(details)
  ) {
    return null;
  }

  const candidates = new Set<number>();
  for (
    const match of details.matchAll(
      /\b(\d+(?:\.\d+)?)\s*k\s*(?:stitch(?:es)?|sts?)\b/gi,
    )
  ) {
    candidates.add(Number(match[1]) * 1_000);
  }
  for (
    const match of details.matchAll(
      /\b(?:stitch(?:es)?|stitch\s+count)\s*(?:is|:|=|of)?\s*(\d+(?:\.\d+)?)\s*k\b/gi,
    )
  ) {
    candidates.add(Number(match[1]) * 1_000);
  }
  for (
    const match of details.matchAll(
      /\b(\d{1,3}(?:,\d{3})+|\d{1,6})\s*(?:stitch(?:es)?|sts?)\b/gi,
    )
  ) {
    candidates.add(Number(match[1].replace(/,/g, "")));
  }
  for (
    const match of details.matchAll(
      /\b(?:stitch(?:es)?|stitch\s+count)\s*(?:is|:|=|of)?\s*(\d{1,3}(?:,\d{3})+|\d{1,6})\b/gi,
    )
  ) {
    candidates.add(Number(match[1].replace(/,/g, "")));
  }

  if (
    candidates.size !== 1 ||
    [...candidates].some((count) => !Number.isFinite(count) || count < 0)
  ) {
    return null;
  }
  const [stitches] = candidates;

  const ranges = columns.flatMap((column, index) => {
    const range = parseStitchRange(column.label);
    return range ? [{ ...range, index }] : [];
  });

  // Adjacent configured tiers share endpoints (for example, 11K-12K and
  // 12K-13K). At an exact threshold, the tier that starts there wins.
  const exactLowerBounds = ranges.filter((range) => stitches === range.low);
  if (exactLowerBounds.length === 1) return exactLowerBounds[0].index;
  if (exactLowerBounds.length > 1) return null;

  const matchingIndices = ranges
    .filter((range) => stitches >= range.low && stitches <= range.high)
    .map((range) => range.index);
  return matchingIndices.length === 1 ? matchingIndices[0] : null;
}

export function automaticMatrixColumnIndex(
  decoration: DecorationFacts,
  columns: MatrixColumn[],
): number | null {
  if (decoration.method.toLowerCase().includes("embro")) {
    return embroideryStitchTierIndex(decoration.details, columns);
  }
  if (decoration.colorCount === null) return null;
  const target = `${decoration.colorCount}color`;
  const found = columns.findIndex(
    (column) =>
      column.label.toLowerCase().replace(/\s+/g, "") === target,
  );
  return found >= 0 ? found : null;
}