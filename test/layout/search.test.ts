import { describe, it, expect } from "vitest";
import { searchElements, elementAtPoint } from "../../src/layout/search.js";
import { toElements } from "../../src/layout/elements.js";

const els = toElements([
  { text: "Login", testID: "login-btn", type: "Button", x: 0, y: 0, w: 100, h: 40 },
  { text: "Log out", type: "Button", x: 0, y: 50, w: 100, h: 40 },
  { text: "Email", testID: "email-input", type: "TextField", x: 0, y: 100, w: 200, h: 40 },
  { text: "Login screen", type: "Other", x: 0, y: 0, w: 400, h: 800 },
]);

describe("searchElements", () => {
  it("substring-matches text and testID case-insensitively by default", () => {
    const hits = searchElements(els, { search: ["login"] });
    expect(hits.map((e) => e.text)).toEqual(["Login", "Login screen"]);
  });

  it("exact match narrows to the exact label", () => {
    const hits = searchElements(els, { search: ["Login"], match: "exact" });
    expect(hits).toHaveLength(1);
    expect(hits[0].testID).toBe("login-btn");
  });

  it("case-sensitive substring respects case", () => {
    expect(searchElements(els, { search: ["login"], caseSensitive: true })).toHaveLength(1); // login-btn testID
    expect(searchElements(els, { search: ["Login"], caseSensitive: true })).toHaveLength(2);
  });

  it("filters by element type", () => {
    const hits = searchElements(els, { search: ["Log"], type: "Button" });
    expect(hits.map((e) => e.text)).toEqual(["Login", "Log out"]);
  });

  it("multiple search terms are ORed", () => {
    const hits = searchElements(els, { search: ["email-input", "Log out"] });
    expect(hits).toHaveLength(2);
  });

  it("empty search with a type filters by type alone", () => {
    const hits = searchElements(els, { search: [], type: "Button" });
    expect(hits.map((e) => e.text)).toEqual(["Login", "Log out"]);
  });
});

describe("elementAtPoint", () => {
  it("returns the smallest element containing the point", () => {
    expect(elementAtPoint(els, 50, 20)?.text).toBe("Login"); // inside both Login and the full-screen Other
  });

  it("falls back to a larger container when nothing smaller matches", () => {
    expect(elementAtPoint(els, 300, 700)?.text).toBe("Login screen");
  });

  it("returns undefined outside every element", () => {
    expect(elementAtPoint(els, 999, 999)).toBeUndefined();
  });
});

describe("elementAtPoint visibility", () => {
  const el = (text: string, x: number, y: number, w: number, h: number, extra: any = {}) => ({
    text, x, y, w, h, cx: Math.round(x + w / 2), cy: Math.round(y + h / 2), ...extra,
  });

  it("never answers with an element from a hidden screen", () => {
    // The point is over a video; a label from an inactive tab measured there too.
    const els = [
      el("Video frame", 0, 0, 440, 800),
      el("Profile: Alex", 12, 206, 416, 22, { hidden: true, hiddenBy: "covered" }),
    ] as any;
    expect(elementAtPoint(els, 220, 217)!.text).toBe("Video frame");
  });

  it("ignores scrolled-away elements", () => {
    const els = [el("Visible", 0, 0, 100, 100), el("Gone", 0, 0, 50, 50, { offscreen: true })] as any;
    expect(elementAtPoint(els, 10, 10)!.text).toBe("Visible");
  });

  it("uses the clipped box, not the full frame", () => {
    // A row scrolled half past the top edge: only its visible part can be hit.
    const els = [el("Row", 0, -40, 200, 80, { visible: { x: 0, y: 0, w: 200, h: 40 } })] as any;
    expect(elementAtPoint(els, 100, 20)!.text).toBe("Row");
    expect(elementAtPoint(els, 100, -20)).toBeUndefined();
  });

  it("returns nothing rather than a hidden element", () => {
    const els = [el("Ghost", 0, 0, 100, 100, { hidden: true })] as any;
    expect(elementAtPoint(els, 10, 10)).toBeUndefined();
  });
});
