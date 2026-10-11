// Field test 3, D23/D24: every place the app's coordinates (dp, relative to
// the visible display frame) meet the driver's (px, screen) goes through one
// conversion. Android here is the field-test emulator: 1440x3120, 560 dpi
// (scale 3.5), edge-to-edge, status bar 144 px — the app origin is (0,144).
import { describe, it, expect, beforeEach } from "vitest";
import { captureLayoutWithSource, resolveViewport } from "../../src/tools/layout.js";
import { tapInternal, scrollToInternal } from "../../src/tools/interact.js";
import { dispatchTap, dispatchSwipe } from "../../src/input/dispatch.js";
import { resetHotState } from "../../src/input/hotState.js";
import { resetAppSpaceCache } from "../../src/layout/appSpace.js";
import type { DeviceDriver, RawElement } from "../../src/drivers/types.js";
import { ADB, AXE } from "../helpers/osPath.js";

type Origin = { x: number; y: number } | undefined;

function androidDriver(o: { scale?: number; origin?: Origin; osEls?: RawElement[] } = {}) {
  const taps: { x: number; y: number }[] = [];
  const swipes: number[][] = [];
  const driver = {
    platform: "android" as const,
    listDevices: async () => [],
    screenshotPng: async () => Buffer.from(""),
    rawLayout: async () => ({ els: o.osEls ?? [], os: ADB }),
    tapXY: async (_u: string, x: number, y: number) => {
      taps.push({ x, y });
      return ADB;
    },
    swipe: async (_u: string, x1: number, y1: number, x2: number, y2: number) => {
      swipes.push([x1, y1, x2, y2]);
      return ADB;
    },
    typeText: async () => ADB,
    pressKey: async () => ADB,
    launchApp: async () => {},
    pointScale: async () => o.scale ?? 3.5,
    appOrigin: async () => ("origin" in o ? o.origin : { x: 0, y: 144 }),
  } as unknown as DeviceDriver;
  return { driver, taps, swipes };
}

/**
 * The app's answers, keyed by which expression was sent: the layout capture,
 * the viewport probe, a press, a scroll. Every expression is recorded.
 */
function appConn(layout: unknown, opts: { press?: unknown; scroll?: unknown; viewport?: unknown } = {}) {
  const exprs: string[] = [];
  const conn = {
    evaluate: async (expr: string) => {
      exprs.push(expr);
      if (expr.includes("var PX =")) return JSON.stringify(opts.press ?? { pressed: true, component: "Pressable", handler: "onPress", depth: 1 });
      if (expr.includes("var TX =")) return JSON.stringify(opts.scroll ?? { scrolled: false, reason: "nothing" });
      if (expr.includes("var MAX =")) return JSON.stringify(layout);
      return JSON.stringify(opts.viewport ?? null);
    },
  };
  return { conn, exprs };
}

function num(expr: string, name: string): number {
  const m = new RegExp(`${name} = (-?[\\d.]+)`).exec(expr);
  if (!m) throw new Error(`${name} not in expression`);
  return Number(m[1]);
}

// Root host measured by measureInWindow on an edge-to-edge window: it starts
// 144 px (41.14 dp) above the visible display frame.
const VIEWPORT = { x: 0, y: -41.14, w: 411.43, h: 891.43 };
// "For You": centre (166.57, 21.4) dp — what the field test saw as @583,75.
const FOR_YOU = { text: "For You", x: 150, y: 12, w: 33.14, h: 18.8 };
const TRENDS = { text: "Trends", x: 235, y: 12, w: 33.14, h: 18.8 };
const LAYOUT = { available: true, viewport: VIEWPORT, els: [FOR_YOU, TRENDS] };

beforeEach(() => {
  resetAppSpaceCache();
  resetHotState();
});

describe("D23: JS layout lands in screen pixels, origin included", () => {
  it("get_layout source:js puts a node measured at y=21.4 dp at y=219 px", async () => {
    const { driver } = androidDriver();
    const { conn } = appConn(LAYOUT);
    const c = await captureLayoutWithSource(driver, "S", { conn, source: "js" });
    const el = c.els.find((e) => e.text === "For You")!;
    expect([el.cx, el.cy]).toEqual([583, 219]);
    // The viewport is converted by the same rule: the root starts at the top
    // of the screen, not 144 px above it.
    expect(c.viewport!.y).toBeCloseTo(0, 0);
    expect(c.viewport!.h).toBeCloseTo(3120, 0);
  });

  it("tap {text, via:os} is sent to (583,219), not to the status bar", async () => {
    const { driver, taps } = androidDriver();
    const { conn } = appConn(LAYOUT);
    const out = await tapInternal(driver, "S", { text: "For You" }, undefined, conn, "os");
    expect(taps).toEqual([{ x: 583, y: 219 }]);
    expect(out.split("\n")[0]).toBe('Tapped "For You" @583,219. (input: os/adb)');
  });

  it("origin 0 (a classic window: content already below the bar) is pure scaling", async () => {
    const { driver, taps } = androidDriver({ origin: { x: 0, y: 0 } });
    const { conn } = appConn({ ...LAYOUT, viewport: { x: 0, y: 0, w: 411.43, h: 850 } });
    await tapInternal(driver, "S", { text: "For You" }, undefined, conn, "os");
    expect(taps).toEqual([{ x: 583, y: 75 }]);
  });

  it("an unreadable origin degrades to the old pure scaling instead of failing", async () => {
    const { driver } = androidDriver({ origin: undefined });
    const { conn } = appConn(LAYOUT);
    const c = await captureLayoutWithSource(driver, "S", { conn, source: "js" });
    expect(c.els[0].cy).toBe(75);
  });

  it("resolveViewport (swipe vectors, OCR scale) uses the same conversion", async () => {
    const { driver } = androidDriver();
    const { conn } = appConn(LAYOUT, { viewport: VIEWPORT });
    const vp = await resolveViewport(driver, "S", conn);
    expect(vp!.x).toBe(0);
    expect(vp!.y).toBeCloseTo(0, 0);
    expect(vp!.w).toBeCloseTo(1440, 0);
  });
});

