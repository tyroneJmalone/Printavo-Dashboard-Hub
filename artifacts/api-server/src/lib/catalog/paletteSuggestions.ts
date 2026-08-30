import { cieDe2000, rgbToLab, visualScore, type Lab } from "./colorMeasurement";

export type PaletteColor = { id: string; role: string; name: string; hex: string | null; pantoneCode?: string | null };
export type CatalogPaletteColor = {
  colorName: string; normName: string; swatchImage: string | null; productImage: string | null; families: string[];
  evidence?: { status: string; lab: Lab | null; rgb?: readonly [number, number, number] | null; sourceSwatchUrl?: string | null; sourceSwatchHash?: string | null; reason?: string | null; profile?: string | null; illuminant?: string | null; measuredAt?: string | null; confidence?: string | null; quality?: string | null; method?: string | null; algorithmVersion?: string | null } | null;
};

export function normalizeColorName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const CANONICAL_FAMILIES = new Set([
  "black", "white", "grey", "silver", "blue", "light blue", "navy", "royal blue", "teal",
  "green", "dark green", "light green", "olive", "red", "dark red", "maroon", "orange",
  "yellow", "gold", "purple", "lavender", "pink", "brown", "tan", "cream", "natural",
  "charcoal", "camo", "multi", "neon",
]);

export function numericRgb(value: unknown): [number, number, number] | null {
  const candidate = Array.isArray(value) ? value :
    value && typeof value === "object" ? [(value as Record<string, unknown>).r, (value as Record<string, unknown>).g, (value as Record<string, unknown>).b] : null;
  return candidate && candidate.length === 3 && candidate.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 255)
    ? candidate as [number, number, number] : null;
}

