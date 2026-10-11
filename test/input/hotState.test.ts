import { describe, it, expect, beforeEach } from "vitest";
import { recordTouch, hotNotice, resetHotState } from "../../src/input/hotState.js";

describe("hotState", () => {
  beforeEach(() => resetHotState());

  it("says nothing while touches are fast", () => {
    recordTouch("U", 1200);
    recordTouch("U", 900);
    expect(hotNotice("U")).toBeUndefined();
  });

  it("names the cost and the cheaper routes once a touch is slow", () => {
    recordTouch("U", 19000);
    const n = hotNotice("U");
    expect(n).toMatch(/19s/);
    expect(n).toMatch(/via: "js" on tap\/type_text\/scroll_to/);
    expect(n).toMatch(/open_url/);
    // scroll_to's OS fallback is a swipe — touch delivery — so it must only be
    // listed as unaffected under the same via:"js" qualifier as tap/type_text,
    // never as an unconditionally safe route on its own.
    expect(n).not.toMatch(/,\s*scroll_to\s*,/);
  });

  it("issues the notice only once per device", () => {
    recordTouch("U", 19000);
    expect(hotNotice("U")).toBeDefined();
    recordTouch("U", 21000);
    expect(hotNotice("U")).toBeUndefined();
  });

  it("tracks devices separately", () => {
    recordTouch("A", 19000);
    expect(hotNotice("A")).toBeDefined();
    expect(hotNotice("B")).toBeUndefined();
  });
});
