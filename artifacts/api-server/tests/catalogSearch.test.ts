import test from "node:test";
import assert from "node:assert/strict";
import { parseSanMarProductInfoResponse } from "@workspace/sanmar";
import { mapSanMarProduct } from "../src/lib/catalog/sanmarMapping";
import { mapCatalogSearchRow, type CatalogSearchColor } from "../src/lib/catalog/searchResult";

test("SanMar product description and category flow from the existing SOAP response", () => {
  const [entry] = parseSanMarProductInfoResponse(`
    <listResponse>
      <productBasicInfo>
        <style>PC61</style><catalogColor>Navy</catalogColor><size>M</size>
        <brandName>Port &amp; Company</brandName>
        <productTitle>Essential Tee</productTitle>
        <productDescription>&lt;p&gt;A dependable everyday tee.&lt;/p&gt;</productDescription>
        <category>T-Shirts</category>
      </productBasicInfo>
      <productImageInfo>
        <colorSquareImage>https://example.com/navy-swatch.jpg</colorSquareImage>
        <colorProductImage>https://example.com/navy-shirt.jpg</colorProductImage>
      </productImageInfo>
    </listResponse>
  `);
  assert.ok(entry);
  const mapped = mapSanMarProduct(
    [entry],
    new Map([["Navy", { swatch: entry.colorSwatchImage, photo: entry.colorProductImage }]]),
    new Set(["M"]),
    2.5,
    3,
  );
  assert.equal(mapped.description, "A dependable everyday tee.");
  assert.equal(mapped.category, "T-Shirts");
});

test("search mapping returns every sorted color beyond preview eight while preserving filtered matches", () => {
  const colors: CatalogSearchColor[] = Array.from({ length: 10 }, (_, i) => ({
    colorName: `Color ${String(i + 1).padStart(2, "0")}`,
    swatchImage: `https://example.com/swatch-${i + 1}.jpg`,
    productImage: `https://example.com/product-${i + 1}.jpg`,
    families: i === 8 ? ["blue"] : [],
  }));
  const matchedColors = [colors[8]!];
  const hit = mapCatalogSearchRow({
    id: 1,
    vendor: "sanmar",
    style_name: "PC61",
    brand: "Port & Company",
    title: "Essential Tee",
    description: "A dependable everyday tee.",
    category: "T-Shirts",
    style_image: colors[0]!.productImage,
    price_min: "2.50",
    price_max: "3.00",
    sizes: ["M"],
    eff_tags: ["t-shirt"],
    discontinued: false,
    matched_colors: matchedColors,
    colors,
    color_count: "10",
    score: "5",
  });

  assert.equal(hit.description, "A dependable everyday tee.");
  assert.equal(hit.colors.length, 10);
  assert.deepEqual(hit.colors.map((color) => color.colorName), colors.map((color) => color.colorName));
  assert.deepEqual(hit.matchedColors, matchedColors);
});