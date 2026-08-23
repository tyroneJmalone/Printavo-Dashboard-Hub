import { openai } from "@workspace/integrations-openai-ai-server";
import { z } from "zod/v4";
import { listDecorationMatrices } from "../pricing/matrices";
import { productSearch } from "../purchasing/productFinder";
import { automaticMatrixColumnIndex } from "../quoteDrafts/embroideryStitchTiers";

const MODEL = "gpt-5.6-terra";
const CALL_TIMEOUT_MS = 30_000;

// ── Extraction schema ───────────────────────────────────────────────────

const ExtractedCalcSchema = z.object({
  quoteNumber: z.string().max(50).nullable(),
  garmentStyle: z.string().max(100).nullable(),
  garmentColor: z.string().max(100).nullable(),
  explicitGarmentCostPerPiece: z.number().positive().nullable(),
  explicitMarkup: z.number().positive().nullable(),
  sizes: z
    .array(z.object({ size: z.string().max(20), quantity: z.number().int().min(1) }))
    .max(30),
  decorations: z
    .array(
      z.object({
        location: z.string().max(100),
        method: z.string().max(100),
        colorCount: z.number().int().min(1).max(20).nullable(),
        details: z.string().max(500).nullable(),
      }),
    )
    .max(20),
  uncertainties: z.array(z.string().max(500)).max(20),
});

type ExtractedCalc = z.infer<typeof ExtractedCalcSchema>;

export class PricingInterpretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingInterpretError";
  }
}

// ── AI extraction ────────────────────────────────────────────────────────

