import { singleOrderDetailQuery } from "@workspace/printavo";

/** Printavo names its production due date dueAt; productionDueAt is our alias. */
export function workorderDetailQuery(kind: "invoice" | "quote", id: string): string {
  return singleOrderDetailQuery(kind, id).replace(
    /visualId\b/,
    "visualId workorderUrl nickname customerDueAt productionDueAt: dueAt",
  );
}
