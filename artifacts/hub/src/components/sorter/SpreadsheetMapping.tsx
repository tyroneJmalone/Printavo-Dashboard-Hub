import { useMemo } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import { FileDropzone } from "@/components/sorter/FileDropzone";
import {
  getSorterInspectSpreadsheetUrl,
  type SorterSpreadsheetInspectResult,
} from "@workspace/api-client-react";

export type SpreadsheetColumnMapping = {
  sheet_name: string;
  header_row: number;
  order_number_column: string;
};

export type InspectionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "ready"; result: SorterSpreadsheetInspectResult }
  | { status: "error"; message: string };

function isInspectResult(value: unknown): value is SorterSpreadsheetInspectResult {
  if (!value || typeof value !== "object") return false;
  const sheets = (value as { sheets?: unknown }).sheets;
  return (
    Array.isArray(sheets) &&
    sheets.every(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof (s as { name?: unknown }).name === "string" &&
        Array.isArray((s as { rows?: unknown }).rows),
    )
  );
}

export async function inspectSpreadsheet(
  file: File,
  signal?: AbortSignal,
): Promise<SorterSpreadsheetInspectResult> {
  const formData = new FormData();
  formData.append("spreadsheet", file);
  const response = await fetch(getSorterInspectSpreadsheetUrl(), {
    method: "POST",
    body: formData,
    credentials: "include",
    signal,
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const msg =
      body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string"
        ? (body as { error: string }).error
        : `Could not read file (${response.status})`;
    throw new Error(msg);
  }
  if (!isInspectResult(body)) throw new Error("Unexpected response while reading file");
  return {
    sheets: body.sheets.map((s) => ({
      name: s.name,
      rows: s.rows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : [])),
    })),
  };
}

export function suggestMapping(result: SorterSpreadsheetInspectResult): SpreadsheetColumnMapping | null {
  const first = result.sheets[0];
  if (!first) return null;
  const headers = first.rows[0] ?? [];
  return {
    sheet_name: first.name,
    header_row: 1,
    order_number_column:
      headers.find((h) => /order.*(#|number|no)|(#|number|no).*order/i.test(h.trim())) ?? "",
  };
}

const fieldCls =
  "w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-[#059669]";

export function SpreadsheetMapping({
  files,
  onFileSelected,
  onFileRemoved,
  inspection,
  mapping,
  onMappingChange,
  disabled,
}: {
  files: File[];
  onFileSelected: (file: File) => void;
  onFileRemoved: () => void;
  inspection: InspectionState;
  mapping: SpreadsheetColumnMapping | null;
  onMappingChange: (mapping: SpreadsheetColumnMapping) => void;
  disabled?: boolean;
}) {
  const preview = inspection.status === "ready" ? inspection.result : null;
  const activeSheet = preview?.sheets.find((s) => s.name === mapping?.sheet_name);
  const headers = useMemo(
    () => activeSheet?.rows[(mapping?.header_row ?? 1) - 1] ?? [],
    [activeSheet, mapping?.header_row],
  );
  const update = (changes: Partial<SpreadsheetColumnMapping>) => {
    if (mapping) onMappingChange({ ...mapping, ...changes });
  };

  return (
    <div className="space-y-4">
      <FileDropzone
        multiple={false}
        files={files}
        accept={{
          "text/csv": [".csv"],
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
        }}
        onFilesAccepted={(accepted) => accepted[0] && onFileSelected(accepted[0])}
        onFileRemoved={onFileRemoved}
        label="CSV and Excel (.xlsx) files are supported"
      />

      {inspection.status === "pending" && (
        <div className="flex items-center gap-2 text-xs text-slate-400" data-testid="status-spreadsheet-inspecting">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reading spreadsheet columns...
        </div>
      )}
      {inspection.status === "error" && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
          {inspection.message} Remove the file and upload a readable spreadsheet.
        </div>
      )}

      {preview && mapping && (
        <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="spreadsheet-sheet" className="text-xs font-semibold text-slate-300">Sheet</label>
              <select
                id="spreadsheet-sheet"
                data-testid="select-spreadsheet-sheet"
                value={mapping.sheet_name}
                disabled={disabled}
                onChange={(e) => {
                  const sheet = preview.sheets.find((s) => s.name === e.target.value);
                  const hdrs = sheet?.rows[0] ?? [];
                  update({
                    sheet_name: e.target.value,
                    header_row: 1,
                    order_number_column:
                      hdrs.find((h) => /order.*(#|number|no)|(#|number|no).*order/i.test(h.trim())) ?? "",
                  });
                }}
                className={fieldCls}
              >
                {preview.sheets.map((s) => (
                  <option key={s.name} value={s.name}>{s.name}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="spreadsheet-header-row" className="text-xs font-semibold text-slate-300">Header row</label>
              <input
                id="spreadsheet-header-row"
                data-testid="input-spreadsheet-header-row"
                type="number"
                min={1}
                max={Math.max(activeSheet?.rows.length ?? 1, 1)}
                value={mapping.header_row}
                disabled={disabled}
                onChange={(e) =>
                  update({ header_row: Math.max(1, Number(e.target.value) || 1), order_number_column: "" })
                }
                className={fieldCls}
              />
            </div>
          </div>

          <div>
            <p className="text-xs font-semibold text-slate-300">Column mapping</p>
            <p className="text-[11px] text-slate-500 mt-0.5">
              Select the order-number column. Its row sequence determines the packing-slip order.
            </p>
          </div>
          <div className="max-w-md space-y-1.5">
            <label htmlFor="map-order-number" className="text-xs font-semibold text-slate-300">
              Order number (required)
            </label>
            <select
              id="map-order-number"
              data-testid="select-order-number-column"
              value={mapping.order_number_column}
              disabled={disabled}
              onChange={(e) => update({ order_number_column: e.target.value })}
              className={fieldCls}
            >
              <option value="">Not mapped</option>
              {headers.map((h, i) =>
                h ? <option key={`${h}-${i}`} value={h}>{h}</option> : null,
              )}
            </select>
          </div>

          <div className="rounded-md bg-slate-900 border border-slate-700 px-3 py-2 text-[11px] text-slate-400">
            Detected headers: {headers.filter(Boolean).join(" · ") || "Choose the correct header row"}
          </div>
        </div>
      )}
    </div>
  );
}