async function extractCalcFacts(prompt: string): Promise<ExtractedCalc> {
  const response = await openai.chat.completions.create(
    {
      model: MODEL,
      max_completion_tokens: 4_096,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You extract pricing calculator facts for an apparel screen-printing shop.

Return ONLY a JSON object:
{
  "quoteNumber": "Printavo quote number if any (digits, strip # prefix), or null",
  "garmentStyle": "vendor style code or null",
  "garmentColor": "color name or null",
  "explicitGarmentCostPerPiece": number or null,
  "explicitMarkup": markup multiplier (e.g. 1.75 for 75%) or null,
  "sizes": [{"size": "M", "quantity": 12}],
  "decorations": [{"location": "Front", "method": "Screen print", "colorCount": 2, "details": null}],
  "uncertainties": []
}

Rules:
- Extract only what is explicitly stated. Never invent costs, quantities, or styles.
- quoteNumber: digits only if stated (strip # prefix). null if not mentioned.
- explicitGarmentCostPerPiece: only if explicitly stated per-piece garment cost.
- explicitMarkup: only if explicitly stated. Convert % to multiplier (175% → 1.75).
- Normalize sizes: XS, S, M, L, XL, 2XL, 3XL, etc.
- For embroidery, preserve stitch counts in decoration details.
- If a fact is ambiguous or missing, set it null and add to uncertainties.
- Include ALL decorations mentioned, even beyond 4.`,
        },
        { role: "user", content: prompt },
      ],
    },
    { timeout: CALL_TIMEOUT_MS },
  );

  const content = response.choices[0]?.message?.content;
  if (!content) throw new PricingInterpretError("AI returned an empty response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new PricingInterpretError("AI returned invalid JSON");
  }
  const validated = ExtractedCalcSchema.safeParse(parsed);
  if (!validated.success) {
    throw new PricingInterpretError(
      `AI response did not match schema: ${validated.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return validated.data;
}

// ── Product verification (exact only) ───────────────────────────────────

function sameText(a: string, b: string): boolean {
  return (
    a.trim().toLowerCase().replace(/[^a-z0-9]/g, "") ===
    b.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
  );
}

/**
 * Attempt an exact vendor product lookup against all vendors.
 *
 * Rules:
 * - If more than one vendor returns an exact match → ambiguous, fail closed.
 * - If no sizes supplied → cannot resolve cost (no silent max-of-all).
 * - All requested sizes must have exact cost data; any missing → fail closed.
 * - Uses the max cost across requested sizes (conservative).
 */
async function exactGarmentCost(
  style: string | null,
  color: string | null,
  requestedSizes: Array<{ size: string; quantity: number }>,
): Promise<{ resolved: true; cost: number } | { resolved: false; warning: string }> {
  if (!style) return { resolved: false, warning: "No garment style in prompt." };

  let searchResult: Awaited<ReturnType<typeof productSearch>>;
  try {
    searchResult = await productSearch(style);
  } catch {
    return { resolved: false, warning: `Could not look up style "${style}": vendor error.` };
  }

  // Collect all exact-match vendor results
  const exactVendors = searchResult.vendors.filter(
    (v) => v.lookup.found && v.lookup.matchType === "exact",
  );

  if (exactVendors.length === 0) {
    return {
      resolved: false,
      warning: `Style "${style}" was not found exactly in any vendor catalog — garment cost not resolved.`,
    };
  }
  if (exactVendors.length > 1) {
    const names = exactVendors.map((v) => v.lookup.vendor).join(", ");
    return {
      resolved: false,
      warning: `Style "${style}" matched exactly in multiple vendors (${names}) — ambiguous, cost not resolved.`,
    };
  }

  const exactVendor = exactVendors[0]!;

  if (!color) {
    return {
      resolved: false,
      warning: `Style "${style}" found but no color specified — garment cost not resolved.`,
    };
  }

  const matchedColor = exactVendor.lookup.colors.find((c) =>
    sameText(c.colorName, color),
  );
  if (!matchedColor) {
    return {
      resolved: false,
      warning: `Color "${color}" not found for style "${style}" (vendor: ${exactVendor.lookup.vendor}).`,
    };
  }

  // Require explicit sizes
  if (requestedSizes.length === 0) {
    return {
      resolved: false,
      warning: `No sizes specified for style "${style}" — cannot resolve garment cost without explicit sizes.`,
    };
  }

  // All requested sizes must have cost data
  const costs: number[] = [];
  for (const req of requestedSizes) {
    const offer = matchedColor.sizes.find((s) => sameText(s.size, req.size));
    const cost = offer ? (offer.salePrice ?? offer.cost) : null;
    if (cost === null) {
      return {
        resolved: false,
        warning: `Size "${req.size}" has no cost data for style "${style}" / color "${color}".`,
      };
    }
    costs.push(cost);
  }

  return { resolved: true, cost: Math.max(...costs) };
}

// ── Matrix matching ──────────────────────────────────────────────────────

export interface DecorationFill {
  matrixId: string;
  columnIndex: number;
  label: string;
}

function matchDecoration(
  decoration: ExtractedCalc["decorations"][0],
  index: number,
  matrices: Awaited<ReturnType<typeof listDecorationMatrices>>,
): DecorationFill | null {
  const method = decoration.method.toLowerCase();
  let matrix: (typeof matrices)[0] | null = null;

  if (method.includes("screen") || method.includes("print")) {
    const target = index === 0 ? "1stprintloc" : "addnlprintloc";
    matrix =
      matrices.find((m) =>
        m.name.toLowerCase().replace(/\s+/g, "").includes(target),
      ) ?? null;
  } else if (method.includes("embro")) {
    matrix =
      matrices.find((m) => m.name.toLowerCase().includes("embro")) ?? null;
  }

  if (!matrix) return null;

  const columnIndex = automaticMatrixColumnIndex(decoration, matrix.data.xValues);
  if (columnIndex === null) return null;

  const column = matrix.data.xValues[columnIndex];
  if (!column) return null;

  return { matrixId: matrix.id, columnIndex, label: column.label };
}

// ── Public interpreter ───────────────────────────────────────────────────

export interface PricingInterpretResult {
  quoteNumber: string | null;
  garmentCost: number | null;
  markup: number | null;
  decorations: DecorationFill[];
  warnings: string[];
}

const MAX_DECORATIONS = 4;

export async function interpretPricingPrompt(
  prompt: string,
): Promise<PricingInterpretResult> {
  const [extracted, matrices] = await Promise.all([
    extractCalcFacts(prompt),
    listDecorationMatrices(),
  ]);

  const warnings: string[] = [...extracted.uncertainties];
  let garmentCost: number | null = null;

  // Use explicit cost if stated; otherwise attempt exact vendor lookup
  if (extracted.explicitGarmentCostPerPiece !== null) {
    garmentCost = extracted.explicitGarmentCostPerPiece;
  } else {
    const vendorResult = await exactGarmentCost(
      extracted.garmentStyle,
      extracted.garmentColor,
      extracted.sizes,
    );
    if (vendorResult.resolved) {
      garmentCost = vendorResult.cost;
    } else {
      warnings.push(vendorResult.warning);
    }
  }

  // Warn if more than MAX_DECORATIONS decorations are present (omitted ones)
  if (extracted.decorations.length > MAX_DECORATIONS) {
    const omitted = extracted.decorations.length - MAX_DECORATIONS;
    warnings.push(
      `${omitted} decoration(s) beyond the first ${MAX_DECORATIONS} were not mapped — review manually.`,
    );
  }

  // Match up to MAX_DECORATIONS decorations to matrices
  const decorations: DecorationFill[] = extracted.decorations
    .slice(0, MAX_DECORATIONS)
    .flatMap((decoration, index) => {
      const fill = matchDecoration(decoration, index, matrices);
      if (!fill) {
        warnings.push(
          `Decoration "${decoration.location} / ${decoration.method}": could not match to a pricing matrix column.`,
        );
        return [];
      }
      return [fill];
    });

  return {
    quoteNumber: extracted.quoteNumber,
    garmentCost,
    markup: extracted.explicitMarkup,
    decorations,
    warnings,
  };
}
