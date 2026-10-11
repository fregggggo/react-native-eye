import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseXcRunner,
  xcRunnerViewport,
  xcTypeName,
  XC_TYPE_NAMES,
} from "../../src/layout/parseXcRunner.js";
import { toElements, findByText } from "../../src/layout/elements.js";
import { searchElements, elementAtPoint } from "../../src/layout/search.js";

// Captured 2026-09-24 from our runner's predecessor (Maestro's) on demo-app with
// the App Tracking Transparency alert up: SpringBoard's alert, the status bar,
// scroll-bar duplicates, and a type-0 root holding two subtrees.
const ATT = JSON.parse(readFileSync(new URL("../fixtures/xcrunner/att-alert.json", import.meta.url), "utf8"));
const ALERT_TITLE = "Allow “Demo (DEV)” to track your activity across other companies’ apps and websites?";
const f = (X: number, Y: number, Width: number, Height: number) => ({ X, Y, Width, Height });
const screen = (children: unknown[]) => ({
  axElement: { elementType: 2, label: " ", frame: f(0, 0, 402, 874), children },
  depth: 3,
});

describe("parseXcRunner on the captured ATT alert", () => {
  const els = parseXcRunner(ATT);

  it("lists the alert's elements in tree order, with axe's type names", () => {
    expect(els.map((e) => [e.type, e.text ?? e.testID])).toEqual([
      [XC_TYPE_NAMES[7], ALERT_TITLE],
      ["StaticText", ALERT_TITLE],
      ["StaticText", "Allow tracking so we can measure app installs correctly and show you more relevant ads."],
      ["Button", "Ask App Not to Track"],
      ["Button", "Allow"],
    ]);
  });

  it("drops the alert icon, whose only identifier is a local file path", () => {
    expect(els.some((e) => /kTCCService/.test(`${e.text ?? ""}${e.testID ?? ""}`))).toBe(false);
  });

  it("drops the status bar subtree, scroll bars and the Application/Window containers", () => {
    const texts = els.map((e) => e.text ?? "");
    expect(texts).not.toContain("17:26");
    expect(texts).not.toContain("100% battery power");
    expect(texts.some((t) => /scroll bar/i.test(t))).toBe(false);
    expect(els.some((e) => e.type === XC_TYPE_NAMES[2] || e.type === XC_TYPE_NAMES[4])).toBe(false);
  });

  it("keeps fractional frames exactly as the runner reports them", () => {
    const allow = els.find((e) => e.text === "Allow")!;
    expect(allow).toMatchObject({ x: 57, y: 577.6666666666667, w: 288, h: 48 });
  });

  it("takes the viewport from the Application frame and marks nothing off-screen", () => {
    expect(xcRunnerViewport(ATT)).toEqual({ x: 0, y: 0, w: 402, h: 874 });
    expect(els.some((e) => e.offscreen || e.visible)).toBe(false);
  });

  it("feeds the existing selector and search code unchanged", () => {
    const view = toElements(els);
    const allow = findByText(view, "Allow");
    expect(allow).toMatchObject({ type: "Button", cx: 201, cy: 602 });
    expect(searchElements(view, { search: ["track"], type: "Button" }).map((e) => e.text)).toEqual([
      "Ask App Not to Track",
    ]);
    // The alert container also covers this point; the smaller Button wins.
    expect(elementAtPoint(view, 201, 600)?.text).toBe("Allow");
  });
});

describe("parseXcRunner on the runner's recovery shape", () => {
  // When the app snapshot fails, the runner answers children:[other, keyboard,
  // alerts, window] under a type-0 root — no Application node at all.
  const app = ATT.axElement.children[0];
  const window = app.children[0];
  const recovery = {
    axElement: {
      elementType: 0,
      frame: f(0, 0, 0, 0),
      children: [
        { elementType: 1, frame: f(0, 0, 0, 0), children: [] },
        {
          elementType: 19,
          label: "",
          frame: f(0, 540, 402, 334),
          children: [{ elementType: 20, label: "q", frame: f(3, 600, 37, 42), children: [] }],
        },
        window,
        { elementType: 9, label: "Below", frame: f(0, 1000, 100, 40), children: [] },
      ],
    },
    depth: 14,
  };

  it("uses the largest Window frame as the viewport", () => {
    expect(app.elementType).toBe(2);
    expect(window.elementType).toBe(4);
    expect(xcRunnerViewport(recovery)).toEqual({ x: 0, y: 0, w: 402, h: 874 });
  });

  it("still finds the keyboard keys and the alert, and clips to the window", () => {
    const els = parseXcRunner(recovery);
    expect(els.find((e) => e.text === "q")).toMatchObject({ type: XC_TYPE_NAMES[20] });
    expect(els.find((e) => e.text === "Allow")).toMatchObject({ type: "Button" });
    expect(els.find((e) => e.text === "Below")!.offscreen).toBe(true);
  });
});

