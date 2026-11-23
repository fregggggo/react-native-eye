// Whether the app is in the foreground, asked of the app itself.
//
// The JS paths act on the React tree, and the React tree is still there when
// the app is not on screen: a JS press on a backgrounded app "succeeds" and
// changes state nobody can see, and a JS layout lists a screen the device is
// not showing (field test: every input after the app was sent to the
// background reported success). Only the native AppState module knows.
//
// `require` does not exist in evaluated code, so the JS AppState singleton is
// out of reach; the native module is reached the way RN's own TurboModuleRegistry
// does — `__turboModuleProxy(name)` when the bridge is up, the bridgeless
// `nativeModuleProxy` host object otherwise (RN 0.83 TurboModuleBinding).
// getCurrentAppState answers through a callback, i.e. asynchronously.

import { UserInputError } from "../core/errors.js";
import type { EvalConn } from "../tools/layout.js";

/** How long the app gets to answer before the state counts as unknown. */
const PROBE_MS = 400;

/**
 * `function rneAppState(cb)` — calls `cb` exactly once with "active",
 * "background", "inactive" or null (cannot tell). Synchronously with null when
 * the module is not reachable, so a guarded expression costs nothing extra
 * there and behaves exactly as it did before the guard.
 */
const APP_STATE_FN = `
    function rneAppState(cb) {
      var called = false;
      function once(s) { if (!called) { called = true; cb(typeof s === "string" ? s : null); } }
      var mod = null;
      try {
        var tmp = globalThis.__turboModuleProxy;
        if (typeof tmp === "function") mod = tmp("AppState");
      } catch (e) { mod = null; }
      if (!mod) {
        try { var nmp = globalThis.nativeModuleProxy; if (nmp) mod = nmp.AppState; } catch (e) { mod = null; }
      }
      var fn = null;
      try { fn = mod && mod.getCurrentAppState; } catch (e) { fn = null; }
      if (typeof fn !== "function") { once(null); return; }
      try {
        mod.getCurrentAppState(
          function (d) { var s = null; try { s = d && d.app_state; } catch (e) { s = null; } once(s); },
          function () { once(null); }
        );
      } catch (e) { once(null); return; }
      setTimeout(function () { once(null); }, ${PROBE_MS});
    }
`;

/** `{ state }` as JSON: the app's AppState, or null when it cannot be told. */
export function appStateExpression(): string {
  return `/* rne:appstate */(function () {
    ${APP_STATE_FN}
    var result = null, resolveFn = null;
    rneAppState(function (s) { result = JSON.stringify({ state: s }); if (resolveFn) resolveFn(result); });
    if (result !== null) return result;
    return new Promise(function (resolve) { resolveFn = resolve; });
  })()`;
}

/**
 * Wraps an input expression so it runs only while the app is in the
 * foreground. When the app is backgrounded or inactive the expression is never
 * run and the result is `{ background: <state>, reason }` instead — callers
 * check `background` before anything else (see `notForeground`). The leading
 * `/* rne:… *\/` marker is kept in front: callers and tests identify
 * expressions by it.
 */
export function foregroundGuarded(expr: string): string {
  const m = /^\/\* rne:[^*]* \*\//.exec(expr);
  const marker = m ? m[0] : "";
  const body = m ? expr.slice(marker.length) : expr;
  return `${marker}(function () {
    ${APP_STATE_FN}
    function rneBody() { return ${body}; }
    var state = null, decided = false, resolveFn = null, rejectFn = null;
    function run() {
      if (state === "background" || state === "inactive") {
        return JSON.stringify({ background: state, reason: "the app is not in the foreground (AppState: " + state + ")" });
      }
      return rneBody();
    }
    rneAppState(function (s) {
      state = s;
      decided = true;
      if (!resolveFn) return;
      // Chained by hand: not every Promise implementation adopts a thenable.
      try {
        var r = run();
        if (r && typeof r.then === "function") r.then(resolveFn, rejectFn);
        else resolveFn(r);
      } catch (e) { rejectFn(e); }
    });
    if (decided) return run();
    return new Promise(function (resolve, reject) { resolveFn = resolve; rejectFn = reject; });
  })()`;
}

export type AppState = "active" | "background" | "inactive";

/** The app's state, or null when it cannot be told (never throws). */
export async function probeAppState(conn: EvalConn, timeoutMs = 2000): Promise<AppState | string | null> {
  try {
    const raw = await conn.evaluate(appStateExpression(), { timeoutMs });
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const s = parsed && typeof parsed === "object" ? parsed.state : undefined;
    return typeof s === "string" && s ? s : null;
  } catch {
    return null;
  }
}

/** True for the states in which nothing the JS path does is on screen. */
export function isBackground(state: unknown): state is "background" | "inactive" {
  return state === "background" || state === "inactive";
}

/**
 * The refusal for JS input on an app that is not in the foreground. A
 * UserInputError, and never a fallback: an OS touch would land on whatever
 * *is* on screen — the home screen, another app.
 */
export function notForeground(state: string, action: string): UserInputError {
  return new UserInputError(
    `Cannot ${action}: the app is not in the foreground (AppState: ${state}) — the device is showing something else, ` +
      `so neither a JS dispatch nor an OS touch would reach it. Bring it to the front with launch_app, then retry.`,
  );
}

/** The warning a layout or observe response leads with when the app is not on screen. */
export function backgroundWarning(state: string): string {
  return (
    `WARNING: the app is not in the foreground (AppState: ${state}). The elements below are the app's React tree, ` +
    `not what the device shows. Bring it to the front with launch_app before acting on them.`
  );
}
