// The one conversion between the two coordinate spaces that meet whenever the
// app runtime and the OS driver talk about the same pixel:
//
//   app space    — what the app measures: `measureInWindow` in points (iOS) or
//                  dp (Android), relative to the window's *visible display
//                  frame* (RN subtracts getWindowVisibleDisplayFrame().topLeft
//                  on Android, on both Paper and Fabric).
//   screen space — what the driver taps, swipes and dumps: points (iOS/axe/
//                  runner) or physical pixels (Android input/uiautomator).
//
//   screen = origin + app × scale        app = (screen − origin) / scale
//
// iOS: scale 1, origin 0 — the identity. Android: scale = density / 160 and
// origin = top-left of the app window's visible display frame in px — the
// status bar (or the display cutout) on an edge-to-edge window, the window's
// own top on a classic window that starts below the bar. Field test 3 D23/D24:
// the origin was missing (every JS rect 144 px too high) and the inverse was
// never applied to a JS press (px handed to a dp hit-test).
//
// "RN subtracts" holds only for some runtimes: Fabric applies the root's
// viewportOffset to measureInWindow only when the surface was started on the
// UI thread (FabricUIManager.startSurface). Field test 3's app (RN 0.83)
// measured its root at y = −41.14 dp — offset applied; a fresh Expo app on
// RN 0.86 measures it at 0 — not applied, and with the visible-frame origin
// every rect sat 144 px too low. The root's own frame decides: the root
// starts at the window's top when it is taller than what lies below the
// visible top (edge-to-edge), else at the visible top (a root padded below
// the bar), and origin = rootStart − rootMeasured × scale.
//
// Vectors (a swipe's travel, a size) convert by scale alone.

import type { AppWindowState, DeviceDriver } from "../drivers/types.js";

export type AppSpace = {
  scale: number;
  x: number;
  y: number;
  /**
   * Whether a dialog-sized window of the app is on screen — only present when
   * the caller asked for a `fresh` read and the driver could tell. Never
   * served from the cache: a redbox appears and disappears faster than the TTL.
   */
  overlayWindow?: boolean;
};

export const IDENTITY_SPACE: AppSpace = { scale: 1, x: 0, y: 0 };

type Rect = { x: number; y: number; w: number; h: number };

/** App → screen for a rect, including an element's clipped `visible` part. */
export function toScreenRect<T extends Rect & { visible?: Rect }>(r: T, s: AppSpace): T {
  if (s.scale === 1 && s.x === 0 && s.y === 0) return r;
  const out: T = { ...r, x: s.x + r.x * s.scale, y: s.y + r.y * s.scale, w: r.w * s.scale, h: r.h * s.scale };
  if (r.visible) {
    out.visible = {
      x: s.x + r.visible.x * s.scale,
      y: s.y + r.visible.y * s.scale,
      w: r.visible.w * s.scale,
      h: r.visible.h * s.scale,
    };
  }
  return out;
}

/** Screen → app for a point (a tap, a swipe's start). */
export function toAppPoint(x: number, y: number, s: AppSpace): { x: number; y: number } {
  return { x: round2((x - s.x) / s.scale), y: round2((y - s.y) / s.scale) };
}

/** Screen → app for a vector: no origin. */
export function toAppDelta(dx: number, dy: number, s: AppSpace): { dx: number; dy: number } {
  return { dx: round2(dx / s.scale), dy: round2(dy / s.scale) };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * How long an Android origin is trusted. It only moves when the window mode
 * changes (rotation, status bar shown/hidden, split screen, another app in
 * front), and reading it costs a `dumpsys window` (~0.1-0.3 s idle, 1-3 s on a
 * loaded host), so it is cached per device and re-read after this long — or
 * at once when the app's own root frame (`viewport`) no longer matches the one
 * seen when the origin was read: a rotation or a re-layout of the root after
 * the bars changed shows up there first.
 */
export const ORIGIN_TTL_MS = 10_000;

// The raw window state, not the origin: a root frame that turns up later (a
// press first, a layout next) recalibrates it without another dump.
type Cached = { state?: AppWindowState; at: number; key?: string; vp?: Rect };
const originCache = new Map<string, Cached>();

export function resetAppSpaceCache(): void {
  originCache.clear();
}

function viewportKey(vp?: Rect | null): string | undefined {
  if (!vp) return undefined;
  return [vp.x, vp.y, vp.w, vp.h].map((n) => Math.round(n * 10) / 10).join(",");
}

/**
 * Where the app's (0,0) is on screen, from the driver's window state and the
 * root's measured frame (see the header). Without either, or when the result
 * lands at neither candidate — a first host view that is not the root — the
 * visible-frame origin stands.
 */
function calibrate(o: AppWindowState, vp: Rect | undefined, scale: number): { x: number; y: number } {
  const win = o.window;
  if (!vp || !win) return { x: o.x, y: o.y };
  const axis = (visible: number, winStart: number, winSize: number, at: number, size: number): number => {
    const rootStart = size * scale > winStart + winSize - visible + 1 ? winStart : visible;
    const origin = Math.round(rootStart - at * scale);
    const near = (v: number) => Math.abs(origin - v) <= 2;
    return near(visible) ? visible : near(winStart) ? winStart : visible;
  };
  return { x: axis(o.x, win.x, win.w, vp.x, vp.w), y: axis(o.y, win.y, win.h, vp.y, vp.h) };
}

/**
 * The driver's app space for this device. Never throws: a driver that cannot
 * say gets scale 1 / origin 0, which is exactly the old behaviour.
 *
 * `fresh` skips the cache and reads the window state now — one device round
 * trip, paid only by a caller that needs `overlayWindow` (the JS layout said a
 * LogBox overlay covers the screen; D38).
 */
export async function resolveAppSpace(
  driver: DeviceDriver,
  udid: string,
  opts?: { viewport?: Rect | null; now?: () => number; fresh?: boolean },
): Promise<AppSpace> {
  const scaleRaw = await driver.pointScale?.(udid).catch(() => 1);
  const scale = typeof scaleRaw === "number" && scaleRaw > 0 ? scaleRaw : 1;
  if (!driver.appOrigin) return { scale, x: 0, y: 0 };

  const now = (opts?.now ?? Date.now)();
  const key = viewportKey(opts?.viewport);
  const hit = originCache.get(udid);
  const fresh =
    !opts?.fresh &&
    hit &&
    now - hit.at < ORIGIN_TTL_MS &&
    (key === undefined || hit.key === undefined || hit.key === key);
  if (fresh) {
    if (key !== undefined && hit.key === undefined) {
      hit.key = key;
      hit.vp = opts!.viewport!;
    }
    return { scale, ...origin(hit.state, hit.vp, scale) };
  }
  const o = await driver.appOrigin(udid).catch(() => undefined);
  const state = o && Number.isFinite(o.x) && Number.isFinite(o.y) ? o : undefined;
  // A press carries no root frame; the last one seen on this device stands in.
  const vp = opts?.viewport ?? hit?.vp;
  // A failed read is cached too: on a device whose dumpsys cannot be parsed,
  // paying for it on every call would buy nothing.
  originCache.set(udid, { state, at: now, key, vp });
  const { x, y } = origin(state, vp, scale);
  if (opts?.fresh && state && typeof state.overlayWindow === "boolean") {
    return { scale, x, y, overlayWindow: state.overlayWindow };
  }
  return { scale, x, y };
}

function origin(state: AppWindowState | undefined, vp: Rect | undefined, scale: number): { x: number; y: number } {
  return state ? calibrate(state, vp, scale) : { x: 0, y: 0 };
}
