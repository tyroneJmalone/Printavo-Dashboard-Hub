/**
 * Curated Cap America 2026 catalog reference samples.
 *
 * Images are bundled under /cap-america-2026 because the API currently does
 * not mount the generic /api/storage/public-objects route.  The extraction
 * script also mirrors these same files to the configured App Storage public
 * prefix, so the image paths can be switched to
 * /api/storage/public-objects/cap-america-2026/... when that route is mounted.
 */

import supplierPhotoData from "./capAmericaSupplierPhotos.json";

type SupplierPhoto = {
  imageUrl: string;
  sourceUrl: string;
  width: number;
  height: number;
};

type SupplierStylePhotos = {
  productUrl: string;
  hero: SupplierPhoto & { label: string };
  colors: Record<string, SupplierPhoto>;
};

const supplierPhotos = supplierPhotoData as Record<string, SupplierStylePhotos>;

export type CapAmericaSample = {
  style: string;
  title: string;
  brand: string;
  vendor: string;
  description: string;
  features: string[];
  sizes: { label: string; range: string }[];
  colors: { name: string; imageUrl: string; photoSource: "supplier" | "catalog" }[];
  heroImageUrl: string;
  heroImageLabel?: string;
  productUrl?: string;
  pageImageUrl: string;
  sourceUrl: string;
  catalogPage: number;
  sourceYear: number;
  price: null;
  stock: null;
  imageNote: string;
};

const sizes = [
  { label: "XS", range: "6½–6⅞" },
  { label: "S/M", range: "7–7⅜" },
  { label: "L/XL", range: "7⅜–7⅞" },
  { label: "XXL", range: "7⅞–8¼" },
];

const imageSlug = (name: string) =>
  name.toLowerCase().replaceAll("/", "-").replaceAll(" ", "-");

const colors = (style: string, names: string[]) =>
  names.map((name, index) => ({
    name,
    imageUrl: `/cap-america-2026/${style}/colors/${String(index + 1).padStart(2, "0")}-${imageSlug(name)}.jpg`,
    photoSource: "catalog" as const,
  }));

const common = {
  brand: "Flexfit",
  vendor: "Cap America",
  sourceYear: 2026,
  price: null,
  stock: null,
} as const;

