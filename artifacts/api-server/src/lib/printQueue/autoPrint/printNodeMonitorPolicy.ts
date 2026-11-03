export interface NodeObservation {
  state: string;
  message: string | null;
  observedAt: string;
  checkedAt: string;
  terminal: boolean;
}

/** PrintNode returns an array of state-history arrays, not one flat job list. */
export function parsePrintNodeStates(raw: unknown, ids: string[], now: Date): Map<string, NodeObservation> {
  if (!Array.isArray(raw) || raw.some(group => !Array.isArray(group))) throw new Error("Unexpected PrintNode state response");
  const result = new Map<string, NodeObservation>();
  for (const item of raw.flat()) {
    if (!item || typeof item !== "object" || typeof item.state !== "string" ||
      !Number.isSafeInteger(item.printJobId) || !Number.isFinite(Date.parse(item.createTimestamp))) {
      throw new Error("Invalid PrintNode state record");
    }
    const id = String(item.printJobId);
    if (!ids.includes(id)) continue;
    const observation: NodeObservation = {
      state: item.state, message: typeof item.message === "string" ? item.message.slice(0, 2000) : null,
      observedAt: new Date(item.createTimestamp).toISOString(), checkedAt: now.toISOString(),
      terminal: ["done", "error", "expired"].includes(item.state),
    };
    const previous = result.get(id);
    if (!previous || observation.observedAt >= previous.observedAt) result.set(id, observation);
  }
  return result;
}

export function printNodeProblem(state: string): boolean {
  return state === "error" || state === "expired";
}
