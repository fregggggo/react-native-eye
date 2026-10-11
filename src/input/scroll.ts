import { SAFE, MEASURER } from "../layout/runtimeSnippets.js";

export type ScrollResult =
  | { scrolled: true; container: string; method: string }
  | { scrolled: false; reason: string };

/**
 * `scrollBy` reports where the container was and where it was sent, because
 * unlike `scroll_to` there is no element to check afterwards: "it moved" is the
 * only evidence the caller gets that the gesture did anything at all.
 */
export type ScrollByResult =
  | { scrolled: true; container: string; method: string; from: number; to: number }
  | { scrolled: false; reason: string };

/** Absolute (`scroll_to`) or relative (`swipe`) — the only difference is the offset. */
type Mode = { kind: "To" } | { kind: "By"; dx: number; dy: number };

/**
 * Finds the scroll container at (x, y) and scrolls it, without a touch.
 *
 * The point is resolved in TypeScript — this expression never matches a
 * selector. It measures the tree the way `fastLayout` does, hit-tests the point
 * against *every* measured host (in `To` mode the target is off-screen by
 * definition, so the visible-only rule `get_layout({at})` uses would find
 * nothing), then climbs `fiber.return` for the nearest ancestor whose display
 * name is in the adapter table and whose instance actually carries the method.
 *
 * Three rules make the climb behave on real trees:
 *   * a *known* name with no callable method does not stop the climb. A FlatList
 *     row's first scroll-ish ancestor is the host RCTScrollView, and a native
 *     host instance has no scrollTo — stopping there would strand every list.
 *   * a *deferred* entry (RecyclerListView) is remembered and used only if
 *     nothing else is found above it. FlashList renders a RecyclerListView, and
 *     FlashList is the component the caller wrote; deferring lets it win while
 *     still handling a RecyclerListView used directly.
 *   * an *unrecognised* container is remembered and reported only if nothing
 *     usable is found above it — the name is the entry missing from the table.
 */