const catalogSamples: CapAmericaSample[] = [
  {
    ...common,
    style: "i8501",
    title: "Flexfit® Performance Trucker Cap",
    description:
      "Featuring a flat bill visor and Flexfit® stretch-fit technology, this on-field cap takes a modern spin on the classic trucker style. The performance mesh back ensures you stay cool and comfortable when the competition heats up.",
    features: [
      "Mid profile six panel structured on-field cap",
      "Shapeable flat round visor with contrasting silver polyester undervisor",
      "Poly/spandex blend fabric with performance trucker mesh",
      "UV guard & moisture wicking",
      "Athletic performance sweatband with Flexfit® sizing available in XS, S/M, L/XL and XXL",
    ],
    sizes,
    colors: colors("i8501", [
      "Athletic Gold/Black/White",
      "Athletic Gold/Navy/White",
      "Black/Red/White",
      "Black/Royal/White",
      "Columbia Blue/Navy/White",
      "Maroon/Black/White",
      "Navy/Red/White",
      "Orange/Black/White",
      "Vegas Gold/Black/White",
      "Vegas Gold/Navy/White",
      "White/Black/Black",
      "White/Navy/Navy",
      "White/Navy/Red",
      "White/Royal/Red",
      "Black/Graphite",
      "Black/White",
      "Dark Green/White",
      "Graphite/Black",
      "Graphite/White",
      "Kelly Green/White",
      "Maroon/Graphite",
      "Navy/White",
      "Purple/White",
      "Red/White",
      "Royal/White",
      "Black",
      "Navy",
      "Red",
      "Royal",
      "White",
    ]),
    heroImageUrl: "/cap-america-2026/i8501/hero.jpg",
    pageImageUrl: "/cap-america-2026/i8501/page-10.jpg",
    sourceUrl: "https://viewer.zoomcatalog.com/cap-america-2026/page/10",
    catalogPage: 10,
    imageNote:
      "Hero is the Cap America catalog sample shown with optional Personalized Team Numbers (Falcons artwork); this decoration is not included with an undecorated cap.",
  },
  {
    ...common,
    style: "i8530",
    title: "Flexfit® Full Fabric Performance Cap",
    description:
      "Designed for athletes, this style was built to withstand the demands of the field. Flexfit® technology and innovative performance materials make this cap a fan favorite.",
    features: [
      "Mid profile six panel structured on-field cap",
      "Shapeable flat round visor with contrasting silver polyester undervisor",
      "Poly/spandex blend fabric",
      "UV guard & moisture wicking",
      "Athletic performance sweatband with Flexfit® sizing available in XS, S/M, L/XL and XXL",
    ],
    sizes,
    colors: colors("i8530", [
      "Black/Black/Silver",
      "White/Black/Black",
      "White/Maroon/Maroon",
      "White/Navy/Navy",
      "White/Orange/Black",
      "White/Red/Black",
      "White/Red/Navy",
      "White/Royal/Royal",
      "Black/Red",
      "Black/Royal",
      "Silver/Black",
      "Silver/Navy",
      "Silver/Purple",
      "Black",
      "Dark Green",
      "Graphite",
      "Navy",
      "Red",
      "Royal",
      "Silver",
      "White",
    ]),
    heroImageUrl: "/cap-america-2026/i8530/hero.jpg",
    pageImageUrl: "/cap-america-2026/i8530/page-11.jpg",
    sourceUrl: "https://viewer.zoomcatalog.com/cap-america-2026/page/11",
    catalogPage: 11,
    imageNote:
      "Hero is the Cap America catalog sample shown with 3D Embroidery, optional Across Back Seam embroidery, and a sewn-on American Flag embroidered patch; decorations are not included with an undecorated cap.",
  },
  {
    ...common,
    style: "i8503",
    title: "Flexfit® Perforated Performance Cap",
    description:
      "Embrace peak performance and sleek style with this perforated Flexfit® cap. Crafted with premium materials and cutting-edge technology, this will be your new go-to headwear style both on and off the field.",
    features: [
      "Mid profile six panel structured on-field cap",
      "Shapeable flat round visor with contrasting silver polyester undervisor",
      "Poly/spandex blend fabric with perforated sides & back",
      "UV guard & moisture wicking",
      "Athletic performance sweatband with Flexfit® sizing available in XS, S/M, L/XL and XXL",
    ],
    sizes,
    colors: colors("i8503", [
      "Navy/Columbia Blue",
      "White/Black",
      "Loden",
      "Silver",
      "Vegas Gold",
      "Orange/Black/White",
      "Silver/Silver/Black",
      "White/Black/Black",
      "White/Maroon/Maroon",
      "White/Navy/Navy",
      "White/Red/Navy",
      "White/Red/Royal",
      "Black/Athletic Gold",
      "Black/Orange",
      "Dark Green/Athletic Gold",
      "Navy/Athletic Gold",
      "Red/Black",
      "Red/Navy",
      "Royal/Red",
      "Silver/Black",
      "Silver/Navy",
      "Silver/Red",
      "Silver/Royal",
      "White/Navy",
      "White/Red",
      "White/Royal",
      "Black",
      "Brown",
      "Cardinal",
      "Columbia Blue",
      "Dark Green",
      "Graphite",
      "Kelly Green",
      "Maroon",
      "Navy",
      "Orange",
      "Purple",
      "Red",
      "Royal",
      "True Texas Orange",
      "White",
    ]),
    heroImageUrl: "/cap-america-2026/i8503/hero.jpg",
    pageImageUrl: "/cap-america-2026/i8503/page-13.jpg",
    sourceUrl: "https://viewer.zoomcatalog.com/cap-america-2026/page/13",
    catalogPage: 13,
    imageNote:
      "Hero is the Cap America catalog sample shown with 3D Embroidery; the gray logo decoration is not included with an undecorated cap.",
  },
];

export const capAmericaSamples: CapAmericaSample[] = catalogSamples.map((sample) => {
  const photos = supplierPhotos[sample.style];
  if (!photos) return sample;
  return {
    ...sample,
    heroImageUrl: photos.hero.imageUrl,
    heroImageLabel: photos.hero.label,
    productUrl: photos.productUrl,
    imageNote: "Blank product photo supplied by Cap America; decoration is not shown.",
    colors: sample.colors.map((color) => {
      const photo = photos.colors[color.name];
      return photo
        ? { ...color, imageUrl: photo.imageUrl, photoSource: "supplier" as const }
        : color;
    }),
  };
});