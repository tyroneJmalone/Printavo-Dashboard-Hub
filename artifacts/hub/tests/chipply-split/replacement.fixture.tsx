import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProcessComparisons } from "../../src/components/chipply/ProcessComparison";
import type { ChipplyProcessComparison, ChipplySplitRequest } from "@workspace/api-client-react";

declare global { interface Window { splitRequests: ChipplySplitRequest[] } }
window.splitRequests = [];
const candidate = (invoiceId: string, visualId: number) => ({
  invoiceId, visualId, detailSyncedAt: null, sourceUpdatedAt: null,
  state: "different" as const, issues: [], oneSizeNotes: [], rows: [],
});
const initial: ChipplyProcessComparison = {
  processKey: "front", processNames: ["PRINT: Front"], state: "ambiguous",
  candidates: [candidate("a", 100), candidate("b", 200)], splitEvidence: "original", splitRevision: "original",
  splitReview: { id: "original", invoiceIds: ["a", "b"], action: "approve", state: "active",
    reason: "Original reviewed split", actor: "Fixture", createdAt: "2026-01-01" },
};
function Fixture() {
  const [group, setGroup] = useState(initial);
  return <>
    <button onClick={() => setGroup({ ...initial, splitEvidence: "changed", candidates: [candidate("a", 100), candidate("c", 300)],
      splitReview: { ...initial.splitReview!, state: "stale" } })}>Simulate candidate replacement</button>
    <button onClick={() => setGroup({ ...initial, splitEvidence: "changed", splitRevision: "revoked", candidates: [candidate("a", 100), candidate("c", 300)],
      splitReview: { ...initial.splitReview!, id: "revoked", state: "revoked", action: "revoke" } })}>Load revoked review</button>
    <ProcessComparisons comparisons={[group]} splitContext={{ snapshotId: "fixture", submit: async request => {
      window.splitRequests.push(request);
      if (request.invoiceIds.length !== 2 || !request.invoiceIds.includes("a") || !request.invoiceIds.includes("c"))
        throw new Error("Obsolete or incomplete selection");
      if (request.action === "approve") setGroup({ ...group, splitRevision: "replacement",
        splitReview: { ...group.splitReview!, id: "replacement", state: "active", action: "approve", invoiceIds: request.invoiceIds } });
      return { state: "matched", rows: [], issues: [], oneSizeNotes: [], eligible: true,
        actualMethod: "screenprint", invoices: [], evidence: "fixture-preview" };
    } }} />
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
