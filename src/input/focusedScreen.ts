// ES5 fragment interpolated into expressions evaluated inside the app runtime
// (Hermes): no let/const, no arrow functions, no template literals. Kept in its
// own file rather than inside text.ts so press.ts and scroll.ts can rank their
// own targets by the same rule when they need it.

/**
 * `function sceneRank(fiber)` — walks `fiber.return` upward to the nearest
 * enclosing navigator scene and reports `{ focused, depth, known }`:
 *
 *   * `focused` — this is the scene currently on top of its navigator.
 *   * `depth`   — distance from the top of that stack, 0 for the topmost.
 *   * `known`   — a navigator was actually found. Without one there is only one
 *                 screen, so the answer is `{ focused: true, depth: 0 }` and
 *                 callers can tell that apart from a real ranking.
 *
 * Why this exists: field test, a stack with the same screen pushed twice (Post ->
 * Post, or a chat composer reopened). react-native-screens keeps the screen
 * underneath mounted, and `measureInWindow` reports it at the same coordinates
 * as the visible one — two TextInputs with the same testID and placeholder, both
 * passing every visibility check. Geometry cannot separate them; only the scene
 * each one sits in can.
 *
 * The signals are the same ones `hidesSubtree` in `src/layout/runtimeSnippets.ts`
 * already trusts for the layout capture (activityState, `focused`, pager index vs
 * `navigationState.index`) — copied rather than imported because that fragment
 * answers a yes/no question and this one needs the ordering. Props are tested
 * before display names because native-stack renders the screen as `RNSScreen`,
 * `Screen` or `ScreenStackItem` depending on the version, and the prop is stable
 * across all three; a fiber recognisable only by name carries no signal about
 * which screen is current, so it is deliberately not treated as a boundary —
 * stopping the walk there would hide the real scene above it.
 *
 * Requires `safe()` (see `SAFE` in `src/layout/runtimeSnippets.ts`) to be in
 * scope at the point of interpolation.
 */
export const SCENE_RANK = `
    // 2 = on top, 1 = mounted below the top, 0 = detached. Returns null when the
    // fiber says nothing about navigation at all.
    function sceneState(p) {
      if (!p || typeof p !== "object") return null;
      var a = safe(function () { return p.activityState; });
      if (typeof a === "number") return a <= 0 ? 0 : (a >= 2 ? 2 : 1);
      // react-native-screens before 3.x — and the shims that still mirror it —
      // pass an "active" 0/1 prop instead, where 1 is the screen on top.
      var b = safe(function () { return p.active; });
      if (typeof b === "number") return b === 0 ? 0 : 2;
      // react-navigation's JS stack and tab scene wrappers.
      var f = safe(function () { return p.focused; });
      if (typeof f === "boolean") return f ? 2 : 1;
      // A pager scene knows its own index and the navigator's current one.
      var i = safe(function () { return p.index; });
      var n = safe(function () { return p.navigationState && p.navigationState.index; });
      if (typeof i === "number" && typeof n === "number") return i === n ? 2 : 1;
      return null;
    }

    function containsScene(fiber, depth) {
      if (!fiber || depth > 6) return false;
      if (sceneState(safe(function () { return fiber.memoizedProps; })) !== null) return true;
      var c = safe(function () { return fiber.child; });
      while (c) {
        if (containsScene(c, depth + 1)) return true;
        c = safe(function () { return c.sibling; });
      }
      return false;
    }

    // How many scenes are stacked on top of this one, or null when they are not
    // siblings at any level. A ScreenStack renders one child per pushed route in
    // push order, so counting the scene branches after this one gives the
    // distance from the top — but the screens are never direct siblings (each
    // route is wrapped in a scene view first), so the comparison climbs until it
    // reaches the level where the routes sit side by side.
    function stackDepth(sceneFiber) {
      var node = sceneFiber;
      var hops = 0;
      while (node && hops < 8) {
        var parent = safe(function () { return node.return; });
        if (!parent) return null;
        var c = safe(function () { return parent.child; });
        var total = 0, after = 0, seen = false;
        while (c) {
          if (c === node || containsScene(c, 0)) {
            total++;
            if (c === node) seen = true;
            else if (seen) after++;
          }
          c = safe(function () { return c.sibling; });
        }
        if (seen && total > 1) return after;
        node = parent;
        hops++;
      }
      return null;
    }

    function sceneRank(fiber) {
      // Starts at the parent: the nearest *enclosing* scene. A fiber carrying a
      // focus-ish prop of its own (a tab bar icon does) is not the screen it is on.
      var f = safe(function () { return fiber.return; });
      var hops = 0;
      while (f && hops < 60) {
        var st = sceneState(safe(function () { return f.memoizedProps; }));
        if (st !== null) {
          var focused = st === 2;
          // The state alone only says "below the top"; sibling order says how far
          // below, which is what separates two instances of the same screen.
          var depth = focused ? 0 : (st === 0 ? 2 : 1);
          if (!focused) {
            var order = stackDepth(f);
            if (order !== null && order > 0) depth = order;
          }
          return { focused: focused, depth: depth, known: true };
        }
        f = safe(function () { return f.return; });
        hops++;
      }
      // No navigator above this fiber: one screen, and it is the one on screen.
      return { focused: true, depth: 0, known: false };
    }
`;
