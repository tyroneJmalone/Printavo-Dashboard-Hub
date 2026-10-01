import test from "node:test";
import assert from "node:assert/strict";
import { leadingInkNumber, sortPlateLayers } from "./plateLayerOrder.ts";

test("recognizes only leading ink numbers, including whitespace and zero padding", () => {
  assert.equal(leadingInkNumber("1 White"), 1);
  assert.equal(leadingInkNumber("  02 - Red"), 2);
  assert.equal(leadingInkNumber("10.Blue"), 10);
  assert.equal(leadingInkNumber("PMS 186"), null);
  assert.equal(leadingInkNumber("White 2"), null);
  assert.equal(leadingInkNumber(""), null);
});

test("a single board sorts 1, 2, 10 numerically without mutating its plates", () => {
  const layers = [
    { ink: "10 Black", abIndex: 1 },
    { ink: "2 Red", abIndex: 1 },
    { ink: "1 White", abIndex: 1 }
  ];
  const original = [...layers];
  assert.deepEqual(sortPlateLayers(layers).map(p => p.ink), ["1 White", "2 Red", "10 Black"]);
  assert.deepEqual(layers, original);
  assert.equal(sortPlateLayers(layers)[0], layers[2]);
});

test("all-stacked order is global across boards, not grouped by board index", () => {
  const layers = [
    { ink: "10 Black", abIndex: 1 },
    { ink: "2 Red", abIndex: 1 },
    { ink: "1 White", abIndex: 3 },
    { ink: "3 Blue", abIndex: 2 }
  ];
  assert.deepEqual(sortPlateLayers(layers).map(p => [p.abIndex, p.ink]), [
    [3, "1 White"], [1, "2 Red"], [2, "3 Blue"], [1, "10 Black"]
  ]);
  assert.deepEqual(sortPlateLayers(layers.filter(p => p.abIndex === 1)).map(p => p.ink), [
    "2 Red", "10 Black"
  ]);
});

test("underbase remains below every regular ink regardless of its number or board", () => {
  const layers = [
    { ink: "1 White", abIndex: 1, abBase: false },
    { ink: "Underbase", abIndex: 4, abBase: true },
    { ink: "20 Underbase", abIndex: 3, abBase: true },
    { ink: "2 Red", abIndex: 2, abBase: false },
    { ink: "10 Underbase", abIndex: 5, abBase: true }
  ];
  assert.deepEqual(sortPlateLayers(layers).map(p => p.ink), [
    "10 Underbase", "20 Underbase", "Underbase", "1 White", "2 Red"
  ]);
});

test("unnumbered inks follow numbered inks using deterministic case-insensitive name order", () => {
  const layers = [
    { ink: "White 1", abIndex: 1 },
    { ink: "PMS 186", abIndex: 2 },
    { ink: "blue", abIndex: 1 },
    { ink: "10 Black", abIndex: 1 },
    { ink: "Amber", abIndex: 1 }
  ];
  assert.deepEqual(sortPlateLayers(layers).map(p => p.ink), [
    "10 Black", "Amber", "blue", "PMS 186", "White 1"
  ]);
});

test("equal numbers use numeric board order and preserve source order within a board", () => {
  const layers = [
    { ink: "2 Black", abIndex: 10 },
    { ink: "02 White", abIndex: 2 },
    { ink: "2 Blue", abIndex: 2 },
    { ink: "2 Red", abIndex: 1 }
  ];
  assert.deepEqual(sortPlateLayers(layers).map(p => p.ink), [
    "2 Red", "02 White", "2 Blue", "2 Black"
  ]);
  assert.deepEqual(sortPlateLayers(sortPlateLayers(layers)), sortPlateLayers(layers));
});

test("equal unnumbered names use board/source order and empty stacks are safe", () => {
  const layers = [
    { ink: "White", abIndex: 10, src: "a.svg" },
    { ink: "White", abIndex: 2, src: "b.svg" },
    { ink: "White", abIndex: 2, src: "c.svg" }
  ];
  assert.deepEqual(sortPlateLayers(layers).map(p => p.src), ["b.svg", "c.svg", "a.svg"]);
  assert.deepEqual(sortPlateLayers([]), []);
});