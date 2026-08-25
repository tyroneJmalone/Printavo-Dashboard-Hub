import { openai } from "@workspace/integrations-openai-ai-server";
import { z } from "zod/v4";
import { listDecorationMatrices } from "../pricing/matrices";
import { productSearch } from "../purchasing/productFinder";
import { automaticMatrixColumnIndex } from "../quoteDrafts/embroideryStitchTiers";
import {
  resolveStandardSizeGarmentPricing,
  type PricingGarmentMatch,
} from "./pricingProductResolver";

const MODEL = "gpt-5.6-terra";
const CALL_TIMEOUT_MS = 30_000;
const DEFAULT_MARKUP = 1.75;

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
        location: z.string().max(100).nullable(),
        method: z.string().max(100).nullable(),
        colorCount: z.number().int().min(1).max(20).nullable(),
        details: z.string().max(500).nullable(),
      }),
    )
    .max(20),
  uncertainties: z
    .array(z.string().max(500).nullable())
    .max(20)
    .transform((items) => items.filter((item): item is string => item !== null)),
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
- explicitMarkup: only if explicitly stated. Convert % to multiplier (175% → 1.75). If absent, leave null; the calculator automatically uses 1.75×.
- Normalize sizes: XS, S, M, L, XL, 2XL, 3XL, etc.
- Sizes are optional for this calculator. Do not add an uncertainty when sizes are absent; vendor cost uses regular sizes XS–XL automatically.
- Do not add an uncertainty when markup is absent; the calculator applies its automatic markup.
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
  return parseExtractedCalcResponse(parsed);
}

export function parseExtractedCalcResponse(parsed: unknown): ExtractedCalc {
  const validated = ExtractedCalcSchema.safeParse(parsed);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const path = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new PricingInterpretError(
      `AI response did not match schema${path}: ${issue?.message ?? "invalid"}`,
    );
  }
  return validated.data;
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
  const method = decoration.method?.toLowerCase() ?? "";
  if (!method) return null;
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

  const columnIndex = automaticMatrixColumnIndex(
    {
      method: decoration.method ?? "",
      colorCount: decoration.colorCount,
      details: decoration.details,
    },
    matrix.data.xValues,
  );
  if (columnIndex === null) return null;

  const column = matrix.data.xValues[columnIndex];
  if (!column) return null;

  return { matrixId: matrix.id, columnIndex, label: column.label };
}

// ── Public interpreter ───────────────────────────────────────────────────

export interface PricingInterpretResult {
  quoteNumber: string | null;
  garmentCost: number | null;
  garmentMatch: PricingGarmentMatch | null;
  markup: number;
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

  const warnings: string[] = extracted.uncertainties.filter(
    (warning) => !/\b(markup|sizes?)\b/i.test(warning),
  );
  let garmentCost: number | null = null;
  let garmentMatch: PricingGarmentMatch | null = null;

  // Use explicit cost if stated; otherwise resolve live XS–XL vendor pricing.
  if (extracted.explicitGarmentCostPerPiece !== null) {
    garmentCost = extracted.explicitGarmentCostPerPiece;
  } else if (!extracted.garmentStyle) {
    warnings.push("No garment style in prompt.");
  } else {
    try {
      const search = await productSearch(extracted.garmentStyle);
      const vendorResult = resolveStandardSizeGarmentPricing(
        search,
        extracted.garmentStyle,
        extracted.garmentColor,
      );
      if (vendorResult.resolved) {
        garmentCost = vendorResult.cost;
        garmentMatch = vendorResult.match;
        warnings.push(...vendorResult.warnings);
      } else {
        warnings.push(vendorResult.warning);
      }
    } catch {
      warnings.push(
        `Could not look up style "${extracted.garmentStyle}": vendor error.`,
      );
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
        const location = decoration.location || "Unspecified location";
        const method = decoration.method || "unspecified method";
        warnings.push(
          `Decoration "${location} / ${method}": could not match to a pricing matrix column.`,
        );
        return [];
      }
      return [fill];
    });

  return {
    quoteNumber: extracted.quoteNumber,
    garmentCost,
    garmentMatch,
    markup: extracted.explicitMarkup ?? DEFAULT_MARKUP,
    decorations,
    warnings,
  };
}
