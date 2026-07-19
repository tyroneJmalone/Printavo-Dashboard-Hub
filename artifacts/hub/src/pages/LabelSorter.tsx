import { useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { FileDropzone } from "@/components/sorter/FileDropzone";
import { CustomSortBuilder } from "@/components/sorter/CustomSortBuilder";
import { useToast } from "@/hooks/use-toast";
import {
  FileText,
  Loader2,
  Download,
  AlertCircle,
  CheckCircle2,
  RotateCcw,
} from "lucide-react";
import type {
  SorterProcessInputPreset,
  SorterOutputFile,
} from "@workspace/api-client-react";

async function triggerDownload(url: string, filename: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

const PRESET_OPTIONS: { value: SorterProcessInputPreset; label: string }[] = [
  { value: "combine_labels", label: "Combine labels only" },
  { value: "sort_slips", label: "Sort packing slips (Style → Color → Size → Order #)" },
  { value: "sort_slips_name", label: "Sort packing slips (Style → Color → Size → Last Name)" },
  {
    value: "sort_slips_custom",
    label: "Sort packing slips (Style → Color → Size → Last Name → Custom Field)",
  },
  { value: "sort_slips_custom_first", label: "Sort packing slips (Custom Field → Last Name)" },
  { value: "sort_labels", label: "Sort labels to match sorted packing slips" },
  { value: "sort_both", label: "Sort both packing slips and labels" },
  {
    value: "match_labels",
    label: "Sort labels to existing packing slip order (no slip sorting)",
  },
  { value: "custom_sort", label: "Custom Sort (Build Your Own)" },
];

const NEEDS_SLIPS: SorterProcessInputPreset[] = [
  "sort_slips",
  "sort_slips_name",
  "sort_slips_custom",
  "sort_slips_custom_first",
  "sort_labels",
  "sort_both",
  "match_labels",
  "custom_sort",
];

const NEEDS_LABELS: SorterProcessInputPreset[] = [
  "combine_labels",
  "sort_labels",
  "sort_both",
  "match_labels",
];

export default function LabelSorter() {
  const { toast } = useToast();
  const [preset, setPreset] = useState<SorterProcessInputPreset>("combine_labels");
  const [sortFields, setSortFields] = useState<string[]>([]);
  const [packingSlips, setPackingSlips] = useState<File[]>([]);
  const [labels, setLabels] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{
    jobId: string;
    outputs: SorterOutputFile[];
  } | null>(null);

  const needsPackingSlips = NEEDS_SLIPS.includes(preset);
  const needsLabels = NEEDS_LABELS.includes(preset);

  const handleProcess = async () => {
    if (needsPackingSlips && packingSlips.length === 0) {
      setError("Packing slips are required for this preset.");
      return;
    }
    if (needsLabels && labels.length === 0) {
      setError("Shipping labels are required for this preset.");
      return;
    }
    if (preset === "custom_sort" && sortFields.length === 0) {
      setError("Add at least one sort field before processing.");
      return;
    }

    setError(null);
    setIsProcessing(true);
    setResults(null);

    try {
      const formData = new FormData();
      formData.append("preset", preset);

      if (preset === "custom_sort") {
        formData.append("sort_fields", JSON.stringify(sortFields));
      }

      if (needsPackingSlips && packingSlips[0]) {
        formData.append("packing_slips", packingSlips[0]);
      }

      if (needsLabels) {
        labels.forEach((f) => formData.append("labels", f));
      }

      const response = await fetch("/api/sorter/process", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!response.ok) {
        let message = "Processing failed";
        try {
          const err = await response.json();
          message = err.error || message;
        } catch {
          /* non-JSON error body */
        }
        throw new Error(message);
      }

      const result = await response.json();
      setResults(result);
      toast({
        title: "Processing complete",
        description: "Your files are ready for download.",
      });
    } catch (err: any) {
      setError(err.message || "An unexpected error occurred during processing.");
      toast({
        variant: "destructive",
        title: "Processing failed",
        description: err.message || "An unexpected error occurred.",
      });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReset = () => {
    setPackingSlips([]);
    setLabels([]);
    setResults(null);
    setError(null);
  };

  return (
    <AppShell>
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 bg-[#020617] border-b border-slate-800 px-6 py-4">
          <h1 className="text-xl font-bold text-white flex items-center gap-2 tracking-tight">
            <FileText className="text-[#10b981]" size={24} />
            Label Sorter
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Sort, combine, and match Printavo packing slips with shipping labels.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-6 custom-scrollbar">
          <div className="max-w-3xl mx-auto space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl">
              <div className="px-5 py-4 border-b border-slate-800">
                <h2 className="text-sm font-bold text-white">Process Configuration</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Select a preset and upload your files
                </p>
              </div>
              <div className="p-5 space-y-5">
                <div className="space-y-2">
                  <label
                    htmlFor="preset-select"
                    className="text-xs font-semibold text-slate-300"
                  >
                    Operation Preset
                  </label>
                  <select
                    id="preset-select"
                    value={preset}
                    onChange={(e) => {
                      setPreset(e.target.value as SorterProcessInputPreset);
                      setError(null);
                    }}
                    className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-sm rounded-lg px-3 py-2.5 focus:outline-none focus:border-[#059669]"
                  >
                    {PRESET_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {preset === "custom_sort" && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-slate-300">
                      Sort Configuration
                    </div>
                    <CustomSortBuilder value={sortFields} onChange={setSortFields} />
                  </div>
                )}

                {needsPackingSlips && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-slate-300">
                      Packing Slips (Single PDF)
                    </div>
                    <FileDropzone
                      multiple={false}
                      files={packingSlips}
                      onFilesAccepted={(files) => setPackingSlips([files[0]])}
                      onFileRemoved={() => setPackingSlips([])}
                      label="Only PDF files are supported"
                    />
                  </div>
                )}

                {needsLabels && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold text-slate-300">
                      Shipping Labels (Multiple PDFs)
                    </div>
                    <FileDropzone
                      multiple={true}
                      files={labels}
                      onFilesAccepted={(files) => setLabels([...labels, ...files])}
                      onFileRemoved={(idx) =>
                        setLabels(labels.filter((_, i) => i !== idx))
                      }
                      label="Multiple PDF files are supported"
                    />
                  </div>
                )}

                {error && (
                  <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3">
                    <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />
                    <div>
                      <div className="text-xs font-bold text-red-400">Error</div>
                      <div className="text-xs text-red-300 mt-0.5">{error}</div>
                    </div>
                  </div>
                )}

                <div className="pt-4 flex items-center justify-end gap-3 border-t border-slate-800">
                  <button
                    onClick={handleReset}
                    disabled={
                      isProcessing ||
                      (packingSlips.length === 0 && labels.length === 0 && !results)
                    }
                    className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-700 text-slate-300 hover:text-slate-100 hover:bg-slate-800 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    <RotateCcw size={13} />
                    Reset
                  </button>
                  <button
                    onClick={handleProcess}
                    disabled={isProcessing}
                    className="flex items-center justify-center gap-2 w-40 px-4 py-2 text-xs font-semibold rounded-lg bg-[#059669] text-white hover:bg-[#047857] disabled:opacity-50 disabled:pointer-events-none"
                  >
                    {isProcessing ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Processing...
                      </>
                    ) : (
                      "Process Files"
                    )}
                  </button>
                </div>
              </div>
            </div>

            {results && (
              <div className="bg-slate-900 border border-[#059669]/30 rounded-xl overflow-hidden">
                <div className="bg-[#059669]/10 px-5 py-3.5 flex items-center border-b border-[#059669]/20">
                  <CheckCircle2 className="h-5 w-5 text-[#10b981] mr-3" />
                  <h3 className="text-sm font-bold text-[#10b981]">
                    Processing Successful
                  </h3>
                </div>
                <div className="p-5">
                  <div className="grid gap-4 sm:grid-cols-2">
                    {results.outputs.map((output) => {
                      const downloadUrl = `/api/sorter/jobs/${results.jobId}/files/${output.key}`;
                      return (
                        <div
                          key={output.key}
                          className="flex flex-col justify-between p-4 bg-slate-800/60 rounded-lg border border-slate-700"
                        >
                          <div className="mb-4">
                            <h4 className="text-sm font-medium text-slate-200">
                              {output.label}
                            </h4>
                            <p
                              className="text-xs text-slate-500 truncate mt-0.5"
                              title={output.filename}
                            >
                              {output.filename}
                            </p>
                          </div>
                          <button
                            className="flex items-center justify-center gap-2 w-full px-4 py-2 text-xs font-semibold rounded-lg bg-[#059669] text-white hover:bg-[#047857]"
                            onClick={() =>
                              triggerDownload(downloadUrl, output.filename).catch(
                                (err) =>
                                  toast({
                                    variant: "destructive",
                                    title: "Download failed",
                                    description: err.message,
                                  }),
                              )
                            }
                          >
                            <Download className="h-4 w-4" />
                            Download
                          </button>
                        </div>
                      );
                    })}
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
