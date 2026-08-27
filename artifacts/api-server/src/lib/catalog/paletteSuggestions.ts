export type PaletteColor = { id: string; role: string; name: string; hex: string | null; rgb: unknown };
export type CatalogPaletteColor = {
  colorName: string; normName: string; swatchImage: string | null; productImage: string | null; families: string[];
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

function numericRgb(value: unknown): [number, number, number] | null {
  const candidate = Array.isArray(value) ? value :
    value && typeof value === "object" ? [(value as Record<string, unknown>).r, (value as Record<string, unknown>).g, (value as Record<string, unknown>).b] : null;
  return candidate && candidate.length === 3 && candidate.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 255)
    ? candidate as [number, number, number] : null;
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
export function derivePaletteFamilies(color: Pick<PaletteColor, "name" | "hex" | "rgb">): string[] {
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
  const hex = typeof color.hex === "string" ? color.hex.replace(/^#/, "") : "";
  const rgb = /^([0-9a-f]{6})$/i.test(hex)
    ? [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
    : numericRgb(color.rgb);
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
      return { customer, customerFamilies, matchMethod: "exact_name" as const, confidence: "high" as const, score: 100, reason: "Exact normalized color-name match." };
    }
    const overlap = garment.families.filter((f) => customerFamilies.includes(f)).sort();
    if (overlap.length) {
      return { customer, customerFamilies, matchMethod: "family" as const, confidence: "medium" as const, score: 60 + Math.min(10, overlap.length), reason: `Shared color family: ${overlap.join(", ")}.` };
    }
    return { customer, customerFamilies, matchMethod: "unknown" as const, confidence: "low" as const, score: 0, reason: "No exact name or catalog-family match." };
  });
  ranked.sort((a, b) => b.score - a.score || a.customer.role.localeCompare(b.customer.role) || a.customer.name.localeCompare(b.customer.name));
  const best = ranked[0]!;
  return { ...garment, matchedCustomer: { id: best.customer.id, role: best.customer.role, name: best.customer.name, hex: best.customer.hex, families: best.customerFamilies }, matchMethod: best.matchMethod, confidence: best.confidence, score: best.score, reason: best.reason };
}