function scrollExpression(x: number, y: number, mode: Mode): string {
  const by = mode.kind === "By";
  return `/* rne:scroll${mode.kind} */(function () {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers || !hook.getFiberRoots) {
      return JSON.stringify({ scrolled: false, reason: "React DevTools hook not present — not a dev build, or the app has not rendered yet" });
    }
    var fm = globalThis.nativeFabricUIManager;
    var TX = ${Math.round(x)}, TY = ${Math.round(y)};
    var BY = ${by ? "true" : "false"};
    var DX = ${by ? Math.round((mode as { dx: number }).dx) : 0}, DY = ${by ? Math.round((mode as { dy: number }).dy) : 0};
    var MAX = 1500;
    var hosts = [];
    var truncated = false;

    ${SAFE}
    ${MEASURER}

    // Keyed on the component's display name; the value is the instance method
    // that takes an *absolute* content offset. Every entry is RN's real API:
    // ScrollView.scrollTo({x, y, animated}),
    // VirtualizedList.scrollToOffset({offset, animated}), and the two
    // third-party lists that copy VirtualizedList's signature exactly.
    // RecyclerListView shares the *name* but not the signature — it takes
    // positional (x, y, animate) — so it carries its own flag rather than
    // being called with an object it would read as NaN.
    var ADAPTERS = [
      { re: /^(RCT)?ScrollView$/, method: "scrollTo" },
      { re: /^(VirtualizedList|VirtualizedSectionList|FlatList|SectionList)$/, method: "scrollToOffset" },
      { re: /^(FlashList|LegendList)$/, method: "scrollToOffset" },
      { re: /^RecyclerListView$/, method: "scrollToOffset", positional: true, defer: true }
    ];

    // AnimatedComponent(ScrollView), withTheme(FlatList): the wrapper name says
    // nothing, the wrapped one says everything.
    function baseName(n) {
      var i = n.indexOf("(");
      if (i > 0 && n.charAt(n.length - 1) === ")") return n.slice(i + 1, n.length - 1);
      return n;
    }

    function nameOf(fiber) {
      var t = safe(function () { return fiber.type; });
      if (typeof t === "string") return t;
      if (t) {
        var n = safe(function () { return t.displayName; });
        if (typeof n === "string" && n) return n;
        n = safe(function () { return t.name; });
        if (typeof n === "string" && n) return n;
        // forwardRef / memo keep the real component one level in.
        n = safe(function () { return t.render && (t.render.displayName || t.render.name); });
        if (typeof n === "string" && n) return n;
        n = safe(function () { return t.type && (t.type.displayName || t.type.name); });
        if (typeof n === "string" && n) return n;
      }
      var et = safe(function () { return fiber.elementType; });
      return typeof et === "string" ? et : "";
    }

    function adapterFor(name) {
      if (!name) return null;
      var b = baseName(name);
      for (var i = 0; i < ADAPTERS.length; i++) if (ADAPTERS[i].re.test(b)) return ADAPTERS[i];
      return null;
    }

    // "Is this a scroll container we do not know?" — asked only when the name is
    // not in the table. The content view is excluded explicitly: it is the thing
    // being scrolled, not the thing that scrolls.
    function scrollish(name, p) {
      var b = baseName(name || "");
      if (!b) return false;
      if (/Content(View|Container)/.test(b)) return false;
      if (/(scroll|pager|carousel|swiper|recycler)/i.test(b)) return true;
      if (!p || typeof p !== "object") return false;
      if (typeof safe(function () { return p.onScroll; }) === "function") return true;
      if (typeof safe(function () { return p.renderItem; }) === "function") return true;
      if (typeof safe(function () { return p.onEndReached; }) === "function") return true;
      if (safe(function () { return p.contentContainerStyle; }) !== undefined) return true;
      return false;
    }

    // Class components keep the instance on stateNode; a Fabric host keeps the
    // public instance under canonical; forwardRef + useImperativeHandle (the
    // @legendapp/list shape) puts it on the ref instead.
    function callable(fiber, method) {
      var cands = [];
      var sn = safe(function () { return fiber.stateNode; });
      if (sn) {
        cands.push(sn);
        var pi = safe(function () { return sn.canonical && sn.canonical.publicInstance; });
        if (pi) cands.push(pi);
      }
      var ref = safe(function () { return fiber.ref; });
      if (ref && typeof ref === "object") {
        var rc = safe(function () { return ref.current; });
        if (rc) cands.push(rc);
      }
      for (var i = 0; i < cands.length; i++) {
        var c = cands[i];
        if (safe(function () { return typeof c[method]; }) === "function") return c;
      }
      return null;
    }

    // React keeps two fibers per node, and a child's \`return\` may name either:
    // after a re-render (the first scroll of a virtualised list is enough) the
    // climb lands on the *alternate* of the scroll view — same stateNode, but
    // not the object the root walk measured, and with a stale \`child\` and stale
    // props. Every fiber the walk visits is recorded so the climb can swap an
    // alternate for its current twin (field test 3 D36).
    var walked = typeof Set === "function" ? new Set() : null;
    function current(fiber) {
      if (!fiber || !walked || walked.has(fiber)) return fiber;
      var alt = safe(function () { return fiber.alternate; });
      return alt && walked.has(alt) ? alt : fiber;
    }

    // Siblings are iterated, only children recurse — a long list would otherwise
    // grow the stack by one frame per row.
    function walk(fiber) {
      while (fiber) {
        if (walked) walked.add(fiber);
        var m = measurer(safe(function () { return fiber.stateNode; }));
        if (m) {
          if (hosts.length >= MAX) truncated = true;
          else hosts.push({ fiber: fiber, m: m, r: null });
        }
        walk(safe(function () { return fiber.child; }));
        fiber = safe(function () { return fiber.sibling; });
      }
    }

    try {
      hook.renderers.forEach(function (_, id) {
        hook.getFiberRoots(id).forEach(function (r) { walk(r.current); });
      });
    } catch (e) {
      return JSON.stringify({ scrolled: false, reason: "fiber walk failed: " + String(e) });
    }
    if (!hosts.length) {
      return JSON.stringify({ scrolled: false, reason: "no measurable host components in the tree" });
    }

    function rectFor(fiber) {
      var alt = safe(function () { return fiber.alternate; });
      for (var i = 0; i < hosts.length; i++) {
        var h = hosts[i];
        if ((h.fiber === fiber || (alt && h.fiber === alt)) && h.r && h.r.w > 0 && h.r.h > 0) return h.r;
      }
      return null;
    }
    function firstHostBelow(fiber, depth) {
      if (!fiber || depth > 5) return null;
      var c = safe(function () { return fiber.child; });
      while (c) {
        if (rectFor(c)) return c;
        var d = firstHostBelow(c, depth + 1);
        if (d) return d;
        c = safe(function () { return c.sibling; });
      }
      return null;
    }
    // A composite ScrollView/FlatList is never measured itself; its frame is the
    // host scroll view it renders.
    function hostOf(fiber) { return rectFor(fiber) ? fiber : firstHostBelow(fiber, 0); }

    function hitTest() {
      var best = null;
      for (var i = 0; i < hosts.length; i++) {
        var r = hosts[i].r;
        if (!r || !(r.w > 0) || !(r.h > 0)) continue;
        if (TX < r.x || TX > r.x + r.w || TY < r.y || TY > r.y + r.h) continue;
        // Smallest area wins; later in the tree (painted on top) wins ties.
        if (!best || r.w * r.h <= best.r.w * best.r.h) best = hosts[i];
      }
      return best;
    }

    // The live scroll position, when the container keeps one where JS can see
    // it: VirtualizedList records every scroll event in _scrollMetrics, and the
    // RecyclerListView family exposes a getter.
    function liveOffset(inst) {
      var m = safe(function () { return inst._scrollMetrics && inst._scrollMetrics.offset; });
      if (typeof m === "number") return m;
      var g = safe(function () {
        return typeof inst.getCurrentScrollOffset === "function" ? inst.getCurrentScrollOffset() : null;
      });
      if (typeof g === "number") return g;
      return null;
    }

    function scrollWith(f, inst, name, entry, hitRect) {
      var method = entry.method;
      var chost = hostOf(f);
      var crect = chost ? rectFor(chost) : null;
      if (!crect) return JSON.stringify({ scrolled: false, reason: name + " was found but never measured" });
      var cfib = firstHostBelow(chost, 0);
      var content = cfib ? rectFor(cfib) : null;

      var p = safe(function () { return f.memoizedProps; });
      var horiz = safe(function () { return p && p.horizontal; }) === true;
      // A host scroll view carries no \`horizontal\` prop, but its content view is
      // wider than the frame and no taller — that is the same fact, measured.
      if (!horiz && content) horiz = content.w > crect.w + 1 && content.h <= crect.h + 1;

      // How far the container is already scrolled: the content view's top edge
      // sits exactly that far above the container's. Works for anything
      // ScrollView-backed, which is every entry in the table.
      var curX = content ? Math.max(0, crect.x - content.x) : 0;
      var curY = content ? Math.max(0, crect.y - content.y) : 0;
      var live = liveOffset(inst);
      if (live !== null) { if (horiz) curX = live; else curY = live; }
      var cur = horiz ? curX : curY;

      var offset;
      if (BY) {
        // A finger moving up drags the content up, which *raises* the offset —
        // the tool passes the gesture's vector as a content delta, so the JS
        // route covers the same distance the OS swipe would have.
        offset = Math.max(0, Math.round(cur + (horiz ? DX : DY)));
      } else {
        var delta = horiz ? hitRect.x - crect.x : hitRect.y - crect.y;
        var span = horiz ? crect.w : crect.h;
        // A quarter of the frame of headroom: landing the target exactly on the
        // top edge puts it under a sticky header on most screens.
        offset = Math.max(0, Math.round(cur + delta - span * 0.25));
      }
      try {
        if (entry.positional) inst[method](horiz ? offset : curX, horiz ? curY : offset, false);
        else if (method === "scrollToOffset") inst.scrollToOffset({ offset: offset, animated: false });
        else inst.scrollTo(horiz ? { x: offset, y: curY, animated: false } : { x: curX, y: offset, animated: false });
      } catch (e) {
        return JSON.stringify({ scrolled: false, reason: name + "." + method + " threw: " + String(e) });
      }
      if (BY) {
        return JSON.stringify({ scrolled: true, container: name, method: method, from: Math.round(cur), to: offset });
      }
      return JSON.stringify({ scrolled: true, container: name, method: method });
    }

    function finish() {
      var hit = hitTest();
      if (!hit) {
        return JSON.stringify({
          scrolled: false,
          // In \`By\` mode the point is where a finger landed rather than an
          // element to reveal, and this reason becomes the fallback marker on
          // the tool, so it is phrased as the gesture's own failure.
          reason: (BY ? "no scroll container under " + TX + "," + TY + " — " : "") +
            "no measured element at (" + TX + ", " + TY + ")" +
            (truncated ? " — the walk was truncated at " + MAX + " hosts" : "") +
            "; the layout may have changed since it was captured"
        });
      }
      var unknown = null, stalled = null, stalledMethod = null, deferred = null;
      var f = current(safe(function () { return hit.fiber.return; }));
      var depth = 0;
      // Styling wrappers (NativeWind/CssInterop) put a list row's text 34 fibers
      // below its scroll view in the field; 100 still ends on a broken tree.
      while (f && depth < 100) {
        var name = nameOf(f);
        var entry = adapterFor(name);
        if (entry) {
          var inst = callable(f, entry.method);
          if (entry.defer) {
            if (inst && !deferred) deferred = { f: f, inst: inst, name: name, entry: entry };
            else if (!inst && !unknown) unknown = name;
          } else if (inst) {
            return scrollWith(f, inst, name, entry, hit.r);
          } else if (!stalled) {
            stalled = name;
            stalledMethod = entry.method;
          }
        } else if (!unknown && scrollish(name, safe(function () { return f.memoizedProps; }))) {
          unknown = name;
        }
        f = current(safe(function () { return f.return; }));
        depth++;
      }
      if (deferred) return scrollWith(deferred.f, deferred.inst, deferred.name, deferred.entry, hit.r);
      // The unrecognised name is the more actionable of the two: it is the entry
      // missing from the adapter table.
      if (unknown) return JSON.stringify({ scrolled: false, reason: "unrecognised scroll container: " + unknown });
      if (stalled) {
        return JSON.stringify({
          scrolled: false,
          reason: stalled + " is a scroll container but its " + stalledMethod + " is not reachable from the fiber tree"
        });
      }
      return JSON.stringify({
        scrolled: false,
        reason: BY
          ? "no scroll container under " + TX + "," + TY
          : "no scrollable ancestor above " + (nameOf(hit.fiber) || "the target") + " — the element is not inside a scroll view"
      });
    }

    var expected = hosts.length;
    var got = 0;
    var settle = null;
    var settled = false;

    function measureInto(h) {
      var called = false;
      function once(v) {
        if (called) return;
        called = true;
        h.r = v;
        got++;
        if (got >= expected && settle) settle();
      }
      try {
        h.m(function (mx, my, mw, mh) { once(typeof mx === "number" ? { x: mx, y: my, w: mw, h: mh } : null); });
      } catch (e) { once(null); }
      return once;
    }
    for (var i = 0; i < hosts.length; i++) {
      (function (h) {
        var stop = measureInto(h);
        setTimeout(function () { stop(null); }, 400);
      })(hosts[i]);
    }

    if (got >= expected) return finish();
    // finish() *scrolls*, so it must run exactly once — unlike fastLayout's
    // build(), resolving twice here would issue two scrolls.
    return new Promise(function (resolve) {
      function once() { if (settled) return; settled = true; resolve(finish()); }
      settle = once;
      setTimeout(once, 600);
    });
  })()`;
}

/** Brings the element at (x, y) into view without a touch. */
export function scrollToExpression(x: number, y: number): string {
  return scrollExpression(x, y, { kind: "To" });
}

/**
 * Scrolls the container under (x, y) by a content delta, without a touch — the
 * JS route for `swipe`. `dx`/`dy` are content offsets, not finger movement:
 * a swipe up (finger moving up) is a positive `dy`.
 */
export function scrollByExpression(x: number, y: number, dx: number, dy: number): string {
  return scrollExpression(x, y, { kind: "By", dx, dy });
}
