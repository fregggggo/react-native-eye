import { describe, it, expect } from "vitest";
import { flattenAxe, flattenRunner, pairNodes, mergePairs } from "../../scripts/capture-xc-type-pairs.js";

const f = (X: number, Y: number, Width: number, Height: number) => ({ X, Y, Width, Height });

const AXE = [
  {
    type: "Application",
    AXLabel: "App",
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [
      {
        type: "Group",
        AXLabel: null,
        frame: { x: 0, y: 0, width: 402, height: 874 },
        children: [
          { type: "Button", AXLabel: "Allow", frame: { x: 57, y: 577.67, width: 288, height: 48 }, children: [] },
          { type: "StaticText", AXLabel: "Title", frame: { x: 71, y: 371.33, width: 260, height: 64.33 }, children: [] },
          { type: "GenericElement", AXLabel: null, frame: { x: 10, y: 10, width: 5, height: 5 }, children: [] },
          { type: "GenericElement", AXLabel: null, frame: { x: 10, y: 10, width: 5, height: 5 }, children: [] },
        ],
      },
    ],
  },
];

const RUNNER = {
  axElement: {
    elementType: 2,
    label: "App",
    frame: f(0, 0, 402, 874),
    children: [
      {
        elementType: 4,
        label: "",
        frame: f(0, 0, 402, 874),
        children: [
          { elementType: 9, label: "Allow", frame: f(57, 577.6666666666667, 288, 48) },
          { elementType: 48, label: "Title", frame: f(71, 371.33333333333337, 260, 64.33333333333331) },
          { elementType: 1, label: "", frame: f(10, 10, 5, 5) },
        ],
      },
    ],
  },
  depth: 3,
};

describe("capture-xc-type-pairs pairing", () => {
  it("pairs labelled nodes whose frames agree within 0.5pt, both ways uniquely", () => {
    expect(pairNodes(flattenAxe(AXE), flattenRunner(RUNNER))).toEqual([
      { elementType: 2, axeType: "Application" },
      { elementType: 9, axeType: "Button" },
      { elementType: 48, axeType: "StaticText" },
    ]);
  });

  it("never pairs unlabelled containers, which neither parser emits as elements", () => {
    const pairs = pairNodes(flattenAxe(AXE), flattenRunner(RUNNER));
    expect(pairs.some((p) => p.elementType === 4 || p.elementType === 1)).toBe(false);
  });

  it("skips a frame that differs by more than the tolerance", () => {
    const moved = structuredClone(RUNNER);
    moved.axElement.children[0].children[0].frame = f(57, 579, 288, 48);
    expect(pairNodes(flattenAxe(AXE), flattenRunner(moved)).some((p) => p.elementType === 9)).toBe(false);
  });

  it("ignores scroll bars, which neither parser emits (XCUI Other vs axe Slider)", () => {
    const axe = [{ type: "Slider", AXLabel: "Vertical scroll bar, 4 pages", AXValue: "0%", frame: { x: 390, y: 0, width: 30, height: 800 } }];
    const runner = { axElement: { elementType: 1, label: "Vertical scroll bar, 4 pages", value: "0%", frame: f(390, 0, 30, 800) } };
    expect(pairNodes(flattenAxe(axe), flattenRunner(runner))).toEqual([]);
  });

  it("merges counts into an existing fixture and records the screen once", () => {
    const merged = mergePairs(
      { meta: { screens: ["a"], updatedAt: "x" }, pairs: [{ elementType: 9, axeType: "Button", count: 2 }] },
      [
        { elementType: 9, axeType: "Button" },
        { elementType: 48, axeType: "StaticText" },
      ],
      "a",
    );
    expect(merged.meta.screens).toEqual(["a"]);
    expect(merged.pairs).toEqual([
      { elementType: 9, axeType: "Button", count: 3 },
      { elementType: 48, axeType: "StaticText", count: 1 },
    ]);
  });
});
