import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { parseXcRunner, xcTypeName } from "../../src/layout/parseXcRunner.js";
import { dominantTypes, type PairFixture } from "../../scripts/capture-xc-type-pairs.js";

const url = new URL("../fixtures/xcrunner/type-pairs.json", import.meta.url);
const SCREENS = [
  "quick-feed",
  "quick-search-keyboard",
  "att-alert",
  "contacts-new-form",
  "contacts-keyboard",
  "settings-root",
  "settings-switches",
  "settings-slider",
];
// Never emitted as elements, so parse cannot show their names.
const CONTAINERS = new Set([2, 4, 25, 47]);

describe("XC_TYPE_NAMES agrees with what axe emits for the same element", () => {
  it("has a captured fixture", () => {
    expect(
      existsSync(url),
      "test/fixtures/xcrunner/type-pairs.json is missing — capture it with scripts/capture-xc-type-pairs.ts (Task 8, Step 9)",
    ).toBe(true);
  });
  if (!existsSync(url)) return;

  const fx = JSON.parse(readFileSync(url, "utf8")) as PairFixture;
  const dominant = dominantTypes(fx);

  it("was captured on every screen the plan lists", () => {
    expect([...fx.meta.screens].sort()).toEqual([...SCREENS].sort());
  });

  it("pairs the types every screen has", () => {
    expect(dominant.get(9)?.axeType).toBe("Button");
    expect(dominant.get(48)?.axeType).toBe("StaticText");
  });

  it.each(fx.pairs.map((p) => [p.elementType, p.axeType, p.count] as const))(
    "elementType %i, paired with axe %s ×%i, parses to axe's name",
    (t) => {
      // An elementType axe names two ways cannot match every pair; the table
      // follows the majority (dominantTypes), so every pair of t expects that name.
      const want = dominant.get(t)!.axeType;
      expect(xcTypeName(t)).toBe(want);
      if (CONTAINERS.has(t)) return;
      const [el] = parseXcRunner({
        axElement: {
          elementType: 2,
          frame: { X: 0, Y: 0, Width: 402, Height: 874 },
          children: [{ elementType: t, label: "probe", frame: { X: 10, Y: 10, Width: 20, Height: 20 } }],
        },
        depth: 2,
      });
      expect(el.type).toBe(want);
    },
  );
});
