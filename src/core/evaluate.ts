// React Native ships its own Promise polyfill (the `promise` package), so a
// promise returned from Runtime.evaluate is a plain object to the Hermes
// inspector: `awaitPromise: true` is silently ignored and `returnByValue`
// serialises the polyfill's internals ({_h,_i,_j,_k}) instead of the value.
//
// So we never rely on awaitPromise. The wrapper below runs the code, and:
//   * a plain value comes back in the same round trip (no extra latency);
//   * a thenable is parked in a global slot and its settled value is picked up
//     by polling — using the app's own `.then`, whatever implements it.
//
// Hermes has no async/await in evaluated code, so every snippet here is ES5.

export const SLOTS_GLOBAL = "__RNE_EV__";

export type EvalEnvelope =
  | { s: "ok"; v?: unknown }
  | { s: "err"; e: string }
  | { s: "pending"; t?: string }
  | { s: "lost" };

export function evalWrapper(code: string): string {
  return `(function () {
    var slots = globalThis.${SLOTS_GLOBAL} || (globalThis.${SLOTS_GLOBAL} = {});
    var v;
    try { v = (0, eval)(${JSON.stringify(code)}); }
    catch (e) { return JSON.stringify({ s: "err", e: String((e && e.stack) || e) }); }
    if (v && typeof v.then === "function") {
      var t = "t" + (globalThis.__RNE_EVN__ = (globalThis.__RNE_EVN__ || 0) + 1);
      slots[t] = { d: false };
      v.then(
        function (x) { slots[t] = { d: true, v: x }; },
        function (e) { slots[t] = { d: true, e: String((e && e.stack) || e) }; }
      );
      return JSON.stringify({ s: "pending", t: t });
    }
    try { return JSON.stringify({ s: "ok", v: v }); }
    catch (e) { return JSON.stringify({ s: "ok", v: String(v) }); }
  })()`;
}

export function evalPoll(token: string): string {
  const t = JSON.stringify(token);
  return `(function () {
    var slots = globalThis.${SLOTS_GLOBAL};
    if (!slots || !slots[${t}]) return JSON.stringify({ s: "lost" });
    var s = slots[${t}];
    if (!s.d) return JSON.stringify({ s: "pending" });
    delete slots[${t}];
    if (s.e !== undefined) return JSON.stringify({ s: "err", e: s.e });
    try { return JSON.stringify({ s: "ok", v: s.v }); }
    catch (e) { return JSON.stringify({ s: "ok", v: String(s.v) }); }
  })()`;
}

export function evalDiscard(token: string): string {
  const t = JSON.stringify(token);
  return `(function () { var s = globalThis.${SLOTS_GLOBAL}; if (s) delete s[${t}]; return true; })()`;
}

export function parseEnvelope(raw: unknown): EvalEnvelope {
  if (typeof raw !== "string") {
    // Not our envelope: an older/foreign runtime, or the wrapper never ran.
    return { s: "ok", v: raw };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.s === "string") return parsed as EvalEnvelope;
  } catch {
    /* fall through — a bare string result */
  }
  return { s: "ok", v: raw };
}

// The shape RN's Promise polyfill serialises to. Recognised so that a value
// that slipped past the wrapper is reported as such instead of handed to a
// caller that would read `undefined` off it.
export function isPolyfilledPromiseShape(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const keys = Object.keys(v as object);
  return keys.length > 0 && keys.every((k) => k === "_h" || k === "_i" || k === "_j" || k === "_k");
}