/** RGB is always derived from hex — the catalog stores no separate RGB value. */
export function customerRgb(color: Pick<PaletteColor, "hex">): [number, number, number] | null {
  const hex = typeof color.hex === "string" ? color.hex.replace(/^#/, "") : "";
  return /^([0-9a-f]{6})$/i.test(hex)
    ? [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
    : null;
}

function rgbToHsl([r0, g0, b0]: [number, number, number]): [number, number, number] {
  const r = r0 / 255, g = g0 / 255, b = b0 / 255, max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = ((max === r ? (g - b) / d : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
  return [h, s, l];
}

/** Conservative deterministic family hints. Catalog families remain authoritative for garments. */
export function derivePaletteFamilies(color: Pick<PaletteColor, "name" | "hex">): string[] {
  const name = normalizeColorName(color.name);
  const nameTokens = name.split(" ").filter(Boolean);
  const families = new Set<string>();
  const named: Array<[string, string]> = [
    ["black", "black"], ["white", "white"], ["grey", "grey"], ["gray", "grey"], ["silver", "silver"],
    ["charcoal", "charcoal"], ["navy", "navy"], ["royal", "royal blue"], ["light blue", "light blue"],
    ["blue", "blue"], ["teal", "teal"], ["olive", "olive"], ["dark green", "dark green"], ["light green", "light green"],
    ["green", "green"], ["maroon", "maroon"], ["dark red", "dark red"], ["red", "red"], ["orange", "orange"],
    ["gold", "gold"], ["yellow", "yellow"], ["lavender", "lavender"], ["purple", "purple"], ["pink", "pink"],
    ["brown", "brown"], ["tan", "tan"], ["beige", "tan"], ["cream", "cream"], ["natural", "natural"],
  ];
  for (const [token, family] of named) {
    const phrase = token.split(" ");
    if (nameTokens.some((_, start) => phrase.every((part, index) => nameTokens[start + index] === part))) {
      families.add(family);
    }
  }
  const rgb = customerRgb(color);
  if (rgb) {
    const [h, s, l] = rgbToHsl(rgb as [number, number, number]);
    if (l < .12) families.add("black");
    else if (l > .91 && s < .18) families.add("white");
    else if (s < .14) families.add(l < .35 ? "charcoal" : "grey");
    else if (h < 12 || h >= 348) families.add(l < .25 ? "maroon" : l < .4 ? "dark red" : "red");
    else if (h < 38) families.add(l < .35 ? "brown" : "orange");
    else if (h < 55) families.add(l < .42 ? "gold" : "yellow");
    else if (h < 78) families.add("olive");
    else if (h < 165) families.add(l < .32 ? "dark green" : l > .68 ? "light green" : "green");
    else if (h < 195) families.add("teal");
    else if (h < 210) families.add(l > .68 ? "light blue" : "blue");
    else if (h < 250) families.add(l < .38 ? "navy" : "royal blue");
    else if (h < 285) families.add(l > .7 ? "lavender" : "purple");
    else if (h < 345) families.add("pink");
  }
  return [...families].filter((family) => CANONICAL_FAMILIES.has(family)).sort();
}

export function dedupeStyleInputs(styles: string[]): string[] {
  const seen = new Set<string>();
  return styles.map((style) => style.trim()).filter((style) => {
    const key = style.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function rankPaletteColor(garment: CatalogPaletteColor, palette: PaletteColor[]) {
  const exact = normalizeColorName(garment.colorName);
  const ranked = palette.map((customer) => {
    const customerFamilies = derivePaletteFamilies(customer);
    if (exact === normalizeColorName(customer.name)) {
      return { customer, customerFamilies, matchMethod: "exact_name" as const, confidence: "high" as const, score: 100, deltaE: null, reason: "Exact normalized color-name match." };
    }
    const rgb = customerRgb(customer);
    const lab = garment.evidence?.status === "measured" ? garment.evidence.lab : null;
    if (rgb && lab) {
      const deltaE = cieDe2000(lab, rgbToLab(rgb));
      return {
        customer, customerFamilies, matchMethod: "visual_delta_e" as const,
        // This is deliberately not "high": vendor web swatches are not
        // calibrated garment fabric, regardless of a close numeric result.
        confidence: garment.evidence?.confidence === "medium" ? "medium" as const : "low" as const,
        score: visualScore(deltaE), deltaE, reason: "CIEDE2000 comparison to a representative vendor web-swatch sample.",
      };
    }
    const overlap = garment.families.filter((f) => customerFamilies.includes(f)).sort();
    if (overlap.length) {
      return { customer, customerFamilies, matchMethod: "family" as const, confidence: "medium" as const, score: 60 + Math.min(10, overlap.length), deltaE: null, reason: `Shared color family: ${overlap.join(", ")}.` };
    }
    return { customer, customerFamilies, matchMethod: "unknown" as const, confidence: "low" as const, score: 0, deltaE: null, reason: "No exact name, measured web-swatch, or catalog-family match." };
  });
  ranked.sort((a, b) => b.score - a.score || a.customer.role.localeCompare(b.customer.role) || a.customer.name.localeCompare(b.customer.name));
  const best = ranked[0]!;
  return { ...garment, matchedCustomer: { id: best.customer.id, role: best.customer.role, name: best.customer.name, hex: best.customer.hex, pantoneCode: best.customer.pantoneCode ?? null, families: best.customerFamilies }, matchMethod: best.matchMethod, confidence: best.confidence, score: best.score, deltaE: best.deltaE, reason: best.reason,
    evidence: garment.evidence ? { status: garment.evidence.status, rgb: garment.evidence.rgb ?? null, sourceSwatchUrl: garment.evidence.sourceSwatchUrl ?? null, sourceSwatchHash: garment.evidence.sourceSwatchHash ?? null, reason: garment.evidence.reason ?? null, profile: garment.evidence.profile ?? null, illuminant: garment.evidence.illuminant ?? null, measuredAt: garment.evidence.measuredAt ?? null, confidence: garment.evidence.confidence ?? null, quality: garment.evidence.quality ?? null, method: garment.evidence.method ?? null, algorithmVersion: garment.evidence.algorithmVersion ?? null } : null };
}