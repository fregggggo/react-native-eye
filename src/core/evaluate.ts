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

/**
 * Hermes' CDP agent hands the source it receives to the compiler re-encoded
 * one UTF-16 unit at a time, so a character outside the BMP arrives as two
 * encoded surrogates and the whole expression fails to compile ("Invalid UTF-8
 * code point 0xd83d") — eval_js of `"🐱".length`, type_text of an emoji. Every
 * surrogate unit, paired or lone, is therefore sent as a `\uXXXX` escape,
 * which leaves the source pure BMP and means the same inside string,
 * template and regex literals. (An astral character in an identifier would not
 * survive this; nothing we send, and no realistic snippet, has one.)
 */
export function escapeSurrogates(source: string): string {
  return source.replace(/(\\*)([\uD800-\uDFFF])/g, (_m, slashes: string, unit: string) => {
    // An odd run of backslashes escapes the unit itself (`"\🐱"` is an
    // identity escape, i.e. just the character); keeping that backslash would
    // turn the new escape into a literal backslash followed by "ud83d".
    const kept = slashes.length % 2 === 1 ? slashes.slice(1) : slashes;
    return `${kept}\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

/**
 * The same problem in the other direction: the envelope the app hands back can
 * carry an emoji from app state or a label. Escaping its surrogates inside the
 * app keeps the reply pure BMP too; it is still the same JSON to JSON.parse.
 */
const SAFE_JSON = `function (s) {
      return typeof s === "string"
        ? s.replace(/[\\ud800-\\udfff]/g, function (c) { return "\\\\u" + c.charCodeAt(0).toString(16); })
        : s;
    }`;

export type EvalEnvelope =
  | { s: "ok"; v?: unknown }
  | { s: "err"; e: string }
  | { s: "pending"; t?: string }
  | { s: "lost" };

export function evalWrapper(code: string): string {
  // The code is escaped before it is embedded, so the indirect eval below also
  // compiles pure-BMP source, not just the wrapper around it.
  return `(function () {
    var safe = ${SAFE_JSON};
    var slots = globalThis.${SLOTS_GLOBAL} || (globalThis.${SLOTS_GLOBAL} = {});
    var v;
    try { v = (0, eval)(${JSON.stringify(escapeSurrogates(code))}); }
    catch (e) { return safe(JSON.stringify({ s: "err", e: String((e && e.stack) || e) })); }
    if (v && typeof v.then === "function") {
      var t = "t" + (globalThis.__RNE_EVN__ = (globalThis.__RNE_EVN__ || 0) + 1);
      slots[t] = { d: false };
      v.then(
        function (x) { slots[t] = { d: true, v: x }; },
        function (e) { slots[t] = { d: true, e: String((e && e.stack) || e) }; }
      );
      return JSON.stringify({ s: "pending", t: t });
    }
    try { return safe(JSON.stringify({ s: "ok", v: v })); }
    catch (e) { return safe(JSON.stringify({ s: "ok", v: String(v) })); }
  })()`;
}

export function evalPoll(token: string): string {
  const t = JSON.stringify(token);
  return `(function () {
    var safe = ${SAFE_JSON};
    var slots = globalThis.${SLOTS_GLOBAL};
    if (!slots || !slots[${t}]) return JSON.stringify({ s: "lost" });
    var s = slots[${t}];
    if (!s.d) return JSON.stringify({ s: "pending" });
    delete slots[${t}];
    if (s.e !== undefined) return safe(JSON.stringify({ s: "err", e: s.e }));
    try { return safe(JSON.stringify({ s: "ok", v: s.v })); }
    catch (e) { return safe(JSON.stringify({ s: "ok", v: String(s.v) })); }
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
