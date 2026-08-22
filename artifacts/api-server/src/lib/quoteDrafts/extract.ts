import { openai } from "@workspace/integrations-openai-ai-server";
import { z } from "zod/v4";

const MODEL = "gpt-5.6-terra";
const CALL_TIMEOUT_MS = 30_000;

const ExtractedQuoteSchema = z.object({
  customerName: z.string().min(1).max(300),
  nickname: z.string().max(300).nullable(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  customerNote: z.string().max(10_000),
  productionNote: z.string().max(10_000),
  garments: z
    .array(
      z.object({
        brand: z.string().max(100).nullable(),
        style: z.string().min(1).max(100),
        description: z.string().max(500).nullable(),
        color: z.string().max(100),
        sizes: z
          .array(
            z.object({
              size: z.string().min(1).max(20),
              quantity: z.number().int().min(1).max(100_000),
            }),
          )
          .min(1)
          .max(30),
      }),
    )
    .min(1)
    .max(20),
  decorations: z
    .array(
      z.object({
        location: z.string().min(1).max(100),
        method: z.string().min(1).max(100),
        colorCount: z.number().int().min(1).max(20).nullable(),
        details: z.string().max(500).nullable(),
      }),
    )
    .max(20),
  uncertainties: z.array(z.string().min(1).max(500)).max(30),
});

export type ExtractedQuote = z.infer<typeof ExtractedQuoteSchema>;

export class QuoteExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteExtractionError";
  }
}

export async function extractQuotePrompt(prompt: string): Promise<ExtractedQuote> {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
  const response = await openai.chat.completions.create(
    {
      model: MODEL,
      max_completion_tokens: 8_192,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You extract quote-request facts for an apparel screen-printing shop. Today is ${today} in America/New_York.

Return ONLY a JSON object matching this shape:
{
  "customerName": "string",
  "nickname": "string or null",
  "dueDate": "YYYY-MM-DD or null",
  "customerNote": "string",
  "productionNote": "string",
  "garments": [{
    "brand": "string or null",
    "style": "string",
    "description": "string or null",
    "color": "string",
    "sizes": [{"size": "S", "quantity": 12}]
  }],
  "decorations": [{
    "location": "Front",
    "method": "Screen print",
    "colorCount": 2,
    "details": "string or null"
  }],
  "uncertainties": ["string"]
}

Rules:
- Extract facts only. Never invent customers, products, colors, quantities, dates, costs, prices, or vendor availability.
- Normalize common apparel sizes to XS, S, M, L, XL, 2XL, 3XL, etc.
- If the request says a due date, convert it to YYYY-MM-DD. Otherwise dueDate must be null.
- If a required-looking fact is missing or ambiguous, preserve the best literal value and describe the uncertainty.
- nickname should be a short useful quote name only when the request clearly supplies one; otherwise null.
- Do not calculate prices.`,
        },
        { role: "user", content: prompt },
      ],
    },
    { timeout: CALL_TIMEOUT_MS },
  );

  const content = response.choices[0]?.message?.content;
  if (!content) throw new QuoteExtractionError("AI returned an empty response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new QuoteExtractionError("AI returned invalid JSON");
  }
  const validated = ExtractedQuoteSchema.safeParse(parsed);
  if (!validated.success) {
    throw new QuoteExtractionError(
      `AI response did not match the quote schema: ${validated.error.issues[0]?.message ?? "invalid response"}`,
    );
  }
  return validated.data;
}