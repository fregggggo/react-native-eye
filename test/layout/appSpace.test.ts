import { describe, it, expect, beforeEach } from "vitest";
import {
  toScreenRect,
  toAppPoint,
  toAppDelta,
  resolveAppSpace,
  resetAppSpaceCache,
  ORIGIN_TTL_MS,
  IDENTITY_SPACE,
} from "../../src/layout/appSpace.js";
import type { DeviceDriver } from "../../src/drivers/types.js";

const ANDROID = { scale: 3.5, x: 0, y: 144 };

describe("app space conversion", () => {
  it("is the identity on iOS (scale 1, origin 0) — the same object comes back", () => {
    const r = { x: 10.5, y: 20, w: 30, h: 40 };
    expect(toScreenRect(r, IDENTITY_SPACE)).toBe(r);
    expect(toAppPoint(10, 20, IDENTITY_SPACE)).toEqual({ x: 10, y: 20 });
  });

  it("app → screen adds the origin after scaling (field test D23: For You @583,219)", () => {
    // centre (166.57, 21.4) dp
    const r = toScreenRect({ x: 150, y: 12, w: 33.14, h: 18.8 }, ANDROID);
    expect(Math.round(r.x + r.w / 2)).toBe(583);
    expect(Math.round(r.y + r.h / 2)).toBe(219);
    expect(r.h).toBeCloseTo(65.8);
  });

  it("converts the clipped `visible` part too — the tap point is its centre", () => {
    const r = toScreenRect({ x: 0, y: 0, w: 100, h: 100, visible: { x: 0, y: 50, w: 100, h: 50 } }, ANDROID);
    expect(r.visible).toEqual({ x: 0, y: 144 + 175, w: 350, h: 175 });
  });

  it("screen → app is the exact inverse for points (D24: (583,219) → (166.57, 21.43))", () => {
    const p = toAppPoint(583, 219, ANDROID);
    expect(p.x).toBeCloseTo(166.57, 1);
    expect(p.y).toBeCloseTo(21.43, 1);
  });

  it("vectors convert by scale alone — no origin", () => {
    expect(toAppDelta(0, 700, ANDROID)).toEqual({ dx: 0, dy: 200 });
  });

  it("origin 0 (a classic window whose measure already matches) is pure scaling", () => {
    const s = { scale: 2.625, x: 0, y: 0 };
    const r = toScreenRect({ x: 10, y: 20, w: 100, h: 40 }, s);
    expect(r).toEqual({ x: 26.25, y: 52.5, w: 262.5, h: 105 });
    expect(toAppPoint(157.5, 105, s)).toEqual({ x: 60, y: 40 });
  });
});

