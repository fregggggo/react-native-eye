// Evaluated inside the app runtime over CDP. Hit-tests a point against the
// measured fiber tree, climbs to the nearest press handler and invokes it.
//
// Why this exists: touch delivery to a "hot" RN app in the iOS simulator was
// measured at 17-25s per event; the same press dispatched here costs ~1ms. The
// app offers the targets — the live app had 92 host fibers carrying responder
// handlers, 26 RCTView with onClick and 39 Pressable/TouchableOpacity with
// onPress — and they are reachable by the fiber walk fastLayout already does.
//
// What this deliberately does NOT do: decide whether the element may be pressed.
// resolveTarget in TypeScript matched the selector, applied the visibility and
// ambiguity refusals, and handed over a point. Re-deriving any of that in ES5
// would give `via: "js"` different selector semantics from `via: "os"`, which is
// worse than the bug being fixed.
import { SAFE, MEASURER, VISIBILITY } from "../layout/runtimeSnippets.js";

export type PressResult =
  | { pressed: true; component: string; handler: "onPress" | "onLongPress" | "onClick"; depth: number }
  | { pressed: false; reason: string };

/**
 * How far up the tree a handler may sit. The field test found the handler for a
 * tab button well above the host that owns the pixels; 30 covers that with room
 * to spare and still terminates on a pathological tree.
 */
const MAX_CLIMB = 30;

