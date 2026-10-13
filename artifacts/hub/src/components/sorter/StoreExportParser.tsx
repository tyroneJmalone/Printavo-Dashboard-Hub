import { useMemo, useState } from "react";
import { Check, Loader2, Search, AlertCircle } from "lucide-react";
import { FileDropzone } from "@/components/sorter/FileDropzone";
import type { InspectionState } from "@/components/sorter/SpreadsheetMapping";

export const STORE_EXPORT_DEFAULT_DROP_COLUMNS = [
  "Dealer Name",
  "Organization County",
  "Catalog Sales Id",
  "Sales Id",
  "Status",
  "Ship Country",
  "Ship Country Code",
  "Product Status",
  "Event Product ID",
  "Sub Category",
  "Product Image URL",
  "Product UPC",
  "Tax Total",
  "Salesperson Id",
  "Salesperson External Id",
  "BatchID",
  "External Organization ID",
  "External Organization Branch ID",
  "Batch Standalone",
] as const;

const DEFAULT_DROP_SET = new Set<string>(STORE_EXPORT_DEFAULT_DROP_COLUMNS);

export function storeExportHeaders(inspection: InspectionState): string[] {
  return inspection.status === "ready" ? (inspection.result.sheets[0]?.rows[0] ?? []) : [];
}

export function StoreExportParser({
  files,
  onFileSelected,
  onFileRemoved,
  inspection,
  additionalDropIndexes,
  onAdditionalDropIndexesChange,
  disabled,
}: {
  files: File[];
  onFileSelected: (file: File) => void;
  onFileRemoved: () => void;
  inspection: InspectionState;
  additionalDropIndexes: number[];
  onAdditionalDropIndexesChange: (indexes: number[]) => void;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const headers = storeExportHeaders(inspection);

  const visibleHeaders = useMemo(() => {
    const term = search.trim().toLowerCase();
    return headers
      .map((header, index) => ({ header, index }))
      .filter(({ header }) => !DEFAULT_DROP_SET.has(header))
      .filter(({ header }) => !term || header.toLowerCase().includes(term));
  }, [headers, search]);

  const toggleColumn = (index: number) => {
    onAdditionalDropIndexesChange(
      additionalDropIndexes.includes(index)
        ? additionalDropIndexes.filter((v) => v !== index)
        : [...additionalDropIndexes, index].sort((a, b) => a - b),
    );
  };

  return (
    <div className="space-y-4">
      <FileDropzone
        multiple={false}
        files={files}
        accept={{ "text/csv": [".csv"] }}
        onFilesAccepted={(accepted) => {
          setSearch("");
          if (accepted[0]) onFileSelected(accepted[0]);
        }}
        onFileRemoved={() => {
          setSearch("");
          onFileRemoved();
        }}
        label="Chipply store export CSV"
      />

      {inspection.status === "pending" && (
        <div className="flex items-center gap-2 text-xs text-slate-400" data-testid="status-csv-inspecting">
          <Loader2 className="h-4 w-4 animate-spin" />
          Reading CSV columns...
        </div>
      )}
      {inspection.status === "error" && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
          {inspection.message} Remove the file and upload a readable CSV.
        </div>
      )}

      {headers.length > 0 && (
        <div className="space-y-4 rounded-lg border border-slate-700 bg-slate-800/40 p-4">
          <div>
            <p className="text-xs font-semibold text-slate-200">
              {STORE_EXPORT_DEFAULT_DROP_COLUMNS.length} standard columns will be removed
            </p>
            <p className="mt-1 text-[11px] text-slate-500">
              Select any additional columns you do not need for this job. All other columns and cell values stay in their original order and text format.
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {STORE_EXPORT_DEFAULT_DROP_COLUMNS.map((c) => (
              <span key={c} className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-400">
                {c}
              </span>
            ))}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="column-search" className="text-xs font-semibold text-slate-300">
              Additional columns to remove
            </label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                id="column-search"
                data-testid="input-column-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search columns"
                className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg pl-9 pr-3 py-2 focus:outline-none focus:border-[#059669]"
              />
            </div>
          </div>

          <div className="grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 custom-scrollbar">
            {visibleHeaders.length === 0 && (
              <p className="text-xs text-slate-500 italic">No columns match this search.</p>
            )}
            {visibleHeaders.map(({ header, index }) => {
              const selected = additionalDropIndexes.includes(index);
              return (
                <button
                  key={`${header}-${index}`}
                  type="button"
                  disabled={disabled}
                  data-testid={`toggle-column-${index}`}
                  onClick={() => toggleColumn(index)}
                  aria-pressed={selected}
                  className={`flex min-h-9 items-center gap-3 rounded-md border px-3 py-2 text-left text-xs transition-colors ${
                    selected
                      ? "border-[#059669] bg-[#059669]/10 text-slate-100"
                      : "border-slate-700 bg-slate-900 text-slate-300 hover:border-[#059669]/50"
                  }`}
                >
                  <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    selected ? "border-[#059669] bg-[#059669] text-white" : "border-slate-600"
                  }`}>
                    {selected && <Check className="h-3 w-3" />}
                  </span>
                  <span>{header || `Unnamed column ${index + 1}`}</span>
                </button>
              );
            })}
          </div>
          <p className="text-[11px] font-medium text-slate-400" data-testid="text-drop-count">
            {additionalDropIndexes.length} additional {additionalDropIndexes.length === 1 ? "column" : "columns"} selected
          </p>
        </div>
      )}
    </div>
  );
}
