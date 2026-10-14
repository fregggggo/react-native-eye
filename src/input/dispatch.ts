import { UserInputError, DriverError } from "../core/errors.js";
import { pressExpression, type PressResult } from "./press.js";
import { typeExpression, readInputExpression, type InputTarget } from "./text.js";
import { scrollByExpression, type ScrollByResult } from "./scroll.js";
import { submitExpression, type SubmitResult } from "./submit.js";
import { NAV_FIND_FN } from "../state/navSnippets.js";
import { recordTouch, hotNotice } from "./hotState.js";
import type { EvalConn } from "../tools/layout.js";
import type { DeviceDriver, OsPath, Viewport } from "../drivers/types.js";
import { resolveAppSpace, toAppPoint, toAppDelta, type AppSpace } from "../layout/appSpace.js";

export type InputVia = "js" | "os" | "auto";
export type Dispatched = { marker: string; note?: string };

/**
 * The marker for input the OS delivered. `jsReason` is why the JS path did not
 * run (or "requested"); `os.reason` is why the driver did not use the runner.
 * Both are kept — the first explains the slow path, the second the slower one.
 * The `(input: os` prefix is load-bearing: callers and tests match on it.
 */
export function osMarker(os: OsPath, jsReason?: string): string {
  const reasons = [jsReason, os.reason].filter((r): r is string => !!r);
  return `(input: os/${os.path}${reasons.length ? ` — ${reasons.join("; ")}` : ""})`;
}

const JS_INPUT_TIMEOUT_MS = 10_000;

