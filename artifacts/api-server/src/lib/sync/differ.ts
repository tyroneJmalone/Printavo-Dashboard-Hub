import { createHash } from "node:crypto";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`,
  );
  return `{${parts.join(",")}}`;
}

export function contentHashOf(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function moneyStr(value: number | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed(2);
}

export function dateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function sameInstant(a: Date | null, b: Date | null): boolean {
  return (a?.getTime() ?? null) === (b?.getTime() ?? null);
}