describe("D24: JS input receives app units", () => {
  it("dispatchTap({x:583, y:219, via:js}) hands the press (≈166.6, ≈21.4) dp", async () => {
    const { driver, taps } = androidDriver();
    const { conn, exprs } = appConn(LAYOUT);
    const d = await dispatchTap({ driver, udid: "S", x: 583, y: 219, via: "js", conn });
    expect(d.marker).toBe("(input: js)");
    expect(taps).toEqual([]);
    const press = exprs.find((e) => e.includes("var PX ="))!;
    expect(num(press, "PX")).toBeCloseTo(166.57, 1);
    expect(num(press, "PY")).toBeCloseTo(21.43, 1);
  });

  it("tap {text, via:js} round-trips: the press point is the element's own dp centre", async () => {
    const { driver } = androidDriver();
    const { conn, exprs } = appConn(LAYOUT);
    const out = await tapInternal(driver, "S", { text: "Trends" }, undefined, conn, "js");
    expect(out.split("\n")[0]).toBe('Tapped "Trends" @880,219. (input: js)');
    const press = exprs.find((e) => e.includes("var PX ="))!;
    // Trends centre: (251.57, 21.4) dp — inside its own frame, whatever rounding did.
    expect(Math.abs(num(press, "PX") - 251.57)).toBeLessThan(0.3);
    expect(Math.abs(num(press, "PY") - 21.4)).toBeLessThan(0.3);
  });

  it("dispatchSwipe via js: the start point loses the origin, the travel only the scale", async () => {
    const { driver, swipes } = androidDriver();
    const { conn, exprs } = appConn(LAYOUT, {
      scroll: { scrolled: true, container: "FlatList", method: "scrollToOffset", from: 0, to: 200 },
    });
    await dispatchSwipe({ driver, udid: "S", coords: [700, 2244, 700, 1544], via: "js", conn });
    expect(swipes).toEqual([]);
    const e = exprs.find((x) => x.includes("var TX ="))!;
    expect(num(e, "TX")).toBe(200);
    expect(num(e, "TY")).toBe(600); // (2244 − 144) / 3.5
    expect(num(e, "DY")).toBe(200); // 700 / 3.5, no origin
  });

  it("scroll_to via js hit-tests the off-screen element at its own dp centre", async () => {
    const below = { text: "Row 40", x: 0, y: 1000, w: 400, h: 40 };
    const { driver } = androidDriver();
    const { conn, exprs } = appConn({ available: true, viewport: VIEWPORT, els: [{ ...below, offscreen: true }] }, {
      scroll: { scrolled: true, container: "FlatList", method: "scrollToIndex" },
    });
    await scrollToInternal(driver, "S", { text: "Row 40" }, { via: "js", conn });
    const e = exprs.find((x) => x.includes("var TX ="))!;
    expect(num(e, "TX")).toBe(200);
    expect(num(e, "TY")).toBe(1020);
  });
});

describe("iOS is untouched: scale 1, no origin", () => {
  function iosDriver() {
    const taps: { x: number; y: number }[] = [];
    const driver = {
      platform: "ios" as const,
      rawLayout: async () => ({ els: [], os: AXE }),
      tapXY: async (_u: string, x: number, y: number) => {
        taps.push({ x, y });
        return AXE;
      },
      pointScale: async () => 1,
    } as unknown as DeviceDriver;
    return { driver, taps };
  }

  it("layout, os tap and js press all use the measured points as they are", async () => {
    const { driver, taps } = iosDriver();
    const { conn, exprs } = appConn({ available: true, viewport: { x: 0, y: 0, w: 393, h: 852 }, els: [FOR_YOU] });
    const c = await captureLayoutWithSource(driver, "I", { conn, source: "js" });
    expect([c.els[0].cx, c.els[0].cy]).toEqual([167, 21]);
    await tapInternal(driver, "I", { text: "For You" }, undefined, conn, "os");
    expect(taps).toEqual([{ x: 167, y: 21 }]);
    await dispatchTap({ driver, udid: "I", x: 167, y: 21, via: "js", conn });
    const press = exprs.find((e) => e.includes("var PX ="))!;
    expect([num(press, "PX"), num(press, "PY")]).toEqual([167, 21]);
  });
});
