// ES5 fragments interpolated into expressions evaluated inside the app runtime
// (Hermes): no let/const, no arrow functions, no template literals. Shared by
// src/layout/fastLayout.ts and everything in src/input/, so that a fix to the
// fiber-access rules lands in one place instead of four.

/**
 * A JS literal for an arbitrary value, safe to interpolate into an injected
 * expression. JSON.stringify emits U+2028/U+2029 raw, and those are not legal
 * inside an ES5 string literal — selector text is caller-controlled, so this is
 * not theoretical.
 */
export function jsLiteral(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

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
 * `function navScene(p)` — whether props carrying `focused` belong to a
 * react-navigation *scene* rather than to anything else that happens to take a
 * `focused` prop.
 *
 * `focused:false` alone is not evidence of a hidden screen: the default
 * BottomTabBar renders `<BottomTabItem focused={false}>` for every inactive
 * tab (@react-navigation/bottom-tabs 6 and 7), and app components use the same
 * name for "this field has focus". Treating those as inactive screens hid every
 * inactive tab button. A scene carries its navigation context (`descriptor`,
 * `route` or `navigation` — native-stack's SceneView, the tab navigators'
 * Screen; `scene.descriptor` / `scene.route` — the JS stack's CardContainer)
 * and no press handler of its own; a tab button carries both.
 *
 * Requires `safe()` in scope.
 */
export const NAV_SCENE = `
    function navScene(p) {
      if (typeof safe(function () { return p.onPress; }) === "function") return false;
      if (typeof safe(function () { return p.onLongPress; }) === "function") return false;
      var d = safe(function () { return p.descriptor; });
      if (d && typeof d === "object") return true;
      var sc = safe(function () { return p.scene; });
      if (sc && typeof sc === "object" && (safe(function () { return sc.descriptor; }) || safe(function () { return sc.route; }))) return true;
      var r = safe(function () { return p.route; });
      if (r && typeof r === "object" && typeof safe(function () { return r.key; }) === "string") return true;
      var n = safe(function () { return p.navigation; });
      return !!(n && typeof n === "object" && typeof safe(function () { return n.navigate; }) === "function");
    }
`;

/**
 * `function textFrom(children, depth)` — the label fastLayout gives a host: its
 * `children` prop flattened to a string (nested Text elements included, three
 * levels deep). Shared so the press and scroll expressions can recognise the
 * element a selector resolved to by the same label the listing showed.
 */
export const TEXT_FROM = `
    function textFrom(children, depth) {
      if (depth > 3 || children == null) return "";
      if (typeof children === "string" || typeof children === "number") return String(children);
      if (Array.isArray(children)) {
        var s = "";
        for (var i = 0; i < children.length; i++) s += textFrom(children[i], depth + 1);
        return s;
      }
      if (children.props) return textFrom(children.props.children, depth + 1);
      return "";
    }
`;

/**
 * `function a11yLabel(p)` — `accessibilityLabel`, or `aria-label` (RN 0.71+),
 * trimmed; "" when neither is a non-empty string. Requires `safe()`.
 */
export const A11Y_LABEL = `
    function a11yLabel(p) {
      var v = safe(function () { return p.accessibilityLabel; });
      if (typeof v !== "string" || !v.trim()) v = safe(function () { return p["aria-label"]; });
      return typeof v === "string" ? v.trim() : "";
    }
`;

/**
 * `function isTarget(p, T)` — whether a host's props are the element a
 * selector resolved to: same testID, or the same label (children text,
 * placeholder, or accessibility label). `T` is `{ testID?, text? }`. Requires
 * `safe()`, `TEXT_FROM` and `A11Y_LABEL` in scope.
 *
 * Geometry cannot do this: a bottom sheet's button and the smaller list label
 * underneath it both contain the button's centre, and whichever rule picks
 * between overlapping frames can be wrong. The label cannot.
 */
export const IS_TARGET = `
    function isTarget(p, T) {
      if (!T || !p || typeof p !== "object") return false;
      if (T.testID) return safe(function () { return p.testID; }) === T.testID;
      if (!T.text) return false;
      var t = safe(function () { return textFrom(p.children, 0).trim(); });
      if (t) return t === T.text;
      if (safe(function () { return p.placeholder; }) === T.text) return true;
      return a11yLabel(p) === T.text;
    }
`;

/**
 * Style and touch reads shared by the layout, press and scroll expressions.
 * Requires `safe()`.
 *
 *   * `styleValue(style, key, 0)` — one key from a style prop that may be an
 *     array (later entries win, as in StyleSheet.flatten). Never spreads: an
 *     Animated/Reanimated style throws when treated as a plain object.
 *   * `clipsChildren(type, props)` — whether a host clips what is drawn inside
 *     it: every native scroll view (its frame is the viewport onto its content)
 *     and any view styled `overflow: "hidden"`. A row scrolled past the top of
 *     a list that sits below a header still lies inside the window, so the
 *     window alone cannot say it is hidden; its scroll view can.
 *   * `pointerEventsOf(props)` — RN's touch rule, from the prop or from style
 *     (RN 0.71+ accepts both): "none" takes a view and everything in it out of
 *     hit testing, "box-none" only the view, "box-only" only its children.
 */
export const STYLE_PROPS = `
    function styleValue(st, key, depth) {
      if (!st || depth > 3) return undefined;
      if (Array.isArray(st)) {
        for (var i = st.length - 1; i >= 0; i--) {
          var v = styleValue(st[i], key, depth + 1);
          if (v !== undefined) return v;
        }
        return undefined;
      }
      if (typeof st !== "object") return undefined;
      return safe(function () { return st[key]; });
    }
    function clipsChildren(type, p) {
      if (typeof type === "string" && /ScrollView$/.test(type)) return true;
      if (!p || typeof p !== "object") return false;
      return styleValue(safe(function () { return p.style; }), "overflow", 0) === "hidden";
    }
    function pointerEventsOf(p) {
      if (!p || typeof p !== "object") return undefined;
      var v = safe(function () { return p.pointerEvents; });
      if (typeof v === "string") return v;
      v = styleValue(safe(function () { return p.style; }), "pointerEvents", 0);
      return typeof v === "string" ? v : undefined;
    }
`;

/**
 * `function hidesSubtree(fiber)` (plus its helper `styleHides`) — true when a
 * fiber's own props say its whole subtree is invisible: a11y-hidden props,
 * `display:none`/`opacity:0` in style, an inactive react-native-screens screen
 * (`activityState === 0`), or a react-navigation scene that is not the current
 * one (`focused === false` on a scene — see `NAV_SCENE` — or `index`
 * disagreeing with `navigationState.index`).
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
export const VISIBILITY = `${NAV_SCENE}
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
      // by any full-screen overlay on the live scene. Only on a scene: a tab
      // button says focused:false too, and it is very much on screen.
      if (safe(function () { return p.focused; }) === false && navScene(p)) return true;
      var idx = safe(function () { return p.index; });
      var navIdx = safe(function () { return p.navigationState && p.navigationState.index; });
      if (typeof idx === "number" && typeof navIdx === "number" && idx !== navIdx) return true;
      if (safe(function () { return p.display; }) === "none") return true;
      return styleHides(safe(function () { return p.style; }), 0);
    }
`;
