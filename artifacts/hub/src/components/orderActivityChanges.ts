export function activityFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    quantity: "Quantity", unitPrice: "Unit price", product: "Product",
    productStatus: "Line-item status", description: "Description", color: "Color",
    items: "Total quantity", itemNumber: "Item number", id: "Product ID",
  };
  return labels[field] ?? field.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replace(/^./, c => c.toUpperCase());
}

function values(field: string, raw: string | null | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (raw == null) return result;
  let parsed: unknown = raw;
  // Only decode structured values. A literal description such as "null" or
  // "123" must remain text, not become a missing/numeric value.
  if (/^\s*[\[{]/.test(raw)) {
    try { parsed = JSON.parse(raw); } catch { /* Truncated/legacy JSON stays readable text. */ }
  }
  const visit = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      if (!value.length) result.set(path, "None");
      value.forEach((entry, index) => {
        if (field === "quantity" && entry && typeof entry === "object" && "size" in entry && "count" in entry) {
          result.set(`Size: ${String(entry.size)}`, String(entry.count ?? "Not recorded"));
        } else visit(entry, `${path} ${index + 1}`);
      });
    } else if (value && typeof value === "object") {
      if (!Object.keys(value).length) result.set(path, "None");
      Object.entries(value).forEach(([key, child]) => visit(child, path === activityFieldLabel(field) ? activityFieldLabel(key) : `${path} · ${activityFieldLabel(key)}`));
    } else {
      const text = value == null ? "Not recorded" : value === "" ? "(empty)" : String(value);
      result.set(path, field === "unitPrice" && String(value).trim() !== "" && Number.isFinite(Number(value)) && value != null
        ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value)) : text);
    }
  };
  visit(parsed, activityFieldLabel(field));
  return result;
}

export function activityChangeRows(field: string, before: string | null | undefined, after: string | null | undefined) {
  const oldValues = values(field, before);
  const newValues = values(field, after);
  return [...new Set([...oldValues.keys(), ...newValues.keys()])].map(label => ({
    label,
    before: oldValues.get(label) ?? "Not recorded",
    after: newValues.get(label) ?? "Not recorded",
    changed: oldValues.has(label) !== newValues.has(label) || oldValues.get(label) !== newValues.get(label),
  }));
}