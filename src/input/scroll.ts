import {
  SAFE,
  MEASURER,
  VISIBILITY,
  STYLE_PROPS,
  TEXT_FROM,
  A11Y_LABEL,
  IS_TARGET,
  jsLiteral,
} from "../layout/runtimeSnippets.js";

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
type Mode = { kind: "To"; target?: ScrollTarget | null } | { kind: "By"; dx: number; dy: number };

/** The element `scroll_to` resolved, by the label the layout listed it under. */
export type ScrollTarget = { testID?: string; text?: string };

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
  const target = mode.kind === "To" && mode.target && (mode.target.testID || mode.target.text) ? mode.target : null;
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
    var TARGET = ${jsLiteral(target)};
    var hosts = [];
    var truncated = false;

    ${SAFE}
    ${MEASURER}
    ${VISIBILITY}
    ${STYLE_PROPS}
    ${TEXT_FROM}
    ${A11Y_LABEL}
    ${IS_TARGET}

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
    //
    // A mounted-but-hidden screen (the tab you left, the stack screen below
    // the top) keeps its frames at the same coordinates as the visible one, so
    // its list would win a hit test as easily as the list on screen — and get
    // scrolled instead of it. Its hosts are not measured at all, by the rule
    // fastLayout and press apply. In By mode a touch also obeys pointerEvents:
    // "none" lets it through to what is below, "box-none" passes through the
    // view itself but not its children.
    function walk(fiber, hidden, untouchable) {
      while (fiber) {
        if (walked) walked.add(fiber);
        var hiddenHere = hidden || safe(function () { return hidesSubtree(fiber); }) === true;
        var pe = BY ? pointerEventsOf(safe(function () { return fiber.memoizedProps; })) : undefined;
        var noTouch = untouchable || pe === "none";
        if (!hiddenHere) {
          var m = measurer(safe(function () { return fiber.stateNode; }));
          if (m) {
            if (hosts.length >= MAX) truncated = true;
            else hosts.push({ fiber: fiber, m: m, r: null, touch: !noTouch && pe !== "box-none" });
          }
        }
        walk(safe(function () { return fiber.child; }), hiddenHere, noTouch);
        fiber = safe(function () { return fiber.sibling; });
      }
    }

    try {
      hook.renderers.forEach(function (_, id) {
        hook.getFiberRoots(id).forEach(function (r) { walk(r.current, false, false); });
      });
    } catch (e) {
      return JSON.stringify({ scrolled: false, reason: "fiber walk failed: " + String(e) });
    }
    if (!hosts.length) {
      return JSON.stringify({ scrolled: false, reason: "no measurable host components in the tree" });
    }

    function hostEntry(fiber) {
      var alt = safe(function () { return fiber.alternate; });
      for (var i = 0; i < hosts.length; i++) {
        var h = hosts[i];
        if ((h.fiber === fiber || (alt && h.fiber === alt)) && h.r && h.r.w > 0 && h.r.h > 0) return h;
      }
      return null;
    }
    function rectFor(fiber) {
      var h = hostEntry(fiber);
      return h ? h.r : null;
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

    // By mode: the host a finger at the point touches — the last one in
    // pre-order whose frame contains it, which is the one painted on top (a
    // sheet's list, not the list under the sheet). To mode: the point is the
    // centre of an element that is off-screen by definition, so whatever is
    // painted over that spot (a tab bar, a header) is not it; the element the
    // caller named wins, then the smallest frame.
    function hitTest() {
      var best = null, named = null;
      for (var i = 0; i < hosts.length; i++) {
        var h = hosts[i];
        var r = h.r;
        if (!r || !(r.w > 0) || !(r.h > 0)) continue;
        if (TX < r.x || TX > r.x + r.w || TY < r.y || TY > r.y + r.h) continue;
        if (BY) {
          if (h.touch) best = h;
          continue;
        }
        if (TARGET && isTarget(safe(function () { return h.fiber.memoizedProps; }), TARGET)) named = h;
        // Smallest area wins; later in the tree (painted on top) wins ties.
        if (!best || r.w * r.h <= best.r.w * best.r.h) best = h;
      }
      return named || best;
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

    function numArray(v) {
      if (!Array.isArray(v)) return null;
      var outA = [];
      for (var i = 0; i < v.length; i++) if (typeof v[i] === "number" && isFinite(v[i])) outA.push(v[i]);
      outA.sort(function (a, b) { return a - b; });
      return outA.length ? outA : null;
    }

    // Everything about a container that decides how far it can and should go:
    // its frame, its content, its axis, where it is now, where it ends, and
    // the snapping its props ask for. null when it was never measured.
    function geometry(f, inst) {
      var chost = hostOf(f);
      var ch = chost ? hostEntry(chost) : null;
      if (!ch) return null;
      var crect = ch.r;
      var cfib = firstHostBelow(chost, 0);
      var cth = cfib ? hostEntry(cfib) : null;
      var content = cth ? cth.r : null;

      var p = safe(function () { return f.memoizedProps; });
      var hp = safe(function () { return chost.memoizedProps; });
      // The composite carries the props the caller wrote; the host scroll view
      // receives most of them too. Either is evidence.
      function prop(k) {
        var v = safe(function () { return p && p[k]; });
        if (v === undefined || v === null) v = safe(function () { return hp && hp[k]; });
        return v;
      }
      var horiz = prop("horizontal") === true;
      // A host scroll view may carry no \`horizontal\` prop, but its content view
      // is wider than the frame and no taller — that is the same fact, measured.
      if (!horiz && content) horiz = content.w > crect.w + 1 && content.h <= crect.h + 1;

      // How far the container is already scrolled: the content view's top edge
      // sits exactly that far above the container's. Works for anything
      // ScrollView-backed, which is every entry in the table.
      var curX = content ? Math.max(0, crect.x - content.x) : 0;
      var curY = content ? Math.max(0, crect.y - content.y) : 0;
      var measured = content ? (horiz ? curX : curY) : null;
      var live = liveOffset(inst);
      if (live !== null) { if (horiz) curX = live; else curY = live; }

      // Where the content ends: past it a scroll only bounces back, and the
      // reported \`to\` would be a place the list never went.
      var max = null;
      if (content) max = Math.max(0, horiz ? content.w - crect.w : content.h - crect.h);
      else {
        var cl = safe(function () { return inst._scrollMetrics.contentLength; });
        var vl = safe(function () { return inst._scrollMetrics.visibleLength; });
        if (typeof cl === "number" && typeof vl === "number" && cl > 0) max = Math.max(0, cl - vl);
      }

      var snap = null;
      var span = horiz ? crect.w : crect.h;
      var offsets = numArray(prop("snapToOffsets"));
      var interval = prop("snapToInterval");
      if (offsets) snap = { offsets: offsets };
      else if (typeof interval === "number" && interval > 0) snap = { interval: interval };
      else if (prop("pagingEnabled") === true && span > 0) snap = { interval: span, paging: true };

      return {
        chost: chost, ch: ch, cth: cth, crect: crect, horiz: horiz,
        curX: curX, curY: curY, cur: horiz ? curX : curY, measured: measured, live: live,
        max: max, snap: snap, span: span
      };
    }

    // The offset a snapping container comes to rest at. A fling moves a pager
    // one page however short it was, so By mode always leaves the current snap
    // point when the gesture moved at all; To mode lands on the snap point at
    // or before the target, so the target's page is the one shown.
    function snapped(g, want, dir) {
      var s = g.snap;
      if (!s) return want;
      var pts = s.offsets;
      if (!pts) {
        var I = s.interval;
        var here = Math.round(g.cur / I) * I;
        if (!BY) return Math.floor(want / I) * I;
        var to = Math.round(want / I) * I;
        if (to === here && dir !== 0) to = here + (dir > 0 ? I : -I);
        return to;
      }
      if (!BY) {
        var at = pts[0];
        for (var i = 0; i < pts.length; i++) if (pts[i] <= want) at = pts[i];
        return at;
      }
      var near = pts[0], nearCur = pts[0];
      for (var j = 0; j < pts.length; j++) {
        if (Math.abs(pts[j] - want) < Math.abs(near - want)) near = pts[j];
        if (Math.abs(pts[j] - g.cur) < Math.abs(nearCur - g.cur)) nearCur = pts[j];
      }
      if (near === nearCur && dir !== 0) {
        for (var k = 0; k < pts.length; k++) {
          if (dir > 0 && pts[k] > nearCur) { near = pts[k]; break; }
          if (dir < 0 && pts[k] < nearCur) near = pts[k];
        }
      }
      return near;
    }

    function measureOnce(h, cb) {
      var called = false;
      function once(r) { if (!called) { called = true; cb(r); } }
      try {
        h.m(function (mx, my, mw, mh) { once(typeof mx === "number" ? { x: mx, y: my, w: mw, h: mh } : null); });
      } catch (e) { once(null); }
      setTimeout(function () { once(null); }, 200);
    }

    // Where the container is now, by the same two readings geometry() took.
    function offsetNow(g, inst, cb) {
      var live = liveOffset(inst);
      if (!g.cth) { cb(null, live); return; }
      measureOnce(g.ch, function (cr) {
        measureOnce(g.cth, function (ct) {
          if (!cr || !ct) { cb(null, live); return; }
          cb(g.horiz ? Math.max(0, cr.x - ct.x) : Math.max(0, cr.y - ct.y), live);
        });
      });
    }

    function scrollWith(f, inst, name, entry, hitRect, g) {
      var method = entry.method;
      var horiz = g.horiz, crect = g.crect, curX = g.curX, curY = g.curY, cur = g.cur;

      var offset, dir = 0;
      if (BY) {
        // A finger moving up drags the content up, which *raises* the offset —
        // the tool passes the gesture's vector as a content delta, so the JS
        // route covers the same distance the OS swipe would have.
        var d = horiz ? DX : DY;
        dir = d > 0 ? 1 : d < 0 ? -1 : 0;
        offset = snapped(g, cur + d, dir);
      } else {
        var delta = horiz ? hitRect.x - crect.x : hitRect.y - crect.y;
        // A quarter of the frame of headroom: landing the target exactly on the
        // top edge puts it under a sticky header on most screens. A snapping
        // container lands on a snap point instead, never between two.
        offset = g.snap ? snapped(g, cur + delta, 0) : cur + delta - g.span * 0.25;
      }
      offset = Math.max(0, Math.round(offset));
      if (g.max !== null && offset > g.max) offset = Math.round(g.max);
      if (BY && Math.abs(offset - cur) < 1) {
        return JSON.stringify({
          scrolled: false,
          reason: name + " is already at the " + (dir < 0 ? "start" : "end") + " (offset " + Math.round(cur) +
            (g.max !== null ? " of " + Math.round(g.max) : "") + ") — a JS scroll cannot move it further"
        });
      }
      try {
        if (entry.positional) inst[method](horiz ? offset : curX, horiz ? curY : offset, false);
        else if (method === "scrollToOffset") inst.scrollToOffset({ offset: offset, animated: false });
        else inst.scrollTo(horiz ? { x: offset, y: curY, animated: false } : { x: curX, y: offset, animated: false });
      } catch (e) {
        return JSON.stringify({ scrolled: false, reason: name + "." + method + " threw: " + String(e) });
      }
      if (!BY) return JSON.stringify({ scrolled: true, container: name, method: method });

      // A call that returns is not a scroll that happened: a pager's native
      // view can refuse an offset between pages, and that came back as
      // "RCTScrollView.scrollTo 0 → 478" twice while nothing moved. The
      // container is read again until it is seen to move; a container with
      // nothing to read keeps today's answer.
      if (g.measured === null && g.live === null) {
        return JSON.stringify({ scrolled: true, container: name, method: method, from: Math.round(cur), to: offset });
      }
      var waits = [16, 34, 80, 150, 300];
      return new Promise(function (resolve) {
        var n = 0;
        function check() {
          offsetNow(g, inst, function (m, live) {
            var movedM = m !== null && g.measured !== null && Math.abs(m - g.measured) >= 1;
            var movedL = live !== null && g.live !== null && Math.abs(live - g.live) >= 1;
            if (movedM || movedL) {
              resolve(JSON.stringify({
                scrolled: true, container: name, method: method, from: Math.round(cur),
                to: Math.round(movedM ? m : live)
              }));
              return;
            }
            if (n >= waits.length) {
              resolve(JSON.stringify({
                scrolled: false,
                reason: name + "." + method + "(" + offset + ") returned but the content did not move (still at " +
                  Math.round(cur) + ")" + (g.snap && g.snap.paging ? " — a paging scroll view" : "")
              }));
              return;
            }
            setTimeout(check, waits[n++]);
          });
        }
        setTimeout(check, waits[n++]);
      });
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
      // The gesture's own axis: a vertical swipe that starts on a horizontal
      // carousel inside a vertical list scrolls the list, as the OS would.
      var wantHoriz = Math.abs(DX) > Math.abs(DY);
      // Whether this container can bring the target closer: a carousel whose
      // frame already spans the target sideways does nothing for a row that is
      // below the fold — the list around it does.
      function useful(g) {
        if (BY) return g.horiz === wantHoriz;
        var r = hit.r, c = g.crect;
        return g.horiz ? (r.x < c.x || r.x + r.w > c.x + c.w) : (r.y < c.y || r.y + r.h > c.y + c.h);
      }
      var unknown = null, stalled = null, stalledMethod = null, deferred = null, spare = null, wrongAxis = null;
      var f = current(safe(function () { return hit.fiber.return; }));
      var depth = 0;
      // Styling wrappers (NativeWind/CssInterop) put a list row's text 34 fibers
      // below its scroll view in the field; 100 still ends on a broken tree.
      while (f && depth < 100) {
        var name = nameOf(f);
        var entry = adapterFor(name);
        if (entry) {
          var inst = callable(f, entry.method);
          if (inst) {
            var g = geometry(f, inst);
            var cand = { f: f, inst: inst, name: name, entry: entry, g: g };
            if (!g) {
              if (!spare) spare = cand;
            } else if (!useful(g)) {
              if (!spare) spare = cand;
              if (!wrongAxis) wrongAxis = name;
            } else if (entry.defer) {
              if (!deferred) deferred = cand;
            } else {
              return scrollWith(f, inst, name, entry, hit.r, g);
            }
          } else if (entry.defer) {
            if (!unknown) unknown = name;
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
      if (deferred) return scrollWith(deferred.f, deferred.inst, deferred.name, deferred.entry, hit.r, deferred.g);
      if (BY && wrongAxis) {
        return JSON.stringify({
          scrolled: false,
          reason: "no " + (wantHoriz ? "horizontal" : "vertical") + " scroll container under " + TX + "," + TY +
            " (" + wrongAxis + " there scrolls " + (wantHoriz ? "vertically" : "horizontally") + ")"
        });
      }
      // To mode: nothing above could do better, so the nearest container is
      // still worth a try — the layout check afterwards says whether it helped.
      if (spare) {
        if (!spare.g) return JSON.stringify({ scrolled: false, reason: spare.name + " was found but never measured" });
        return scrollWith(spare.f, spare.inst, spare.name, spare.entry, hit.r, spare.g);
      }
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
      function once() {
        if (settled) return;
        settled = true;
        // Chained by hand: not every Promise implementation adopts a thenable,
        // and finish() returns one when it waits to see the content move.
        var r = finish();
        if (r && typeof r.then === "function") r.then(resolve, resolve);
        else resolve(r);
      }
      settle = once;
      setTimeout(once, 600);
    });
  })()`;
}

/**
 * Brings the element at (x, y) into view without a touch. `target` names it
 * (testID or label), so the hit test picks it even where something else is
 * painted over its centre — a row below the fold usually sits under the tab bar.
 */
export function scrollToExpression(x: number, y: number, target?: ScrollTarget | null): string {
  return scrollExpression(x, y, { kind: "To", target });
}

/**
 * Scrolls the container under (x, y) by a content delta, without a touch — the
 * JS route for `swipe`. `dx`/`dy` are content offsets, not finger movement:
 * a swipe up (finger moving up) is a positive `dy`.
 */
export function scrollByExpression(x: number, y: number, dx: number, dy: number): string {
  return scrollExpression(x, y, { kind: "By", dx, dy });
}
