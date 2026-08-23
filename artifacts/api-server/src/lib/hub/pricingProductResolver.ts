import type { ProductSearchResult } from "../purchasing/productFinder";
import type {
  VendorColorOffer,
  VendorSizeOffer,
} from "../purchasing/vendorLookup";

const STANDARD_SIZES = new Set(["XS", "S", "M", "L", "XL"]);

function sameText(a: string, b: string): boolean {
  return (
    a.trim().toLowerCase().replace(/[^a-z0-9]/g, "") ===
    b.trim().toLowerCase().replace(/[^a-z0-9]/g, "")
  );
}

function baseStandardSize(color: VendorColorOffer): VendorSizeOffer | null {
  return (
    color.sizes
      .filter(
        (size) =>
          STANDARD_SIZES.has(size.size.toUpperCase()) && size.cost !== null,
      )
      .sort(
        (a, b) =>
          (a.cost as number) - (b.cost as number) ||
          a.size.localeCompare(b.size),
      )[0] ?? null
  );
}

function activeSalePrice(
  size: VendorSizeOffer,
  now: Date,
): number | null {
  if (size.salePrice === null || size.saleEndsAt === null) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(size.saleEndsAt);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    return null;
  }
  const endMs = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
  if (endMs < now.getTime()) return null;
  return size.salePrice;
}

export interface PricingGarmentMatch {
  vendor: "sanmar" | "ss";
  matchType: "exact" | "closest";
  styleName: string;
  brand: string | null;
  title: string | null;
  colorName: string;
  regularCost: number;
  saleCost: number | null;
  appliedPriceType: "regular" | "sale";
}

export type StandardSizePricingResolution =
  | {
      resolved: true;
      cost: number;
      match: PricingGarmentMatch;
      warnings: string[];
    }
  | { resolved: false; warning: string };

/**
 * Resolve a calculator base garment cost without requiring an order-size
 * breakdown. Only XS–XL vendor prices participate; plus-size pricing is
 * intentionally ignored because the calculator handles those adjustments
 * separately.
 */
export function resolveStandardSizeGarmentPricing(
  search: Pick<ProductSearchResult, "vendors">,
  style: string,
  requestedColor: string | null,
  now = new Date(),
): StandardSizePricingResolution {
  const found = search.vendors.filter(({ lookup }) => lookup.found);
  if (found.length === 0) {
    return {
      resolved: false,
      warning: `Style "${style}" was not found in the connected vendor catalogs — garment cost not resolved.`,
    };
  }

  const candidates = found.flatMap(({ lookup }) => {
    const colors = requestedColor
      ? lookup.colors.filter((color) =>
          sameText(color.colorName, requestedColor),
        )
      : lookup.colors;

    return colors.flatMap((color) => {
      const base = baseStandardSize(color);
      if (!base || base.cost === null || !lookup.styleName) return [];
      const regularCost = base.cost;
      const saleCost = activeSalePrice(base, now);
      return [
        {
          effectiveCost: saleCost ?? regularCost,
          match: {
            vendor: lookup.vendor,
            matchType:
              lookup.matchType === "exact"
                ? ("exact" as const)
                : ("closest" as const),
            styleName: lookup.styleName,
            brand: lookup.brand,
            title: lookup.title,
            colorName: color.colorName,
            regularCost,
            saleCost,
            appliedPriceType:
              saleCost === null ? ("regular" as const) : ("sale" as const),
          },
        },
      ];
    });
  });

  if (candidates.length === 0) {
    if (requestedColor) {
      return {
        resolved: false,
        warning: `Color "${requestedColor}" has no regular-size (XS–XL) pricing for style "${style}".`,
      };
    }
    return {
      resolved: false,
      warning: `Style "${style}" has no regular-size (XS–XL) vendor pricing — garment cost not resolved.`,
    };
  }

  const exact = candidates.filter(
    (candidate) => candidate.match.matchType === "exact",
  );
  const ranked = (exact.length > 0 ? exact : candidates).sort(
    (a, b) =>
      a.effectiveCost - b.effectiveCost ||
      a.match.regularCost - b.match.regularCost ||
      a.match.vendor.localeCompare(b.match.vendor) ||
      a.match.colorName.localeCompare(b.match.colorName),
  );
  const selected = ranked[0]!;
  const warnings: string[] = [];

  if (selected.match.matchType === "closest") {
    warnings.push(
      `Style "${style}" used the closest vendor match (${selected.match.brand ?? selected.match.vendor} ${selected.match.styleName}) — verify the product.`,
    );
  }
  const distinctProducts = new Set(
    ranked.map(
      (candidate) =>
        `${candidate.match.vendor}:${candidate.match.styleName.toLowerCase()}`,
    ),
  );
  if (distinctProducts.size > 1) {
    warnings.push(
      `Style "${style}" had multiple regular-size vendor matches; using ${selected.match.vendor === "sanmar" ? "SanMar" : "S&S Activewear"} ${selected.match.styleName} at the lowest current cost.`,
    );
  }
  if (!requestedColor) {
    warnings.push(
      `No garment color was provided; using ${selected.match.colorName} regular-size pricing.`,
    );
  }

  return {
    resolved: true,
    cost: selected.effectiveCost,
    match: selected.match,
    warnings,
  };
}