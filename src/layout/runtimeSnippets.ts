// ES5 fragments interpolated into expressions evaluated inside the app runtime
// (Hermes): no let/const, no arrow functions, no template literals. Shared by
// src/layout/fastLayout.ts and everything in src/input/, so that a fix to the
// fiber-access rules lands in one place instead of four.

/**
 * `function safe(fn)` — every property read inside an injected expression goes
 * through it.
 *
 * Not defensive decoration: a Reanimated style object throws when a property is
 * read (field test D4), and one unguarded read aborts the whole capture rather
 * than losing one element. Anything reached through `memoizedProps`, `type`,
 * `stateNode` or a style object is a candidate.
 */
export const SAFE = `
    function safe(fn) { try { return fn(); } catch (e) { return undefined; } }
`;

/**
 * `function measurer(sn)` — turns a fiber's `stateNode` into a
 * `function (cb) { cb(x, y, w, h); }`, or null when the node cannot be measured.
 *
 * Requires a variable `fm` (`globalThis.nativeFabricUIManager`) to be in scope
 * at the point of interpolation.
 *
 *   * Paper   — stateNode itself has measureInWindow (async callback).
 *   * Fabric  — stateNode is {node, canonical}; `canonical.publicInstance` only
 *               exists for components given a ref (a handful per screen), so the
 *               reliable handle is the shadow node driven through
 *               nativeFabricUIManager, whose callback fires synchronously — the
 *               whole capture then costs one round trip.
 */
export const MEASURER = `
    function measurer(sn) {
      if (!sn) return null;
      if (typeof sn.measureInWindow === "function") {
        return function (cb) { sn.measureInWindow(cb); };
      }
      if (sn.canonical && sn.canonical.publicInstance && typeof sn.canonical.publicInstance.measureInWindow === "function") {
        var pi = sn.canonical.publicInstance;
        return function (cb) { pi.measureInWindow(cb); };
      }
      if (sn.node && fm && typeof fm.measureInWindow === "function") {
        var n = sn.node;
        return function (cb) { fm.measureInWindow(n, cb); };
      }
      return null;
    }
`;

/**
 * `function hidesSubtree(fiber)` (plus its helper `styleHides`) — true when a
 * fiber's own props say its whole subtree is invisible: a11y-hidden props,
 * `display:none`/`opacity:0` in style, an inactive react-native-screens screen
 * (`activityState === 0`), or a react-navigation scene that is not the current
 * one (`focused === false`, or `index` disagreeing with `navigationState.index`).
 *
 * Extracted byte-identical from `fastLayout.ts`'s original inline copy so that
 * `press.ts`'s hit-test agrees with `fastLayout`'s / `elementAtPoint`'s idea of
 * "visible" — a mounted-but-hidden screen keeps a valid frame and measures at
 * the same coordinates as the visible one, so geometry alone cannot tell them
 * apart (see `elementAtPoint`'s doc comment in `search.ts`).
 *
 * Requires `safe()` (see `SAFE` above) to be in scope at the point of
 * interpolation. Does not walk the tree itself — callers thread the result down
 * through their own recursion, the way `fastLayout.ts`'s `walk` does with
 * `hidden || hidesSubtree(fiber)`.
 */
export const VISIBILITY = `
    // Styles are read one property at a time and never spread: an Animated /
    // Reanimated style object throws when treated as a plain object, and that
    // exception would abort the whole capture.
    function styleHides(st, depth) {
      if (!st || depth > 3) return false;
      if (Array.isArray(st)) {
        for (var i = 0; i < st.length; i++) if (styleHides(st[i], depth + 1)) return true;
        return false;
      }
      if (typeof st !== "object") return false;
      if (safe(function () { return st.display; }) === "none") return true;
      if (safe(function () { return st.opacity; }) === 0) return true;
      return false;
    }

    function hidesSubtree(fiber) {
      var p = fiber.memoizedProps;
      if (!p || typeof p !== "object") return false;
      if (safe(function () { return p.accessibilityElementsHidden; }) === true) return true;
      if (safe(function () { return p["aria-hidden"]; }) === true) return true;
      if (safe(function () { return p.importantForAccessibility; }) === "no-hide-descendants") return true;
      // react-native-screens: 0 = inactive (kept mounted, not on screen).
      if (safe(function () { return p.activityState; }) === 0) return true;
      // react-navigation scenes. A stack scene below the top carries
      // focused:false; a tab/pager scene knows its own index and the navigator's
      // current one. This is the only reliable signal for those screens: they stay
      // mounted, and measureInWindow reports them at the same coordinates as the
      // visible one — geometry cannot tell them apart, and hit testing is defeated
      // by any full-screen overlay on the live scene.
      if (safe(function () { return p.focused; }) === false) return true;
      var idx = safe(function () { return p.index; });
      var navIdx = safe(function () { return p.navigationState && p.navigationState.index; });
      if (typeof idx === "number" && typeof navIdx === "number" && idx !== navIdx) return true;
      if (safe(function () { return p.display; }) === "none") return true;
      return styleHides(safe(function () { return p.style; }), 0);
    }
`;
