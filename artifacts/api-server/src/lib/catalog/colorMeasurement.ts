import { createHash } from "node:crypto";

export const SWATCH_MEASUREMENT_VERSION = "vendor-web-swatch-v2";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 1_000_000;
const ALLOWED_HOSTS = new Set(["cdnm.sanmar.com", "www.ssactivewear.com", "cdn.ssactivewear.com"]);

export type Rgb = readonly [number, number, number];
export type Lab = readonly [number, number, number];

export function canonicalSwatchUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(host) || url.username || url.password || url.port) return null;
    if ((host === "www.ssactivewear.com" || host === "cdn.ssactivewear.com") &&
      !url.pathname.toLowerCase().startsWith("/images/colorswatch/")) return null;
    // S&S's catalog URL always issues a 301 to this dedicated image CDN.
    // Canonicalize before the request so redirect:error remains an SSRF guard.
    if (host === "www.ssactivewear.com") url.hostname = "cdn.ssactivewear.com";
    return url.toString();
  } catch { return null; }
}

export function permittedSwatchUrl(value: string): boolean {
  return canonicalSwatchUrl(value) !== null;
}

function linear(channel: number): number {
  const n = channel / 255;
  return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4;
}

/** sRGB (D65) to CIELAB (D65 white point). */
export function rgbToLab([r, g, b]: Rgb): Lab {
  const x = (linear(r) * .4124564 + linear(g) * .3575761 + linear(b) * .1804375) / .95047;
  const y = linear(r) * .2126729 + linear(g) * .7151522 + linear(b) * .072175;
  const z = (linear(r) * .0193339 + linear(g) * .119192 + linear(b) * .9503041) / 1.08883;
  const f = (n: number) => n > .008856451679 ? Math.cbrt(n) : 7.787037 * n + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIEDE2000, Sharma et al. 2005 reference implementation. */
export function cieDe2000(a: Lab, b: Lab): number {
  const [l1, aa1, bb1] = a, [l2, aa2, bb2] = b;
  const c1 = Math.hypot(aa1, bb1), c2 = Math.hypot(aa2, bb2);
  const avgC = (c1 + c2) / 2;
  const g = .5 * (1 - Math.sqrt(avgC ** 7 / (avgC ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * aa1, ap2 = (1 + g) * aa2;
  const cp1 = Math.hypot(ap1, bb1), cp2 = Math.hypot(ap2, bb2);
  const hue = (x: number, y: number) => (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const h1 = cp1 === 0 ? 0 : hue(ap1, bb1), h2 = cp2 === 0 ? 0 : hue(ap2, bb2);
  const dl = l2 - l1, dc = cp2 - cp1;
  const dh = cp1 * cp2 === 0 ? 0 : ((h2 - h1 + 540) % 360) - 180;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(dh * Math.PI / 360);
  const avgL = (l1 + l2) / 2, avgCp = (cp1 + cp2) / 2;
  const hdiff = Math.abs(h1 - h2);
  const avgH = cp1 * cp2 === 0 ? h1 + h2 : hdiff <= 180 ? (h1 + h2) / 2 : (h1 + h2 + 360) / 2 % 360;
  const t = 1 - .17 * Math.cos((avgH - 30) * Math.PI / 180) + .24 * Math.cos(2 * avgH * Math.PI / 180) +
    .32 * Math.cos((3 * avgH + 6) * Math.PI / 180) - .20 * Math.cos((4 * avgH - 63) * Math.PI / 180);
  const sl = 1 + .015 * (avgL - 50) ** 2 / Math.sqrt(20 + (avgL - 50) ** 2);
  const sc = 1 + .045 * avgCp, sh = 1 + .015 * avgCp * t;
  const rt = -2 * Math.sqrt(avgCp ** 7 / (avgCp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((avgH - 275) / 25) ** 2)) * Math.PI / 180);
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * (dc / sc) * (dH / sh));
}

/** Converts an honest visual distance to a bounded presentation score. */
export function visualScore(deltaE: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - deltaE * 5)));
}

export type SwatchMeasurement =
  | { ok: true; rgb: Rgb; lab: Lab; hash: string; confidence: "medium" | "low"; quality: string; method: string; profile: string; illuminant: "D65"; reason: string; algorithmVersion: string }
  | { ok: false; reason: string; algorithmVersion: string };