describe("resolveAppSpace", () => {
  beforeEach(() => resetAppSpaceCache());

  function driver(origin: () => { x: number; y: number } | undefined, scale = 3.5) {
    let reads = 0;
    const d = {
      platform: "android",
      pointScale: async () => scale,
      appOrigin: async () => {
        reads++;
        return origin();
      },
    } as unknown as DeviceDriver;
    return { d, reads: () => reads };
  }

  it("a driver without appOrigin (iOS) gets origin 0 and its own scale", async () => {
    const ios = { platform: "ios", pointScale: async () => 1 } as unknown as DeviceDriver;
    expect(await resolveAppSpace(ios, "U")).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("a driver without pointScale gets scale 1", async () => {
    const bare = { platform: "ios" } as unknown as DeviceDriver;
    expect(await resolveAppSpace(bare, "U")).toEqual({ scale: 1, x: 0, y: 0 });
  });

  it("reads the origin once per device within the TTL", async () => {
    const { d, reads } = driver(() => ({ x: 0, y: 144 }));
    let t = 1000;
    const now = () => t;
    expect(await resolveAppSpace(d, "S", { now })).toEqual({ scale: 3.5, x: 0, y: 144 });
    t += ORIGIN_TTL_MS - 1;
    await resolveAppSpace(d, "S", { now });
    expect(reads()).toBe(1);
    t += 2;
    await resolveAppSpace(d, "S", { now });
    expect(reads()).toBe(2);
  });

  it("re-reads at once when the app's root frame changed (rotation, bars shown/hidden)", async () => {
    const { d, reads } = driver(() => ({ x: 0, y: 144 }));
    const now = () => 5;
    const portrait = { x: 0, y: -41.14, w: 411.43, h: 891.43 };
    await resolveAppSpace(d, "S", { now, viewport: portrait });
    await resolveAppSpace(d, "S", { now, viewport: portrait });
    await resolveAppSpace(d, "S", { now }); // no viewport (a press): the cached origin stands
    expect(reads()).toBe(1);
    await resolveAppSpace(d, "S", { now, viewport: { x: 0, y: 0, w: 891.43, h: 411.43 } });
    expect(reads()).toBe(2);
  });

  it("never throws: an unreadable origin is 0 (the old behaviour) and is cached", async () => {
    const { d, reads } = driver(() => {
      throw new Error("dumpsys failed");
    });
    expect(await resolveAppSpace(d, "S")).toEqual({ scale: 3.5, x: 0, y: 0 });
    await resolveAppSpace(d, "S");
    expect(reads()).toBe(1);
  });

  it("keeps devices apart", async () => {
    const a = driver(() => ({ x: 0, y: 144 }));
    const b = driver(() => ({ x: 0, y: 0 }));
    expect((await resolveAppSpace(a.d, "A")).y).toBe(144);
    expect((await resolveAppSpace(b.d, "B")).y).toBe(0);
  });
});

// Whether RN subtracted the visible-frame origin depends on the runtime:
// Fabric applies the root's viewportOffset only when the surface started on
// the UI thread. Field test 3 (RN 0.83) measured the root at y = −41.14 dp
// (offset applied); a fresh Expo app on RN 0.86 measures it at y = 0 (not
// applied) and every JS rect landed 144 px too low. The root's own frame says
// which one this app is.
describe("resolveAppSpace calibrated by the root frame", () => {
  beforeEach(() => resetAppSpaceCache());

  const WINDOW = { x: 0, y: 0, w: 1440, h: 3120 };
  function driver(state: { x: number; y: number; window?: typeof WINDOW }) {
    let reads = 0;
    const d = {
      platform: "android",
      pointScale: async () => 3.5,
      appOrigin: async () => {
        reads++;
        return state;
      },
    } as unknown as DeviceDriver;
    return { d, reads: () => reads };
  }

  it("offset applied (root at −status bar): the visible-frame origin stands", async () => {
    const { d } = driver({ x: 0, y: 144, window: WINDOW });
    const viewport = { x: 0, y: -41.14, w: 411.43, h: 891.43 };
    expect(await resolveAppSpace(d, "S", { viewport })).toEqual({ scale: 3.5, x: 0, y: 144 });
  });

  it("offset not applied (root at 0 on an edge-to-edge window): origin is the window's top", async () => {
    const { d } = driver({ x: 0, y: 144, window: WINDOW });
    const viewport = { x: 0, y: 0, w: 411.43, h: 891.43 };
    expect(await resolveAppSpace(d, "S", { viewport })).toEqual({ scale: 3.5, x: 0, y: 0 });
  });

  it("a root padded below the bar (classic window, shorter than the screen) starts at the visible top", async () => {
    const { d } = driver({ x: 0, y: 144, window: WINDOW });
    const viewport = { x: 0, y: 0, w: 411.43, h: 826.29 }; // 2892 px: between the bars
    expect(await resolveAppSpace(d, "S", { viewport })).toEqual({ scale: 3.5, x: 0, y: 144 });
  });

  it("a left cutout in landscape, offset not applied: origin x is the window's left", async () => {
    const { d } = driver({ x: 144, y: 0, window: { x: 0, y: 0, w: 3120, h: 1440 } });
    const viewport = { x: 0, y: 0, w: 891.43, h: 411.43 };
    expect(await resolveAppSpace(d, "S", { viewport })).toEqual({ scale: 3.5, x: 0, y: 0 });
  });

  it("an implausible root (not at either candidate) keeps the visible-frame origin", async () => {
    const { d } = driver({ x: 0, y: 144, window: WINDOW });
    const viewport = { x: 0, y: 300, w: 411.43, h: 891.43 };
    expect(await resolveAppSpace(d, "S", { viewport })).toEqual({ scale: 3.5, x: 0, y: 144 });
  });

  it("without a window frame or a root frame it is the visible-frame origin, as before", async () => {
    const a = driver({ x: 0, y: 144 });
    expect(await resolveAppSpace(a.d, "A", { viewport: { x: 0, y: 0, w: 411.43, h: 891.43 } })).toEqual({ scale: 3.5, x: 0, y: 144 });
    const b = driver({ x: 0, y: 144, window: WINDOW });
    expect(await resolveAppSpace(b.d, "B")).toEqual({ scale: 3.5, x: 0, y: 144 });
  });

  it("a root frame arriving after a press recalibrates the cached read without a second dump", async () => {
    const { d, reads } = driver({ x: 0, y: 144, window: WINDOW });
    const now = () => 0;
    expect((await resolveAppSpace(d, "S", { now })).y).toBe(144);
    expect((await resolveAppSpace(d, "S", { now, viewport: { x: 0, y: 0, w: 411.43, h: 891.43 } })).y).toBe(0);
    expect((await resolveAppSpace(d, "S", { now })).y).toBe(0);
    expect(reads()).toBe(1);
  });

  it("a press (no root frame) after the TTL re-reads with the last root frame seen", async () => {
    const { d, reads } = driver({ x: 0, y: 144, window: WINDOW });
    let t = 0;
    const now = () => t;
    await resolveAppSpace(d, "S", { now, viewport: { x: 0, y: 0, w: 411.43, h: 891.43 } });
    t += ORIGIN_TTL_MS + 1;
    expect(await resolveAppSpace(d, "S", { now })).toEqual({ scale: 3.5, x: 0, y: 0 });
    expect(reads()).toBe(2);
  });
});

// D38: the overlay-window flag must come from a read made *now*.
describe("resolveAppSpace fresh read (overlayWindow)", () => {
  beforeEach(() => resetAppSpaceCache());

  function driver(states: ({ x: number; y: number; overlayWindow?: boolean } | undefined)[]) {
    let reads = 0;
    const d = {
      platform: "android",
      pointScale: async () => 3.5,
      appOrigin: async () => states[Math.min(reads++, states.length - 1)],
    } as unknown as DeviceDriver;
    return { d, reads: () => reads };
  }

  it("never serves overlayWindow from the cache and never returns it unasked", async () => {
    const { d, reads } = driver([{ x: 0, y: 144, overlayWindow: true }]);
    const first = await resolveAppSpace(d, "dev", { now: () => 0 });
    expect(first).toEqual({ scale: 3.5, x: 0, y: 144 });
    const cached = await resolveAppSpace(d, "dev", { now: () => 1000 });
    expect(cached).toEqual({ scale: 3.5, x: 0, y: 144 });
    expect(reads()).toBe(1);
  });

  it("fresh re-reads inside the TTL and carries the flag", async () => {
    const { d, reads } = driver([
      { x: 0, y: 144, overlayWindow: false },
      { x: 0, y: 144, overlayWindow: true },
    ]);
    await resolveAppSpace(d, "dev", { now: () => 0 });
    const s = await resolveAppSpace(d, "dev", { now: () => 500, fresh: true });
    expect(s).toEqual({ scale: 3.5, x: 0, y: 144, overlayWindow: true });
    expect(reads()).toBe(2);
    // …and the origin it read refreshes the cache for everyone else.
    await resolveAppSpace(d, "dev", { now: () => 900 });
    expect(reads()).toBe(2);
  });

  it("leaves the flag out when the driver cannot tell or the read fails", async () => {
    const a = driver([{ x: 0, y: 144 }]);
    expect(await resolveAppSpace(a.d, "a", { fresh: true })).toEqual({ scale: 3.5, x: 0, y: 144 });
    const b = driver([undefined]);
    expect(await resolveAppSpace(b.d, "b", { fresh: true })).toEqual({ scale: 3.5, x: 0, y: 0 });
    const ios = { platform: "ios", pointScale: async () => 1 } as unknown as DeviceDriver;
    expect(await resolveAppSpace(ios, "c", { fresh: true })).toEqual({ scale: 1, x: 0, y: 0 });
  });
});
