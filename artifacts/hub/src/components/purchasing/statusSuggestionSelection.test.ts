import test from "node:test";
import assert from "node:assert/strict";
import {
  createSuggestionInFlightGuard,
  reconcileSuggestionSelection,
  selectedSuggestionIds,
} from "./statusSuggestionSelection.ts";

test("defaults all initial and newly arrived suggestions to selected", () => {
  assert.deepEqual(
    [...reconcileSuggestionSelection(new Set(), [], ["a", "b"])],
    ["a", "b"],
  );
  assert.deepEqual(
    [...reconcileSuggestionSelection(new Set(["a"]), ["a", "b"], ["a", "b", "c"])],
    ["a", "c"],
  );
});

test("preserves individual deselection while polling the same suggestions", () => {
  assert.deepEqual(
    [...reconcileSuggestionSelection(new Set(["a"]), ["a", "b"], ["a", "b"])],
    ["a"],
  );
});

test("batch targets include selected suggestions only", () => {
  assert.deepEqual(
    selectedSuggestionIds(["a", "b", "c"], new Set(["a", "c"])),
    ["a", "c"],
  );
});

test("shared in-flight guard synchronously rejects duplicate row/batch work", () => {
  const guard = createSuggestionInFlightGuard();
  assert.equal(guard.acquire("a"), true);
  assert.equal(guard.acquire("a"), false);
  assert.equal(guard.has("a"), true);
  guard.release("a");
  assert.equal(guard.acquire("a"), true);
});