function asJson(raw: unknown): any {
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

/**
 * The press expression performs the same fiber walk and measurement pass as the
 * layout capture (~14ms for 1779 fibers), so it gets the same budget as
 * JS_LAYOUT_TIMEOUT_MS in src/tools/layout.ts. Deliberately nothing like
 * TIMEOUTS.touch: this path either answers in milliseconds or is broken.
 */
const JS_PRESS_TIMEOUT_MS = 15000;

/** RN's own long-press delay. At or above it the wanted handler is onLongPress. */
const LONG_PRESS_MS = 500;

/**
 * The scroll expressions measure the whole tree before they can hit-test, so
 * they get the same budget scrollToInternal gives them rather than the tighter
 * JS_INPUT_TIMEOUT_MS a single handler call needs.
 */
const JS_SCROLL_TIMEOUT_MS = 15000;

async function jsPress(conn: EvalConn, x: number, y: number, longPress: boolean): Promise<PressResult> {
  const raw = await conn.evaluate(pressExpression(x, y, longPress ? { longPress: true } : undefined), {
    timeoutMs: JS_PRESS_TIMEOUT_MS,
  });
  const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (parsed && parsed.pressed === true) return parsed as PressResult;
  return { pressed: false, reason: parsed?.reason ?? "the press expression returned nothing" };
}

async function osTap(driver: DeviceDriver, udid: string, x: number, y: number, durationMs?: number): Promise<OsPath> {
  const t0 = Date.now();
  try {
    return await driver.tapXY(udid, x, y, durationMs);
  } finally {
    // Recorded on failure too: a touch that times out at 90s is the strongest
    // evidence there is that delivery on this app is degraded.
    recordTouch(udid, Date.now() - t0);
  }
}

/**
 * Delivers a tap at an already-resolved point. Selector resolution, and with it
 * every visibility and ambiguity refusal, has already happened in resolveTarget:
 * the JS path replaces delivery, not judgement.
 *
 * `marker` is "(input: js)", "(input: os/<path>)" or "(input: os/<path> — <reasons>)"; `note`
 * carries the one-time degraded-touch notice when there is one. Every caller
 * must surface both — silent path switching is what the field report criticises
 * about `source: "auto"` in get_layout, and it is not repeated here.
 */
export async function dispatchTap(args: {
  driver: DeviceDriver;
  udid: string;
  x: number;
  y: number;
  durationMs?: number;
  via: InputVia;
  conn?: EvalConn;
}): Promise<Dispatched> {
  const { driver, udid, x, y, durationMs, via, conn } = args;
  const longPress = (durationMs ?? 0) >= LONG_PRESS_MS;

  if (via === "js" && !conn) {
    throw new UserInputError("JS input unavailable: no active Metro connection.");
  }

  let reason: string | undefined;
  if (via !== "os" && conn) {
    let res: PressResult;
    try {
      // x/y are screen units (px on Android); the hit-test runs in the app's
      // own (dp from the visible display frame) — field test 3 D24.
      const p = toAppPoint(x, y, await resolveAppSpace(driver, udid));
      res = await jsPress(conn, p.x, p.y, longPress);
    } catch (err) {
      // Mirrors captureLayoutWithSource: an explicit `js` surfaces the real
      // error rather than degrading into a 20s touch the caller did not ask for.
      if (via === "js") throw err;
      res = { pressed: false, reason: err instanceof Error ? err.message : String(err) };
    }
    // hotNotice is deliberately not attached here: it is a fire-once warning
    // about degraded *touch* delivery, and this return means no touch happened.
    // Attaching it would burn the one announcement on the response where the
    // advice is useless — the caller is already on the fast path the notice
    // exists to recommend. It still fires the moment auto falls back to OS.
    if (res.pressed) return { marker: "(input: js)" };
    if (via === "js") throw new UserInputError(`JS input unavailable: ${res.reason}`);
    reason = res.reason;
  } else if (via !== "os") {
    reason = "no Metro connection";
  }

  const os = await osTap(driver, udid, x, y, durationMs);
  return { marker: osMarker(os, reason), note: hotNotice(udid) };
}

/**
 * Path selection mirrors dispatchTap. Verification does not: it runs on the OS
 * path as well, because the OS path is the one that corrupts. Measured on a live
 * app: "cat" through onChangeText read back exactly "cat" in ~1ms and drove the
 * real search pipeline; the same "cat" through `axe type` arrived as other characters,
 * because axe sends positional HID keycodes that a non-ASCII host keyboard
 * layout rewrites — and it reported success.
 */
export async function dispatchType(args: {
  driver: DeviceDriver;
  udid: string;
  value: string;
  into?: InputTarget;
  via: InputVia;
  conn?: EvalConn;
  verify: boolean;
}): Promise<Dispatched> {
  const target = args.into ?? null;
  /** Set only when the JS path typed; the OS marker needs the driver's OsPath first. */
  let jsMarker: string | undefined;
  /** Why the JS path did not type, when it was tried or skipped for lack of a connection. */
  let jsReason: string | undefined;
  const notes: string[] = [];
  /** Every return merges the app's own notes with whatever this call adds. */
  const done = (m: string, extra?: string): Dispatched => {
    const all = extra ? notes.concat(extra) : notes;
    return all.length ? { marker: m, note: all.join("\n") } : { marker: m };
  };

  if (args.via !== "os") {
    if (!args.conn) {
      if (args.via === "js") {
        throw new UserInputError('via: "js" needs an active Metro connection — run `connect` first.');
      }
      jsReason = "no Metro connection";
    } else {
      let res: any;
      try {
        res = asJson(
          await args.conn.evaluate(typeExpression(target, args.value), { timeoutMs: JS_INPUT_TIMEOUT_MS }),
        );
      } catch (err) {
        // Mirrors dispatchTap's jsPress: an explicit `js` surfaces the real
        // error rather than degrading into the slow keyboard the caller did
        // not ask for.
        if (args.via === "js") throw err;
        res = { typed: false, reason: err instanceof Error ? err.message : String(err) };
      }
      if (res?.typed) {
        jsMarker = "(input: js)";
        // text.ts reports *which* field it chose when the choice was not
        // obvious ("2 matched ...; chose the one on the focused screen"). That
        // is the difference between a typed value landing where the caller
        // meant and landing on a background screen, so it is never dropped.
        if (typeof res.note === "string" && res.note) notes.push(res.note);
      } else {
        const reason = res?.reason ?? "the app returned no result";
        // An app-level refusal (uncontrolled input, ambiguous target) is not a
        // driver failure — UserInputError renders with no misleading prefix,
        // matching dispatchTap's equivalent UserInputError throw.
        if (args.via === "js") {
          throw new UserInputError(`JS typing failed: ${reason}\nRetry with via: "auto" to fall back to the OS keyboard.`);
        }
        jsReason = reason;
      }
    }
  }

  // Same decision the old `marker.indexOf("(input: os") === 0` check made: the
  // OS keyboard runs exactly when the JS path did not type. The OS marker can
  // only be built after the driver says which path it used, so the decision
  // is taken on jsMarker instead of on a placeholder string.
  const usedOs = jsMarker === undefined;
  if (usedOs && args.into) {
    // The OS keyboard types into whatever currently holds focus — there is no
    // tap-to-focus here, and synthesising one would need to resolve the
    // target's coordinates (a Metro connection the OS path may not have) and
    // would invent a focus-resolution subsystem mid-plan. Typing blind would
    // silently ignore `into`, which is worse than the behaviour this plan
    // replaced — most dangerous under `via: "auto"`, which lands here only
    // after the JS path (which does honour `into`) has already failed.
    throw new UserInputError(
      "cannot target a specific field on the OS path: the OS keyboard types into whatever currently has focus. " +
        'Tap the field first, then call type_text without `into` — or use via: "js", which drives the field\'s own onChangeText directly.',
    );
  }
  // No try/catch here: when IosDriver.typeText has to take the axe path (the
  // runner is not ready, refused the connection, or lacks a private symbol),
  // its ASCII and host keyboard-layout guards throw a DriverError naming the
  // problem and the fix, and that message must reach the caller intact — an
  // auto fallback must not swallow it into a generic failure. Through the
  // runner there is no guard: it types any text under any Mac layout.
  const marker = jsMarker ?? osMarker(await args.driver.typeText(args.udid, args.value), jsReason);

  if (!args.verify) return done(marker);
  if (!args.conn) {
    return done(marker, "Not verified: reading the value back needs a Metro connection.");
  }
  const back = asJson(
    await args.conn
      .evaluate(readInputExpression(target), { timeoutMs: JS_INPUT_TIMEOUT_MS })
      .catch(() => undefined),
  );
  if (!back?.found) {
    return done(marker, `Not verified: ${back?.reason ?? "the value could not be read back"}.`);
  }
  const read: string = back.value;
  if (typeof back.note === "string" && back.note) notes.push(back.note);
  if (read === args.value) return done(marker);
  // The OS keyboard appends to whatever the field already held; the JS path
  // replaces it. An append is not corruption, and saying so beats a false alarm.
  if (usedOs && read.length > args.value.length && read.slice(read.length - args.value.length) === args.value) {
    return done(marker, `The field now reads ${JSON.stringify(read)} — the typed text was appended to what was already there.`);
  }
  throw new DriverError(
    `Typed ${JSON.stringify(args.value)} but the field now reads ${JSON.stringify(read)} — the text was corrupted in transit.`,
  );
}

/**
 * The JS route for `swipe`, named for what it actually does: the container
 * under the finger is asked to move by the gesture's own vector. `js` carries
 * the numbers so the tool can print them — a scroll that reports 0 → 0 landed
 * on a container that was already at the end, which a diff alone never shows.
 */
export type SwipeDispatched = Dispatched & {
  js?: { container: string; method: string; from: number; to: number };
};

/**
 * Delivers a swipe between two already-resolved points. Path selection mirrors
 * dispatchTap; the vector does not. A finger travelling *up* drags the content
 * up, so the content offset rises by the distance travelled — the JS route
 * therefore covers the same ground the OS swipe would have, and `auto` does not
 * quietly change how far one call scrolls.
 *
 * The coordinates are screen units; the JS route converts the start point and
 * the travel into app units (src/layout/appSpace.ts) exactly as
 * scrollToInternal and dispatchTap do. `space` overrides the driver's own.
 */
export async function dispatchSwipe(args: {
  driver: DeviceDriver;
  udid: string;
  coords: [number, number, number, number];
  durationMs?: number;
  via: InputVia;
  conn?: EvalConn;
  space?: AppSpace;
}): Promise<SwipeDispatched> {
  const [x1, y1, x2, y2] = args.coords;

  if (args.via === "js" && !args.conn) {
    throw new UserInputError("JS input unavailable: no active Metro connection.");
  }

  let reason: string | undefined;
  if (args.via !== "os" && args.conn) {
    const space = args.space ?? (await resolveAppSpace(args.driver, args.udid));
    const start = toAppPoint(x1, y1, space);
    const travel = toAppDelta(x1 - x2, y1 - y2, space);
    const expr = scrollByExpression(start.x, start.y, travel.dx, travel.dy);
    let res: ScrollByResult;
    try {
      res = asJson(await args.conn.evaluate(expr, { timeoutMs: JS_SCROLL_TIMEOUT_MS }));
    } catch (err) {
      // Mirrors dispatchTap: an explicit `js` surfaces the real error rather
      // than degrading into a 20s touch the caller did not ask for.
      if (args.via === "js") throw err;
      res = { scrolled: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (res && res.scrolled) {
      return {
        marker: "(input: js)",
        js: { container: res.container, method: res.method, from: res.from, to: res.to },
      };
    }
    reason = (res && !res.scrolled && res.reason) || "the scroll expression returned nothing";
    if (args.via === "js") throw new UserInputError(`JS swipe failed: ${reason}`);
  } else if (args.via !== "os") {
    reason = "no Metro connection";
  }

  const t0 = Date.now();
  let os: OsPath;
  try {
    os = await args.driver.swipe(args.udid, x1, y1, x2, y2, args.durationMs ?? 300);
  } finally {
    recordTouch(args.udid, Date.now() - t0);
  }
  return { marker: osMarker(os, reason), note: hotNotice(args.udid) };
}

/**
 * Hardware back, in JS: the navigator's own goBack(). The container ref is
 * found (and cached on globalThis.__RNE_NAV__) by the discovery snippet
 * src/state/navSnippets.ts already uses for `check_state` and `navigate`, so
 * back here and back there can never disagree about which navigator is live.
 */
function backExpression(): string {
  return `/* rne:back */(function () {
    ${NAV_FIND_FN}
    var f = __rneNavFind();
    if (!f.ref) return JSON.stringify({ went: false, reason: f.reason });
    var ref = f.ref;
    // An empty stack is an answer, not a failure: on Android the hardware key
    // would background the app instead, which is not what "go back" meant.
    if (typeof ref.canGoBack === "function" && !ref.canGoBack()) {
      return JSON.stringify({ went: false, definitive: true, source: f.source, reason: "nothing to go back to" });
    }
    try { ref.goBack(); }
    catch (e) { return JSON.stringify({ went: false, reason: "goBack() threw: " + String(e) }); }
    return JSON.stringify({ went: true, source: f.source });
  })()`;
}

export type BackDispatched = Dispatched & { went: boolean; reason?: string };

/**
 * Path selection mirrors dispatchTap, with one extra rule: a JS route that
 * answers "nothing to go back to" is *definitive* and never falls back. The
 * hardware key would still do something there — background the app on Android,
 * an edge swipe on iOS — and doing it silently is exactly the kind of
 * unannounced path switch the marker discipline exists to prevent.
 */
export async function dispatchBack(args: {
  driver: DeviceDriver;
  udid: string;
  via: InputVia;
  conn?: EvalConn;
  viewport?: Viewport;
}): Promise<BackDispatched> {
  if (args.via === "js" && !args.conn) {
    throw new UserInputError('via: "js" needs an active Metro connection — run `connect` first.');
  }

  let reason: string | undefined;
  if (args.via !== "os" && args.conn) {
    let res: any;
    try {
      res = asJson(await args.conn.evaluate(backExpression(), { timeoutMs: JS_INPUT_TIMEOUT_MS }));
    } catch (err) {
      if (args.via === "js") throw err;
      res = { went: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (res?.went) return { marker: "(input: js)", went: true };
    reason = res?.reason ?? "the app returned no result";
    if (res?.definitive) return { marker: "(input: js)", went: false, reason };
    if (args.via === "js") throw new UserInputError(`JS back failed: ${reason}`);
  } else if (args.via !== "os") {
    reason = "no Metro connection";
  }

  const t0 = Date.now();
  let os: OsPath;
  try {
    // iOS has no back key at all — the driver turns this into an edge swipe,
    // which is a real touch and belongs in the hot-touch record.
    os = await args.driver.pressKey(args.udid, "back", { viewport: args.viewport });
  } finally {
    recordTouch(args.udid, Date.now() - t0);
  }
  return {
    marker: osMarker(os, reason),
    went: true,
    note: hotNotice(args.udid),
  };
}

/**
 * Fires a TextInput's submit handlers. There is no OS half: scripting the
 * keyboard's return key needs a real touch on a keyboard that may not even be
 * up, so `via` never reaches here — the caller refuses `os` before calling.
 */
export async function dispatchSubmit(args: { conn?: EvalConn; into?: InputTarget }): Promise<SubmitResult> {
  if (!args.conn) {
    throw new UserInputError(
      'Submitting needs an active Metro connection — run `connect` first. There is no OS route: the keyboard return key is not scriptable.',
    );
  }
  const res: SubmitResult = asJson(
    await args.conn.evaluate(submitExpression(args.into ?? null), { timeoutMs: JS_INPUT_TIMEOUT_MS }),
  );
  if (res && typeof res.submitted === "boolean") return res;
  return { submitted: false, reason: "the submit expression returned nothing" };
}