/**
 * Decode a small vendor swatch and sample the central 60%. Transparent pixels
 * are ignored.  Mean absolute deviation rejects gradients, photos and
 * multi-colour tiles rather than pretending their average is a fabric colour.
 */
export async function measureSwatchBuffer(buffer: Buffer): Promise<SwatchMeasurement> {
  try {
    if (!buffer.length || buffer.length > MAX_BYTES) return { ok: false, reason: "Swatch exceeds byte limit.", algorithmVersion: SWATCH_MEASUREMENT_VERSION };
    const { default: sharp } = await import("sharp");
    const image = sharp(buffer, { limitInputPixels: MAX_PIXELS, failOn: "error" });
    const meta = await image.metadata();
    if (!meta.width || !meta.height || meta.width * meta.height > MAX_PIXELS) return { ok: false, reason: "Swatch dimensions are unusable.", algorithmVersion: SWATCH_MEASUREMENT_VERSION };
    const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const x0 = Math.floor(info.width * .2), x1 = Math.ceil(info.width * .8);
    const y0 = Math.floor(info.height * .2), y1 = Math.ceil(info.height * .8);
    const samples: number[][] = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const p = (y * info.width + x) * 4;
      if (data[p + 3]! >= 230) samples.push([data[p]!, data[p + 1]!, data[p + 2]!]);
    }
    if (samples.length < 64) return { ok: false, reason: "Swatch has insufficient opaque central pixels.", algorithmVersion: SWATCH_MEASUREMENT_VERSION };
    const avg = [0, 1, 2].map((i) => samples.reduce((n, p) => n + p[i]!, 0) / samples.length) as [number, number, number];
    const distances = samples.map((p) => Math.hypot(p[0]! - avg[0], p[1]! - avg[1], p[2]! - avg[2]));
    const mad = distances.reduce((n, d) => n + d, 0) / distances.length;
    const outliers = distances.filter((d) => d > 30).length / distances.length;
    // Real vendor swatches include visible knit/weave texture. Keep those as
    // low-confidence evidence while rejecting genuinely split/multicolor tiles.
    if (mad > 50 || outliers > .55) return { ok: false, reason: "Swatch is noisy or multi-color, not a representative color tile.", algorithmVersion: SWATCH_MEASUREMENT_VERSION };
    const rgb = avg.map((n) => Math.round(n)) as [number, number, number];
    return { ok: true, rgb, lab: rgbToLab(rgb), hash: createHash("sha256").update(buffer).digest("hex"), confidence: mad < 7 ? "medium" : "low", quality: mad < 7 ? "uniform" : "slightly_varied", method: "vendor_web_swatch_central_sample", profile: "sRGB", illuminant: "D65", reason: "Representative central web-swatch sample; not calibrated fabric.", algorithmVersion: SWATCH_MEASUREMENT_VERSION };
  } catch { return { ok: false, reason: "Swatch could not be decoded safely.", algorithmVersion: SWATCH_MEASUREMENT_VERSION }; }
}

export async function fetchAndMeasureSwatch(url: string): Promise<SwatchMeasurement> {
  const canonicalUrl = canonicalSwatchUrl(url);
  if (!canonicalUrl) return { ok: false, reason: "Swatch URL is not an allowed HTTPS vendor host.", algorithmVersion: SWATCH_MEASUREMENT_VERSION };
  const signal = AbortSignal.timeout(8_000);
  try {
    const response = await fetch(canonicalUrl, { signal, redirect: "error" });
    const length = Number(response.headers.get("content-length") ?? 0);
    if (!response.ok || length > MAX_BYTES) return { ok: false, reason: "Swatch download was unavailable or exceeds byte limit.", algorithmVersion: SWATCH_MEASUREMENT_VERSION };
    if (!response.body) return { ok: false, reason: "Swatch download had no body.", algorithmVersion: SWATCH_MEASUREMENT_VERSION };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        return { ok: false, reason: "Swatch download exceeds byte limit.", algorithmVersion: SWATCH_MEASUREMENT_VERSION };
      }
      chunks.push(next.value);
    }
    return measureSwatchBuffer(Buffer.concat(chunks));
  } catch { return { ok: false, reason: "Swatch download failed or timed out.", algorithmVersion: SWATCH_MEASUREMENT_VERSION }; }
}