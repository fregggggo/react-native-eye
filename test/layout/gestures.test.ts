import { describe, it, expect } from "vitest";
import { swipeVector } from "../../src/layout/gestures.js";

describe("swipeVector", () => {
  it("scales to the viewport instead of using fixed coordinates", () => {
    // On a 1080x2400 Android screen the old constants (200,500 → 200,150) were a
    // short stroke in the top-left corner.
    const [x1, y1, x2, y2] = swipeVector("up", { x: 0, y: 0, w: 1080, h: 2400 });
    expect(x1).toBe(540);
    expect(x2).toBe(540);
    expect(y1).toBeGreaterThan(1200);
    expect(y2).toBeLessThan(1200);
  });

  it("swipes up from lower to upper and down the other way", () => {
    const vp = { x: 0, y: 0, w: 400, h: 800 };
    const up = swipeVector("up", vp);
    const down = swipeVector("down", vp);
    expect(up[1]).toBeGreaterThan(up[3]);
    expect(down[1]).toBeLessThan(down[3]);
  });

  it("moves horizontally for left/right", () => {
    const vp = { x: 0, y: 0, w: 400, h: 800 };
    const left = swipeVector("left", vp);
    expect(left[1]).toBe(left[3]);
    expect(left[0]).toBeGreaterThan(left[2]);
    const right = swipeVector("right", vp);
    expect(right[0]).toBeLessThan(right[2]);
  });

  it("falls back to sane coordinates when the screen size is unknown", () => {
    const v = swipeVector("up");
    expect(v.every((n) => Number.isFinite(n) && n > 0)).toBe(true);
  });

  it("respects a viewport that does not start at the origin", () => {
    const [x1] = swipeVector("up", { x: 100, y: 0, w: 200, h: 400 });
    expect(x1).toBe(200);
  });
});
