import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePreviewChipplyCategories, useCommitChipplyCategories, type ChipplyOfficialCategory } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { selectionCounts, type CategorySelection } from "./categorySelection";

export const categoryInputClass = "rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100";
export function categoryError(error: unknown) {
  const message = (error as { data?: { error?: string } })?.data?.error;
  if (message) return message;
  return error instanceof Error ? error.message : "Request failed. Refresh and try again.";
}

export function CategoryReviewDialog({ selections, categories, onClose, onWritten, initialOverwrite = false }: {
  initialOverwrite?: boolean;
  selections: CategorySelection[];
  categories: ChipplyOfficialCategory[];
  onClose: () => void;
  onWritten: () => void;
}) {
  const client = useQueryClient();
  const [overwrite, setOverwrite] = useState(initialOverwrite);
  const [targetCategoryId, setTargetCategoryId] = useState("");
  const [attempted, setAttempted] = useState(false);
  const writeLock = useRef(false);
  const counts = selectionCounts(selections);
  const preview = usePreviewChipplyCategories({ mutation: { retry: false } });
  const commit = useCommitChipplyCategories({ mutation: {
    retry: false,
    onSettled: () => {
      // Include invoice/store/detail caches: the server may have written even when the response was lost.
      void client.invalidateQueries();
      onWritten();
    },
  } });
  function resetPreview() { preview.reset(); }
  const eligible = preview.data?.lines.filter((line) => line.eligible).length ?? 0;
  return <Dialog open onOpenChange={(open) => { if (!open && !commit.isPending) onClose(); }}>
    <DialogContent className="max-h-[90vh] overflow-y-auto bg-slate-900 border-slate-700 text-slate-100 sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>Review category changes</DialogTitle>
        <DialogDescription className="text-slate-400">Only your {counts.lines} selected product lines across {counts.invoices} invoices are included. Preview makes no external changes.</DialogDescription>
      </DialogHeader>
      {overwrite && <p role="alert" data-testid="text-category-overwrite-warning" className="rounded border border-amber-800 bg-amber-950/40 p-2 text-sm text-amber-200">Overwrite mode: existing nonempty categories on the {counts.lines} selected lines across {counts.invoices} invoices may be replaced. Nothing changes until you preview and confirm.</p>}
      {!attempted && <div className="space-y-3">
        <label className="block text-sm">Target category
          <select data-testid="select-category-target" className={`${categoryInputClass} mt-1 w-full`} value={targetCategoryId} disabled={preview.isPending} onChange={(event) => { setTargetCategoryId(event.target.value); resetPreview(); }}>
            <option value="">Use each invoice’s status recommendation</option>
            {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
          </select>
        </label>
        <label className="flex gap-2 items-start text-sm">
          <input data-testid="checkbox-category-overwrite" type="checkbox" checked={overwrite} disabled={preview.isPending} onChange={(event) => { setOverwrite(event.target.checked); resetPreview(); }} />
          Replace existing nonempty categories (off by default)
        </label>
        <Button data-testid="button-preview-categories" disabled={preview.isPending} onClick={() => preview.mutate({ data: { selections, overwrite, ...(targetCategoryId ? { targetCategoryId } : {}) } })}>{preview.isPending ? "Building preview…" : "Preview selected lines"}</Button>
      </div>}
      {preview.error && <p role="alert" className="text-red-300">{categoryError(preview.error)}</p>}
      {preview.data && <div className="space-y-3">
        <p data-testid="text-category-preview-count" className="text-sm">{eligible} eligible changes · expires {new Date(preview.data.expiresAt).toLocaleString()}</p>
        <div className="overflow-auto max-h-80 rounded-lg border border-slate-700">
          <table className="w-full text-xs text-left"><thead className="text-slate-400"><tr><th className="p-2">Invoice / line</th><th>Status</th><th>Current → target</th><th>Review</th></tr></thead>
            <tbody>{preview.data.lines.map((line) => <tr key={`${line.orderId}:${line.lineItemId}`} className="border-t border-slate-800">
              <td className="p-2">{line.orderId} / {line.lineItemId}</td><td>{line.statusName ?? "Unknown"}</td>
              <td>{line.currentCategoryName ?? "Missing"} → {line.recommendedCategoryName ?? "No recommendation"}</td>
              <td className="p-2">{line.eligible ? "Will update" : "Skip"}: {line.message}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {!attempted && <Button data-testid="button-confirm-category-write" className="bg-emerald-700 hover:bg-emerald-600" disabled={!eligible || commit.isPending || Date.parse(preview.data.expiresAt) <= Date.now()} onClick={() => {
          if (writeLock.current || !preview.data) return;
          writeLock.current = true;
          setAttempted(true);
          commit.mutate({ data: { previewId: preview.data.previewId } });
        }}>Confirm {eligible} changes in Printavo</Button>}
      </div>}
      {commit.isPending && <p role="status">Applying changes. Please keep this review open…</p>}
      {commit.error && <p role="alert" className="text-amber-300">Result uncertain: {categoryError(commit.error)}. Do not retry blindly. Refresh these invoices and verify their categories in Printavo before preparing a new review.</p>}
      {commit.data && <div data-testid="text-category-results" className="space-y-2">
        <h3 className="font-semibold">Results: {commit.data.updated} updated · {commit.data.failed} failed</h3>
        <p className="text-sm text-slate-300">
          {commit.data.results.filter((result) => result.outcome === "skipped").length} skipped ·{" "}
          {commit.data.results.filter((result) => result.outcome === "conflict").length} conflicts ·{" "}
          {commit.data.results.filter((result) => result.outcome === "unknown").length} unknown
        </p>
        <p className="text-sm text-slate-400">Skipped lines were not changed. For failed or unknown outcomes, verify the current category in Printavo before selecting the line again. No automatic retries are performed.</p>
        {commit.data.results.map((result) => <p key={`${result.orderId}:${result.lineItemId}`} className="text-sm"><strong>{result.outcome}</strong> · invoice {result.orderId}, line {result.lineItemId}: {result.message}</p>)}
      </div>}
      <Button data-testid="button-close-category-review" variant="outline" disabled={commit.isPending} onClick={onClose}>{attempted ? "Close results" : "Cancel"}</Button>
    </DialogContent>
  </Dialog>;
}