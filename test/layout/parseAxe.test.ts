import { describe, it, expect } from "vitest";
import { parseAxe } from "../../src/layout/parseAxe.js";

describe("parseAxe", () => {
  it("flattens nodes into elements", () => {
    const json = JSON.stringify([
      { AXLabel: "Login", AXIdentifier: "login-btn", frame: { x: 10, y: 20, width: 100, height: 40 }, children: [] },
      {
        AXLabel: "Header",
        frame: { x: 0, y: 0, width: 320, height: 50 },
        children: [{ AXLabel: "Email", AXIdentifier: "email", frame: { x: 5, y: 60, width: 200, height: 30 }, children: [] }],
      },
    ]);
    const els = parseAxe(json);
    expect(els).toContainEqual({ text: "Login", testID: "login-btn", x: 10, y: 20, w: 100, h: 40 });
    expect(els.find((e) => e.testID === "email")).toBeTruthy();
  });

  it("returns [] on malformed input", () => {
    expect(parseAxe("not json")).toEqual([]);
  });

  it("captures the element type", () => {
    const json = JSON.stringify([{ AXLabel: "Hi", type: "Button", frame: { x: 0, y: 0, width: 1, height: 1 } }]);
    expect(parseAxe(json)[0].type).toBe("Button");
  });
});

describe("parseAxe filtering", () => {
  const screen = (children: any[]) => JSON.stringify({
    type: "Application",
    frame: { x: 0, y: 0, width: 400, height: 800 },
    children,
  });

  it("drops iOS scroll indicators from the interactive list", () => {
    const json = screen([
      { type: "Button", AXLabel: "Save", frame: { x: 0, y: 10, width: 80, height: 30 } },
      { type: "Other", AXLabel: "Vertical scroll bar, 4 pages", frame: { x: 390, y: 0, width: 3, height: 800 } },
      { type: "Other", AXLabel: "Horizontal scroll bar, 1 page", frame: { x: 0, y: 790, width: 400, height: 3 } },
    ]);
    const els = parseAxe(json);
    expect(els.map((e) => e.text)).toEqual(["Save"]);
  });

  it("marks elements outside the window as off-screen", () => {
    const json = screen([
      { type: "StaticText", AXLabel: "On screen", frame: { x: 0, y: 100, width: 100, height: 20 } },
      { type: "StaticText", AXLabel: "Below fold", frame: { x: 0, y: 2400, width: 100, height: 20 } },
    ]);
    const els = parseAxe(json);
    expect(els.find((e) => e.text === "On screen")!.offscreen).toBeUndefined();
    expect(els.find((e) => e.text === "Below fold")!.offscreen).toBe(true);
  });

  it("skips zero-sized nodes and collapses duplicates", () => {
    const json = screen([
      { type: "Button", AXLabel: "Ghost", frame: { x: 0, y: 0, width: 0, height: 0 } },
      { type: "Button", AXLabel: "Twin", AXIdentifier: "twin", frame: { x: 5, y: 5, width: 10, height: 10 } },
      { type: "Button", AXLabel: "Twin", AXIdentifier: "twin", frame: { x: 5, y: 5, width: 10, height: 10 } },
    ]);
    const els = parseAxe(json);
    expect(els).toHaveLength(1);
    expect(els[0]).toMatchObject({ text: "Twin", testID: "twin" });
  });

  it("falls back to AXValue when there is no label", () => {
    const json = screen([{ type: "TextField", AXValue: "typed text", frame: { x: 0, y: 0, width: 50, height: 20 } }]);
    expect(parseAxe(json)[0].text).toBe("typed text");
  });
});