export function pressExpression(x: number, y: number, opts?: { longPress?: boolean }): string {
  return `(function () {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers || !hook.getFiberRoots) {
      return JSON.stringify({ pressed: false, reason: "React DevTools hook not present — not a dev build, or the app has not rendered yet" });
    }
    var fm = globalThis.nativeFabricUIManager;
    var PX = ${Number(x)}, PY = ${Number(y)};
    var WANT_LONG = ${opts?.longPress ? "true" : "false"};
    var MAX_CLIMB = ${MAX_CLIMB};
    var hosts = [];

    ${SAFE}
    ${MEASURER}
    ${VISIBILITY}

    // Every measurable host is a candidate, not just the ones fastLayout keeps:
    // the element under the point is often an unlabelled view with no testID.
    // Siblings are iterated and only children recurse — a long list would
    // otherwise grow the stack by one frame per row.
    //
    // hidesSubtree mirrors elementAtPoint's isVisible filter (search.ts):
    // a mounted-but-hidden screen (inactive tab, a stack scene below the top)
    // keeps a valid frame and measures at the same coordinates as the visible
    // one, so an element inside it must never become a hit candidate — hitIndex
    // has no way to tell it apart from the real target by geometry alone.
    function walk(fiber, hidden) {
      while (fiber) {
        var hiddenHere = hidden || hidesSubtree(fiber);
        if (!hiddenHere) {
          var m = safe(function () { return measurer(fiber.stateNode); });
          if (m) hosts.push({ m: m, fiber: fiber });
        }
        walk(fiber.child, hiddenHere);
        fiber = fiber.sibling;
      }
    }

    try {
      hook.renderers.forEach(function (_, id) {
        hook.getFiberRoots(id).forEach(function (r) { walk(r.current, false); });
      });
    } catch (e) {
      return JSON.stringify({ pressed: false, reason: "fiber walk failed: " + String(e) });
    }
    if (!hosts.length) {
      return JSON.stringify({ pressed: false, reason: "no measurable host components in the fiber tree" });
    }

    var out = new Array(hosts.length);
    var expected = hosts.length;
    var got = 0;
    var settle = null;
    var result = null;

    function measureInto(m, cb) {
      var called = false;
      function once(v) { if (!called) { called = true; cb(v); } }
      try {
        m(function (mx, my, mw, mh) { once(typeof mx === "number" ? { x: mx, y: my, w: mw, h: mh } : null); });
      } catch (e) { once(null); }
      return once;
    }
    function onOne() { got++; if (got >= expected && settle) settle(); }

    function componentName(fiber) {
      var t = safe(function () { return fiber.type; });
      if (typeof t === "string") return t;
      if (!t) return "Unknown";
      return safe(function () { return t.displayName; }) || safe(function () { return t.name; }) || "Unknown";
    }

    // elementAtPoint's rule, reproduced: the smallest-area frame containing the
    // point wins, and a later fiber wins a tie because tree order is paint order.
    // No viewport clipping here — the point came from a layout that already
    // clipped, so it lies inside the raw frame too, and an element wider than the
    // screen can never be the smallest anyway.
    function hitIndex() {
      var best = -1, bestArea = 0;
      for (var i = 0; i < out.length; i++) {
        var r = out[i];
        if (!r || !(r.w > 0) || !(r.h > 0)) continue;
        if (PX < r.x || PX > r.x + r.w || PY < r.y || PY > r.y + r.h) continue;
        var area = r.w * r.h;
        if (best < 0 || area <= bestArea) { best = i; bestArea = area; }
      }
      return best;
    }

    // One pass per preference class, not one preference order per fiber: a
    // Pressable renders a host View carrying onClick, so checking every name at
    // each level would take that nearer onClick and never reach the onLongPress
    // one level above it.
    function findHandler(hit, names) {
      var f = hit, depth = 0;
      while (f && depth <= MAX_CLIMB) {
        var p = safe(function () { return f.memoizedProps; });
        if (p && typeof p === "object") {
          var isHost = typeof safe(function () { return f.type; }) === "string";
          for (var i = 0; i < names.length; i++) {
            var n = names[i];
            var fn = safe(function () { return p[n]; });
            if (typeof fn === "function" && (n !== "onClick" || isHost)) {
              return { fn: fn, handler: n, depth: depth, component: componentName(f) };
            }
          }
        }
        // "return" is a reserved word — bracket access keeps every parser happy.
        f = safe(function () { return f["return"]; });
        depth++;
      }
      return null;
    }

    function dispatch() {
      var idx = hitIndex();
      if (idx < 0) {
        return JSON.stringify({ pressed: false, reason: "no element at (" + PX + ", " + PY + ") — the point is outside every measured host frame" });
      }
      var hit = hosts[idx].fiber;
      var found = null;
      if (WANT_LONG) found = findHandler(hit, ["onLongPress"]);
      if (!found) found = findHandler(hit, ["onPress", "onClick"]);
      if (!found) {
        return JSON.stringify({ pressed: false, reason: "no press handler in the ancestry of " + componentName(hit) + " (climbed " + MAX_CLIMB + " levels)" });
      }
      var ev = {
        nativeEvent: { pageX: PX, pageY: PY, locationX: 0, locationY: 0, timestamp: Date.now() },
        target: null,
        currentTarget: null,
        preventDefault: function () {},
        stopPropagation: function () {}
      };
      try { found.fn(ev); }
      catch (e) { return JSON.stringify({ pressed: false, reason: "handler threw: " + String(e) }); }
      return JSON.stringify({ pressed: true, component: found.component, handler: found.handler, depth: found.depth });
    }

    // fastLayout lets its settle and its backstop timer both call build(), because
    // building is pure. Pressing is not — the second call would deliver a second
    // touch — so the result is computed at most once.
    function dispatchOnce() {
      if (result === null) result = dispatch();
      return result;
    }

    for (var i = 0; i < hosts.length; i++) {
      (function (k) {
        var stop = measureInto(hosts[k].m, function (r) { out[k] = r; onOne(); });
        setTimeout(function () { stop(null); }, 400);
      })(i);
    }

    // Fabric calls back synchronously: the whole press is then one round trip.
    if (got >= expected) return dispatchOnce();
    return new Promise(function (resolve) {
      settle = function () { resolve(dispatchOnce()); };
      setTimeout(function () { resolve(dispatchOnce()); }, 600);
    });
  })()`;
}