describe("parseXcRunner viewport fallback", () => {
  const bare = {
    axElement: { elementType: 0, children: [{ elementType: 9, label: "Far", frame: f(0, 2000, 50, 20) }] },
    depth: 2,
  };

  it("has no viewport of its own without an Application or Window", () => {
    expect(xcRunnerViewport(bare)).toBeUndefined();
    expect(parseXcRunner(bare)[0].offscreen).toBeUndefined();
  });

  it("clips to the caller's screen size when given one", () => {
    expect(parseXcRunner(bare, { w: 402, h: 874 })[0].offscreen).toBe(true);
  });
});

describe("parseXcRunner fields and filtering", () => {
  it("takes text from label, then value, then placeholderValue, and testID from identifier", () => {
    const els = parseXcRunner(
      screen([
        { elementType: 9, label: "Save", value: "ignored", identifier: "save-btn", frame: f(0, 10, 80, 30) },
        { elementType: 49, label: "", value: "typed text", frame: f(0, 50, 200, 30) },
        { elementType: 49, label: "", value: "", placeholderValue: "Email", identifier: "email", frame: f(0, 90, 200, 30) },
        { elementType: 43, label: "", identifier: "logo", frame: f(0, 130, 40, 40) },
      ]),
    );
    expect(els).toEqual([
      { text: "Save", testID: "save-btn", type: "Button", x: 0, y: 10, w: 80, h: 30 },
      { text: "typed text", type: XC_TYPE_NAMES[49], x: 0, y: 50, w: 200, h: 30 },
      { text: "Email", testID: "email", type: XC_TYPE_NAMES[49], x: 0, y: 90, w: 200, h: 30 },
      { testID: "logo", type: XC_TYPE_NAMES[43], x: 0, y: 130, w: 40, h: 40 },
    ]);
  });

  it("treats a whitespace-only label as no label", () => {
    const [el] = parseXcRunner(screen([{ elementType: 48, label: "  ", value: "42", frame: f(0, 0, 10, 10) }]));
    expect(el.text).toBe("42");
  });

  it("skips zero-area frames, type-47 scroll bars and scroll-bar labels, and collapses duplicates", () => {
    const els = parseXcRunner(
      screen([
        { elementType: 9, label: "Ghost", frame: f(0, 0, 0, 0) },
        { elementType: 47, label: "Thumb", frame: f(390, 0, 3, 800) },
        { elementType: 1, label: "Vertical scroll bar, 4 pages", value: "0%", frame: f(390, 0, 30, 800) },
        { elementType: 9, label: "Twin", identifier: "twin", frame: f(5, 5, 10, 10) },
        { elementType: 9, label: "Twin", identifier: "twin", frame: f(5, 5, 10, 10) },
      ]),
    );
    expect(els.map((e) => e.text)).toEqual(["Twin"]);
  });

  it("records the visible part of an element cut by the screen edge", () => {
    const [el] = parseXcRunner(screen([{ elementType: 9, label: "Edge", frame: f(0, 850, 100, 50) }]));
    expect(el.visible).toEqual({ x: 0, y: 850, w: 100, h: 24 });
  });

  it("names unknown element types by number and leaves a missing one undefined", () => {
    expect(xcTypeName(99)).toBe("ElementType99");
    expect(xcTypeName(undefined)).toBeUndefined();
    const els = parseXcRunner(screen([{ label: "Untyped", frame: f(0, 0, 10, 10) }]));
    expect(els[0].type).toBeUndefined();
  });

  it("maps the seven types already known from axe's own output", () => {
    expect([1, 2, 3, 9, 33, 46, 48].map((t) => XC_TYPE_NAMES[t])).toEqual([
      "GenericElement",
      "Application",
      "Group",
      "Button",
      "Slider",
      "ScrollArea",
      "StaticText",
    ]);
  });

  it("returns [] for anything that is not a hierarchy", () => {
    for (const bad of [null, undefined, "x", 42, {}, { axElement: null }, { axElement: "x" }]) {
      expect(parseXcRunner(bad)).toEqual([]);
    }
  });

  it("RF-3: a SpringBoard-only tree (home screen) still yields the icons as elements", () => {
    const json = {
      depth: 3,
      axElement: {
        elementType: 0, label: "", identifier: "", frame: { X: 0, Y: 0, Width: 0, Height: 0 },
        children: [
          {
            elementType: 2, label: "SpringBoard", identifier: "", frame: { X: 0, Y: 0, Width: 402, Height: 874 },
            children: [
              { elementType: 44, label: "Settings", identifier: "Settings", frame: { X: 30, Y: 100, Width: 64, Height: 64 }, children: [] },
              { elementType: 44, label: "Safari", identifier: "Safari", frame: { X: 120, Y: 100, Width: 64, Height: 64 }, children: [] },
            ],
          },
        ],
      },
    };
    const els = parseXcRunner(json);
    expect(els.map((e) => e.text)).toEqual(["Settings", "Safari"]);
    expect(els.every((e) => !e.offscreen)).toBe(true);
  });
});
