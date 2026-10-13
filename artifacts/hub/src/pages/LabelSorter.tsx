import { useRef, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { FileDropzone } from "@/components/sorter/FileDropzone";
import { CustomSortBuilder } from "@/components/sorter/CustomSortBuilder";
import {
  SpreadsheetMapping,
  inspectSpreadsheet,
  suggestMapping,
  type InspectionState,
  type SpreadsheetColumnMapping,
} from "@/components/sorter/SpreadsheetMapping";
import { StoreExportParser } from "@/components/sorter/StoreExportParser";
import { useToast } from "@/hooks/use-toast";
import {
  FileText,
  Loader2,
  Download,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  RotateCcw,
  Archive,
} from "lucide-react";
import {
  getSorterProcessFilesUrl,
  getSorterDownloadFileUrl,
  type SorterProcessInputPreset,
  type SorterProcessResult,
  type SorterOutputFile,
} from "@workspace/api-client-react";

async function triggerDownload(url: string, filename: string) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`Download failed (${response.status} ${response.statusText})`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

const PRESET_OPTIONS: { value: SorterProcessInputPreset; label: string }[] = [
  { value: "combine_labels", label: "Combine labels only" },
  { value: "sort_slips", label: "Sort packing slips (Style → Color → Size → Order #)" },
  { value: "sort_slips_name", label: "Sort packing slips (Style → Color → Size → Last Name)" },
  { value: "sort_slips_custom", label: "Sort packing slips (Style → Color → Size → Last Name → Custom Field)" },
  { value: "sort_slips_custom_first", label: "Sort packing slips (Custom Field → Last Name)" },
  { value: "sort_labels", label: "Sort labels to match sorted packing slips" },
  { value: "sort_both", label: "Sort both packing slips and labels" },
  { value: "match_labels", label: "Sort labels to existing packing slip order (no slip sorting)" },
  { value: "custom_sort", label: "Custom Sort (Build Your Own)" },
  { value: "required_field", label: "Sort packing slips (Required Field: Birth Year Oldest to Recent)" },
  { value: "split_required_field", label: "Create batches by Required Field (Birth Year)" },
  { value: "spreadsheet_sequence", label: "Sort slips & labels to spreadsheet sequence" },
  { value: "parse_store_export", label: "Parse store export (remove columns)" },
];

const NEEDS_SLIPS: SorterProcessInputPreset[] = [
  "sort_slips", "sort_slips_name", "sort_slips_custom", "sort_slips_custom_first",
  "sort_labels", "sort_both", "match_labels", "custom_sort", "required_field",
  "split_required_field", "spreadsheet_sequence",
];
const NEEDS_LABELS: SorterProcessInputPreset[] = [
  "combine_labels", "sort_labels", "sort_both", "match_labels", "spreadsheet_sequence",
];
const MAX_LABELS = 20;

const FIELD_LABELS: Record<string, string> = {
  first_name: "First Name", last_name: "Last Name", style: "Style", size: "Size",
  color: "Color", custom_field: "Custom Field", delivery_method: "Delivery Method",
  location: "Location", sort_number: "Sort #", order_number: "Order Number",
  order_date: "Order Date", required_field: "Required Field", birth_year: "Birth Year",
};
const fieldLabel = (f: string) =>
  FIELD_LABELS[f] ?? f.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

const isZip = (o: SorterOutputFile) =>
  o.key === "zip" || o.mime === "application/zip" || o.mime === "application/x-zip-compressed";

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

const sectionLabel = "text-xs font-semibold text-slate-300";
const helpText = "text-[11px] text-slate-500 leading-relaxed";

export default function LabelSorter() {
  const { toast } = useToast();
  const [preset, setPreset] = useState<SorterProcessInputPreset>("combine_labels");
  const [sortFields, setSortFields] = useState<string[]>([]);
  const [singleLineItemFirst, setSingleLineItemFirst] = useState(false);
  const [packingSlips, setPackingSlips] = useState<File[]>([]);
  const [labels, setLabels] = useState<File[]>([]);
  const [spreadsheet, setSpreadsheet] = useState<File[]>([]);
  const [spreadsheetInspection, setSpreadsheetInspection] = useState<InspectionState>({ status: "idle" });
  const [spreadsheetMapping, setSpreadsheetMapping] = useState<SpreadsheetColumnMapping | null>(null);
  const [storeExport, setStoreExport] = useState<File[]>([]);
  const [storeInspection, setStoreInspection] = useState<InspectionState>({ status: "idle" });
  const [additionalDropIndexes, setAdditionalDropIndexes] = useState<number[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SorterProcessResult | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  // Request tokens guard against stale inspection responses after replace/remove/reset.
  const spreadsheetToken = useRef(0);
  const storeToken = useRef(0);
  const spreadsheetAbort = useRef<AbortController | null>(null);
  const storeAbort = useRef<AbortController | null>(null);

  const needsPackingSlips = NEEDS_SLIPS.includes(preset);
  const needsLabels = NEEDS_LABELS.includes(preset);
  const needsSpreadsheet = preset === "spreadsheet_sequence";
  const needsStoreExport = preset === "parse_store_export";
  const supportsSingleLineItemFirst = needsPackingSlips && preset !== "match_labels";

  const clearSpreadsheet = () => {
    spreadsheetToken.current += 1;
    spreadsheetAbort.current?.abort();
    spreadsheetAbort.current = null;
    setSpreadsheet([]);
    setSpreadsheetMapping(null);
    setSpreadsheetInspection({ status: "idle" });
  };
  const clearStoreExport = () => {
    storeToken.current += 1;
    storeAbort.current?.abort();
    storeAbort.current = null;
    setStoreExport([]);
    setAdditionalDropIndexes([]);
    setStoreInspection({ status: "idle" });
  };

  const selectSpreadsheet = async (file: File) => {
    clearSpreadsheet();
    const token = spreadsheetToken.current;
    const ctrl = new AbortController();
    spreadsheetAbort.current = ctrl;
    setSpreadsheet([file]);
    setSpreadsheetInspection({ status: "pending" });
    try {
      const result = await inspectSpreadsheet(file, ctrl.signal);
      if (token !== spreadsheetToken.current) return;
      const mapping = suggestMapping(result);
      if (!mapping) throw new Error("The spreadsheet has no readable sheets.");
      setSpreadsheetMapping(mapping);
      setSpreadsheetInspection({ status: "ready", result });
    } catch (err) {
      if (token !== spreadsheetToken.current) return;
      setSpreadsheetInspection({ status: "error", message: errorMessage(err, "Could not read spreadsheet.") });
    }
  };

  const selectStoreExport = async (file: File) => {
    clearStoreExport();
    const token = storeToken.current;
    const ctrl = new AbortController();
    storeAbort.current = ctrl;
    setStoreExport([file]);
    setStoreInspection({ status: "pending" });
    try {
      const result = await inspectSpreadsheet(file, ctrl.signal);
      if (token !== storeToken.current) return;
      if ((result.sheets[0]?.rows[0] ?? []).length === 0) throw new Error("The CSV has no header row.");
      setStoreInspection({ status: "ready", result });
    } catch (err) {
      if (token !== storeToken.current) return;
      setStoreInspection({ status: "error", message: errorMessage(err, "Could not read CSV.") });
    }
  };

  const addLabels = (files: File[]) => {
    const room = MAX_LABELS - labels.length;
    if (room <= 0) {
      toast({ variant: "destructive", title: "Label limit reached", description: `Up to ${MAX_LABELS} label PDFs per job.` });
      return;
    }
    if (files.length > room) {
      toast({ variant: "destructive", title: "Some labels were skipped", description: `Up to ${MAX_LABELS} label PDFs per job. ${files.length - room} not added.` });
    }
    setLabels([...labels, ...files.slice(0, room)]);
  };

  const inspectionBlock: string | null = (() => {
    if (needsSpreadsheet) {
      if (spreadsheetInspection.status === "pending") return "Waiting for the spreadsheet to finish reading.";
      if (spreadsheetInspection.status === "error") return "The spreadsheet could not be read. Replace it before processing.";
    }
    if (needsStoreExport) {
      if (storeInspection.status === "pending") return "Waiting for the CSV to finish reading.";
      if (storeInspection.status === "error") return "The CSV could not be read. Replace it before processing.";
    }
    return null;
  })();

  const handleProcess = async () => {
    if (inspectionBlock) { setError(inspectionBlock); return; }
    if (needsPackingSlips && packingSlips.length === 0) { setError("Packing slips are required for this preset."); return; }
    if (needsLabels && labels.length === 0) { setError("Shipping labels are required for this preset."); return; }
    if (preset === "custom_sort" && sortFields.length === 0) { setError("Add at least one sort field before processing."); return; }
    if (needsSpreadsheet) {
      if (spreadsheet.length === 0 || !spreadsheetMapping || spreadsheetInspection.status !== "ready") {
        setError("Upload the sequence spreadsheet and map its order-number column.");
        return;
      }
      if (!spreadsheetMapping.order_number_column) { setError("Map the spreadsheet order-number column."); return; }
    }
    if (needsStoreExport && (storeExport.length === 0 || storeInspection.status !== "ready")) {
      setError("Upload a store export CSV.");
      return;
    }

    setError(null);
    setIsProcessing(true);
    setResults(null);

    try {
      const formData = new FormData();
      formData.append("preset", preset);
      if (supportsSingleLineItemFirst) formData.append("single_line_item_first", String(singleLineItemFirst));
      if (preset === "custom_sort") formData.append("sort_fields", JSON.stringify(sortFields));
      if (needsSpreadsheet && spreadsheet[0] && spreadsheetMapping) {
        formData.append("spreadsheet", spreadsheet[0]);
        formData.append("spreadsheet_mapping", JSON.stringify(spreadsheetMapping));
      }
      if (needsStoreExport && storeExport[0]) {
        formData.append("store_export", storeExport[0]);
        formData.append("remove_column_indexes", JSON.stringify(additionalDropIndexes));
      }
      if (needsPackingSlips && packingSlips[0]) formData.append("packing_slips", packingSlips[0]);
      if (needsLabels) labels.forEach((f) => formData.append("labels", f));

      const response = await fetch(getSorterProcessFilesUrl(), {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!response.ok) {
        let message = `Processing failed (${response.status})`;
        try {
          const body: unknown = await response.json();
          if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
            message = (body as { error: string }).error;
          }
        } catch {
          /* non-JSON error body */
        }
        throw new Error(message);
      }

      const result = (await response.json()) as SorterProcessResult;
      const normalized: SorterProcessResult = {
        jobId: result.jobId,
        outputs: Array.isArray(result.outputs) ? result.outputs : [],
        warnings: Array.isArray(result.warnings) ? result.warnings : [],
      };
      setResults(normalized);
      toast({
        title: normalized.warnings.length ? "Completed with warnings" : "Processing complete",
        description: normalized.warnings.length
          ? "Some selected sort fields could not be read. Review the warnings before using your files."
          : "Your files are ready for download.",
      });
    } catch (err) {
      const msg = errorMessage(err, "An unexpected error occurred during processing.");
      setError(msg);
      toast({ variant: "destructive", title: "Processing failed", description: msg });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReset = () => {
    setSingleLineItemFirst(false);
    setPackingSlips([]);
    setLabels([]);
    clearSpreadsheet();
    clearStoreExport();
    setResults(null);
    setError(null);
  };

  const download = (jobId: string, output: SorterOutputFile) => {
    setDownloading(output.key);
    triggerDownload(getSorterDownloadFileUrl(jobId, output.key), output.filename)
      .catch((err: unknown) =>
        toast({ variant: "destructive", title: "Download failed", description: errorMessage(err, "Could not download file.") }),
      )
      .finally(() => setDownloading(null));
  };

  const zipOutputs = results?.outputs.filter(isZip) ?? [];
  const fileOutputs = results?.outputs.filter((o) => !isZip(o)) ?? [];
  const nothingToReset =
    packingSlips.length === 0 && labels.length === 0 && spreadsheet.length === 0 &&
    storeExport.length === 0 && !results && !error;

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
            <FileText className="text-[#10b981]" size={24} />
            Label Sorter
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Sort and match packing slips with shipping labels, or clean common store exports.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl">
              <div className="px-5 py-4 border-b border-slate-800">
                <h2 className="text-sm font-bold text-white">Process Configuration</h2>
                <p className="text-xs text-slate-500 mt-0.5">Select a preset and upload your files</p>
              </div>
              <div className="p-5 space-y-5">
                <div className="space-y-2">
                  <label htmlFor="preset-select" className={sectionLabel}>Operation Preset</label>
                  <select
                    id="preset-select"
                    data-testid="select-preset"
                    value={preset}
                    disabled={isProcessing}
                    onChange={(e) => {
                      setPreset(e.target.value as SorterProcessInputPreset);
                      setError(null);
                    }}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2.5 focus:outline-none focus:border-[#059669]"
                  >
                    {PRESET_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {preset === "custom_sort" && (
                  <div className="space-y-2">
                    <div className={sectionLabel}>Sort Configuration</div>
                    <CustomSortBuilder value={sortFields} onChange={setSortFields} />
                  </div>
                )}

                {supportsSingleLineItemFirst && (
                  <div className="rounded-lg border border-slate-700 bg-slate-800/40 p-4 space-y-1.5">
                    <label className="flex items-center gap-3 text-sm font-medium text-slate-200 cursor-pointer">
                      <input
                        type="checkbox"
                        data-testid="checkbox-single-line-first"
                        className="h-4 w-4 accent-[#059669]"
                        checked={singleLineItemFirst}
                        onChange={(e) => setSingleLineItemFirst(e.target.checked)}
                        disabled={isProcessing}
                        aria-describedby="single-line-item-help"
                      />
                      Single-line-item orders first
                    </label>
                    <p id="single-line-item-help" className={helpText}>
                      Counts product rows across the whole order, not quantities or pages.
                      Single-line orders come first; both groups keep your selected sort.
                      {preset === "spreadsheet_sequence" && " Spreadsheet sequence is preserved within each group."}
                      {preset === "split_required_field" && " Applied separately inside each birth-year batch."}
                    </p>
                  </div>
                )}

                {needsPackingSlips && (
                  <div className="space-y-2">
                    <div className={sectionLabel}>Packing Slips (Single PDF)</div>
                    {preset === "split_required_field" && (
                      <p className={helpText}>
                        Creates one PDF per birth year, preserving source order within each priority group.
                      </p>
                    )}
                    {preset !== "match_labels" && (
                      <p className={helpText}>
                        Totals-only continuation pages are automatically consolidated when the summary fits.
                        Product pages stay intact. A downloadable report explains which slips were consolidated or kept.
                      </p>
                    )}
                    <FileDropzone
                      multiple={false}
                      files={packingSlips}
                      onFilesAccepted={(files) => files[0] && setPackingSlips([files[0]])}
                      onFileRemoved={() => setPackingSlips([])}
                      label="Only PDF files are supported"
                    />
                  </div>
                )}

                {needsSpreadsheet && (
                  <div className="space-y-2">
                    <div className={sectionLabel}>Sequence Spreadsheet</div>
                    <p className={helpText}>
                      Spreadsheet order numbers set the packing-slip sequence. Shipping labels are then matched to that reordered slip sequence.
                    </p>
                    <SpreadsheetMapping
                      files={spreadsheet}
                      onFileSelected={(f) => void selectSpreadsheet(f)}
                      onFileRemoved={clearSpreadsheet}
                      inspection={spreadsheetInspection}
                      mapping={spreadsheetMapping}
                      onMappingChange={setSpreadsheetMapping}
                      disabled={isProcessing}
                    />
                  </div>
                )}

                {needsStoreExport && (
                  <div className="space-y-2">
                    <div className={sectionLabel}>Store Export CSV</div>
                    <StoreExportParser
                      files={storeExport}
                      onFileSelected={(f) => void selectStoreExport(f)}
                      onFileRemoved={clearStoreExport}
                      inspection={storeInspection}
                      additionalDropIndexes={additionalDropIndexes}
                      onAdditionalDropIndexesChange={setAdditionalDropIndexes}
                      disabled={isProcessing}
                    />
                  </div>
                )}

                {needsLabels && (
                  <div className="space-y-2">
                    <div className="flex items-baseline justify-between">
                      <div className={sectionLabel}>Shipping Labels (Multiple PDFs)</div>
                      <span className="text-[11px] text-slate-500" data-testid="text-label-count">
                        {labels.length} / {MAX_LABELS}
                      </span>
                    </div>
                    <FileDropzone
                      multiple={true}
                      files={labels}
                      onFilesAccepted={addLabels}
                      onFileRemoved={(idx) => setLabels(labels.filter((_, i) => i !== idx))}
                      label={`Multiple PDF files are supported (up to ${MAX_LABELS})`}
                    />
                  </div>
                )}

                {error && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3" data-testid="status-error">
                    <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-xs font-bold text-red-400">Error</div>
                      <div className="text-xs text-red-300 mt-0.5">{error}</div>
                    </div>
                  </div>
                )}

                <div className="pt-4 flex items-center justify-end gap-3 border-t border-slate-800">
                  {inspectionBlock && (
                    <span className="mr-auto text-[11px] text-amber-400/90">{inspectionBlock}</span>
                  )}
                  <button
                    data-testid="button-reset"
                    onClick={handleReset}
                    disabled={isProcessing || nothingToReset}
                    className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-700 text-slate-300 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <RotateCcw size={13} />
                    Reset
                  </button>
                  <button
                    data-testid="button-process"
                    onClick={handleProcess}
                    disabled={isProcessing || inspectionBlock !== null}
                    className="flex items-center justify-center gap-2 w-40 px-4 py-2 text-xs font-semibold rounded-lg bg-[#059669] text-white hover:bg-[#047857] disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {isProcessing ? (<><Loader2 className="h-4 w-4 animate-spin" />Processing...</>) : "Process Files"}
                  </button>
                </div>
              </div>
            </div>

            {isProcessing && !results && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3 animate-pulse">
                <div className="h-4 w-48 rounded bg-slate-800" />
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="h-24 rounded-lg bg-slate-800/70" />
                  <div className="h-24 rounded-lg bg-slate-800/70" />
                </div>
              </div>
            )}

            {results && (
              <div className={`bg-slate-900 border rounded-xl overflow-hidden ${results.warnings.length ? "border-amber-500/30" : "border-[#059669]/30"}`} data-testid="card-results">
                <div className={`px-5 py-3.5 flex items-center border-b ${results.warnings.length ? "bg-amber-500/10 border-amber-500/20" : "bg-[#059669]/10 border-[#059669]/20"}`}>
                  {results.warnings.length ? (
                    <AlertTriangle className="h-5 w-5 text-amber-400 mr-3" />
                  ) : (
                    <CheckCircle2 className="h-5 w-5 text-[#10b981] mr-3" />
                  )}
                  <h3 className={`text-sm font-bold ${results.warnings.length ? "text-amber-300" : "text-[#10b981]"}`}>
                    {results.warnings.length ? "Completed with warnings - check sort order" : "Processing Successful"}
                  </h3>
                </div>
                <div className="p-5 space-y-5">
                  {results.warnings.length > 0 && (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4" data-testid="list-warnings">
                      <div className="text-xs font-bold text-amber-300">
                        Sort order may be unreliable ({results.warnings.length} {results.warnings.length === 1 ? "warning" : "warnings"})
                      </div>
                      <p className="text-[11px] text-slate-400 mt-1">
                        All orders were kept. No pages were discarded because of missing sort fields. Page numbers below refer to the original uploaded PDF, not the sorted output.
                      </p>
                      <ul className="mt-3 space-y-2 max-h-72 overflow-y-auto pr-1 custom-scrollbar">
                        {results.warnings.map((w, i) => (
                          <li key={i} className="rounded-md border border-slate-800 bg-slate-900 px-3 py-2" data-testid={`warning-${i}`}>
                            <div className="text-xs font-semibold text-slate-200 font-mono">
                              Source page{w.sourcePages.length === 1 ? "" : "s"} {w.sourcePages.join(", ") || "unknown"}
                              <span className="text-slate-500"> · </span>
                              {w.orderNumber ? `Order #${w.orderNumber}` : "Order number unreadable"}
                            </div>
                            {w.missingFields.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-1.5">
                                {w.missingFields.map((f) => (
                                  <span key={f} className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                                    Missing {fieldLabel(f)}
                                  </span>
                                ))}
                              </div>
                            )}
                            <p className="text-[11px] text-slate-400 mt-1.5">{w.message}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {zipOutputs.map((output) => (
                    <div key={output.key} className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border border-[#059669]/30 bg-[#059669]/5">
                      <Archive className="h-5 w-5 text-[#10b981] shrink-0" />
                      <div className="flex-1 min-w-0">
                        <h4 className="text-sm font-medium text-slate-100">{output.label}</h4>
                        <p className="text-xs text-slate-500 truncate" title={output.filename}>{output.filename}</p>
                      </div>
                      <button
                        data-testid={`button-download-${output.key}`}
                        disabled={downloading === output.key}
                        onClick={() => download(results.jobId, output)}
                        className="flex items-center justify-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-[#059669] text-white hover:bg-[#047857] disabled:opacity-60"
                      >
                        {downloading === output.key ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                        Download all
                      </button>
                    </div>
                  ))}

                  {results.outputs.length === 0 && (
                    <p className="text-xs text-slate-500 italic">The server returned no output files for this job.</p>
                  )}

                  <div className="grid gap-4 sm:grid-cols-2">
                    {fileOutputs.map((output) => (
                      <div key={output.key} className="flex flex-col justify-between p-4 bg-slate-800/60 rounded-lg border border-slate-700">
                        <div className="mb-4">
                          <h4 className="text-sm font-medium text-slate-200">{output.label}</h4>
                          <p className="text-xs text-slate-500 truncate mt-0.5" title={output.filename}>{output.filename}</p>
                        </div>
                        <button
                          data-testid={`button-download-${output.key}`}
                          disabled={downloading === output.key}
                          className="flex items-center justify-center gap-2 w-full px-4 py-2 text-xs font-semibold rounded-lg bg-[#059669] text-white hover:bg-[#047857] disabled:opacity-60"
                          onClick={() => download(results.jobId, output)}
                        >
                          {downloading === output.key ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                          Download
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
