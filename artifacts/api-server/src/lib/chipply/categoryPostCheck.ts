/** A bounded exception for missing-only category setters, never creates or prints.
 * Caller holds the line advisory lock and owns the durable review claim.
 * Printavo has no compare-and-set: staff must avoid concurrent upstream edits.
 */
export async function postCheckCategory<T>(deps: {
  read: () => Promise<T>;
  categoryId: (line: T) => string | null;
  validate: (line: T) => string | null;
  targetId: string;
  claimRetry: () => Promise<boolean>;
  retry: (line: T) => Promise<void>;
}): Promise<{ outcome: "updated" | "unknown" | "conflict"; message: string }> {
  try {
    const live = await deps.read();
    const conflict = deps.validate(live);
    if (conflict) return { outcome: "conflict", message: conflict };
    if (deps.categoryId(live) === deps.targetId) return { outcome: "updated", message: "Category confirmed by targeted post-check; no retry needed." };
    if (deps.categoryId(live) !== null) return { outcome: "conflict", message: "A different category is assigned; it was not overwritten." };
    if (!await deps.claimRetry()) return { outcome: "unknown", message: "Category retry could not be claimed; held for manual review." };
    // Read again after the durable claim, immediately before the only retry.
    const fresh = await deps.read();
    const changed = deps.validate(fresh);
    if (changed) return { outcome: "conflict", message: changed };
    if (deps.categoryId(fresh) === deps.targetId) return { outcome: "updated", message: "Category confirmed before retry; no additional write needed." };
    if (deps.categoryId(fresh) !== null) return { outcome: "conflict", message: "A different category is assigned; it was not overwritten." };
    try { await deps.retry(fresh); } catch { /* Never loop: verify the outcome once. */ }
    const after = await deps.read();
    const finalConflict = deps.validate(after);
    if (finalConflict) return { outcome: "conflict", message: finalConflict };
    if (deps.categoryId(after) === deps.targetId) return { outcome: "updated", message: "Category confirmed by post-check after one controlled retry." };
    return { outcome: "unknown", message: "Category still unconfirmed after one controlled retry; manual review required." };
  } catch {
    return { outcome: "unknown", message: "Category post-check could not verify live data; held for manual review. No further retry allowed." };
  }
}
