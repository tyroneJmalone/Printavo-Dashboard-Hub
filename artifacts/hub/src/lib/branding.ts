import type { ArtworkUseCase } from "@workspace/api-client-react";

/** Display labels for logo bookmark use cases (kept in sync with the API vocabulary). */
export const USE_CASE_LABELS: Record<ArtworkUseCase, string> = {
  light_background: "Light backgrounds",
  dark_background: "Dark backgrounds",
  print: "Print",
  embroidery: "Embroidery",
  web: "Web / digital",
  restricted: "Restricted — ask first",
};

export const USE_CASE_ORDER: ArtworkUseCase[] = [
  "light_background",
  "dark_background",
  "print",
  "embroidery",
  "web",
  "restricted",
];

/** RGB is always derived from hex so the two can never disagree. */
export function hexToRgb(hex: string): string | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = parseInt(match[1], 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

export function formatEventDate(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
