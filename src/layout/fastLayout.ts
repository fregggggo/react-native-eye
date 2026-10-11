// Evaluated inside the app runtime over CDP. Walks Fiber roots via the React
// DevTools hook, collects host components worth showing (testID, pressable, or
// visible text) and measures each one.
//
// Visibility cannot be decided from geometry alone. Mounted-but-hidden screens
// (inactive tabs in a pager, screens under the top of a stack) keep a valid frame
// and measure at the same coordinates as the visible one, so the viewport test
// passes them. Two mechanisms handle that:
//   1. structural — display:none / opacity:0 / a11y-hidden / an inactive
//      react-native-screens screen hides its whole subtree;
//   2. navigation state — react-navigation marks a stack scene below the top with
//      focused:false, and a tab/pager scene carries its own index next to the
//      navigator's current one. (Hit testing via findNodeAtPoint was tried and
//      rejected: one full-screen overlay on the live scene owns every hit, which
//      marked the entire visible UI as covered.)

import { MEASURER, SAFE, VISIBILITY } from "./runtimeSnippets.js";

/**
 * Just the root view's frame — the app's own idea of the visible area, used to
 * scale swipe gestures without paying for a full layout capture.
 */
export function viewportExpression(): string {
  return `(function () {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers || !hook.getFiberRoots) return JSON.stringify(null);
    var fm = globalThis.nativeFabricUIManager;
    var m = null;
    ${MEASURER}
    function walk(fiber) {
      while (fiber && !m) { m = measurer(fiber.stateNode); if (!m) { walk(fiber.child); fiber = fiber.sibling; } }
    }
    try { hook.renderers.forEach(function (_, id) { hook.getFiberRoots(id).forEach(function (r) { if (!m) walk(r.current); }); }); }
    catch (e) { return JSON.stringify(null); }
    if (!m) return JSON.stringify(null);
    var rect = null;
    try { m(function (x, y, w, h) { rect = { x: x, y: y, w: w, h: h }; }); } catch (e) {}
    if (rect) return JSON.stringify(rect);
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(JSON.stringify(rect)); }, 400);
    });
  })()`;
}

export function fastLayoutExpression(maxNodes = 1200): string {
  return `(function () {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers || !hook.getFiberRoots) {
      return JSON.stringify({ available: false, error: "React DevTools hook not present — not a dev build, or the app has not rendered yet" });
    }
    var fm = globalThis.nativeFabricUIManager;
    var MAX = ${maxNodes};
    var hosts = [];
    var toasts = [];
    var rootMeasurer = null;
    var rootNode = null;
    var fibers = 0;
    var measurables = 0;
    var truncated = false;

    ${MEASURER}

    ${SAFE}

    ${VISIBILITY}

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
    function isPressable(p) {
      return !!(p && (p.onPress || p.onClick || p.accessibilityRole === "button" || p.accessibilityRole === "link"));
    }
    // D11: an empty TextInput has no testID, no press handler and no text — the
    // three signals below required to keep a host component — so it was silently
    // dropped, making get_layout({type:"RCTSinglelineTextInputView"}) and the
    // "into" param blind to "the input field on this screen". All of RN's shipped
    // native text input host tags (iOS single/multiline, Android) contain
    // "TextInput" in their name, so a single case-insensitive substring check
    // covers all three plus any renamed/future variant. onChangeText is a
    // fallback for a host tag this regex doesn't recognise: it is a signal
    // essentially unique to text inputs, unlike value/placeholder/editable
    // alone, which plenty of unrelated components also carry (checking those
    // without a type/handler signal would sweep in every View).
    function isTextInputHost(type, p) {
      if (typeof type === "string" && /textinput/i.test(type)) return true;
      return !!(p && typeof p.onChangeText === "function");
    }

    // LogBox is the only overlay that both covers the app and stays invisible to
    // every structural signal: it is a sibling root, not a parent, so nothing in
    // hidesSubtree() can see it from the app's own fibers (field test D12).
    function logBoxName(fiber) {
      var t = fiber.type;
      var n = typeof t === "string" ? t : (safe(function () { return t && (t.displayName || t.name); }) || "");
      return /^_?LogBox/.test(n) ? n : "";
    }
    function isLogBox(fiber) { return logBoxName(fiber) !== ""; }

    // D34: the toast (LogBoxNotificationContainer and everything in it) lives
    // in the *app's* root, is a few dozen dp tall, and is never what covers the
    // screen — whatever selectedLogIndex says. It is ordinary app content with
    // two quirks handled below: its text is out of reach of textFrom(), and it
    // is painted over whatever sits at the bottom of the screen.
    function isNotificationName(n) { return /^_?LogBox(Log)?Notification/.test(n); }
    function isLogBoxNotification(fiber) { return isNotificationName(logBoxName(fiber)); }
    // The toast itself: LogBoxNotification {log, level, totalLogCount}
    // (LogBoxLogNotification before RN 0.73).
    function isToastName(n) { return /^LogBox(Log)?Notification$/.test(n); }
    function toastLabel(fiber) {
      var level = safe(function () { return fiber.memoizedProps.log.level; });
      var content = safe(function () { return fiber.memoizedProps.log.message.content; });
      if (typeof content !== "string" || !content) return "LogBox toast";
      var label = "LogBox " + (typeof level === "string" && level ? level : "log") + ": " + content.replace(/[ \\t\\r\\n]+/g, " ").trim();
      return label.length > 100 ? label.slice(0, 99) + "\u2026" : label;
    }

    // D25: on Android LogBox keeps its own surface mounted (absoluteFill wrapper)
    // after the redbox is dismissed, so "is a LogBox fiber" alone is not "a
    // redbox is up". RN props: _LogBoxInspectorContainer {logs, selectedLogIndex},
    // LogBoxInspector {logs, selectedIndex}, LogBoxNotificationContainer {logs}.
    // Verdict: "empty" (nothing to show), "showing" (a log is open) or "unknown"
    // (props unreadable / not enough to tell: stay conservative, treat as overlay).
    function logCount(l) {
      if (typeof l === "number") return l;
      if (Array.isArray(l)) return l.length;
      if (l && typeof l.length === "number") return l.length;
      if (l && typeof l.size === "number") return l.size;
      return -1;
    }
    function logBoxVerdict(fiber) {
      var p = fiber.memoizedProps;
      if (!p || (p.logs === undefined && p.selectedLogIndex === undefined && p.selectedIndex === undefined)) return "none";
      var count = p.logs === undefined ? -1 : logCount(p.logs);
      var sel = p.selectedLogIndex !== undefined ? p.selectedLogIndex : p.selectedIndex;
      if (count === 0) return "empty";
      if (typeof sel === "number" && sel < 0) return "empty";
      if (count > 0 && typeof sel === "number" && sel >= 0) return "showing";
      return "unknown";
    }
    // True when a top-level LogBox subtree has readable props and every one of
    // them says "nothing to show". Bounded: the subtree is tiny.
    function logBoxAllEmpty(root) {
      var seenEmpty = false, budget = 400, bad = false;
      function scan(f) {
        while (f && budget-- > 0 && !bad) {
          if (isLogBoxNotification(f)) {
            // A toast is never an overlay: nothing below it can say otherwise.
            seenEmpty = true;
            f = f.sibling;
            continue;
          }
          if (isLogBox(f)) {
            var v = safe(function () { return logBoxVerdict(f); });
            if (v === "empty") seenEmpty = true;
            else if (v === "showing" || v === "unknown") bad = true;
          }
          scan(f.child);
          f = f.sibling;
        }
      }
      scan(root);
      return seenEmpty && !bad && budget > 0;
    }

    // Siblings are iterated, only children recurse: a long list would otherwise
    // grow the stack by one frame per row.
    function walk(fiber, hidden, insidePressable, insideOverlay, toast) {
      while (fiber) {
        fibers++;
        // insideOverlay: false = none, true = overlay, "off" = empty LogBox
        // surface, or a toast.
        var overlayHere = insideOverlay;
        var lbName = logBoxName(fiber);
        if (lbName && insideOverlay !== "off") {
          if (isNotificationName(lbName)) overlayHere = "off";
          else if (safe(function () { return logBoxVerdict(fiber) === "empty"; }) === true) overlayHere = "off";
          else if (!insideOverlay) overlayHere = safe(function () { return logBoxAllEmpty(fiber); }) === true ? "off" : true;
        }
        // toast: index into toasts, -1 outside one.
        var toastHere = toast;
        if (toast < 0 && lbName && isToastName(lbName)) {
          toasts.push({ label: toastLabel(fiber), row: -1, presses: 0 });
          toastHere = toasts.length - 1;
        }
        var hiddenHere = hidden || hidesSubtree(fiber);
        var idx = -1;
        var p = fiber.memoizedProps || {};
        var press = safe(function () { return isPressable(p); }) === true;
        var m = measurer(fiber.stateNode);
        if (m) {
          measurables++;
          if (!rootMeasurer) { rootMeasurer = m; rootNode = fiber.stateNode && fiber.stateNode.node; }
          if (hosts.length >= MAX) {
            truncated = true;
          } else {
            var text = safe(function () { return textFrom(p.children, 0).trim(); }) || "";
            var testID = safe(function () { return p.testID; });
            // The toast's message is a zero-sized virtual text several
            // composites below its row, so the row and its close button had no
            // label at all ("? @720,2866"). The first pressable host in a toast
            // is the row (it opens the inspector), the next is the close button.
            var toastRow = false;
            if (toastHere >= 0 && press && !text && !testID) {
              var tt = toasts[toastHere];
              toastRow = tt.presses === 0;
              text = toastRow ? tt.label : "Dismiss LogBox toast";
              tt.presses++;
            }
            var hostType = typeof fiber.type === "string" ? fiber.type : undefined;
            var isInput = safe(function () { return isTextInputHost(hostType, p); }) === true;
            var labelled = !!(testID || press || text || isInput);
            // Inside an overlay an unlabelled node is kept anyway: the backdrop
            // carries no label and its frame is the whole evidence (D12).
            if (labelled || overlayHere) {
              hosts.push({
                m: m, fiber: fiber, testID: testID || undefined, text: text || undefined,
                type: hostType,
                press: press, hidden: hiddenHere, insidePressable: insidePressable,
                overlay: overlayHere === true, labelled: labelled, toast: toastHere,
                input: isInput || undefined,
                placeholder: isInput ? (safe(function () { return p.placeholder; }) || undefined) : undefined,
                value: isInput ? (safe(function () { return p.value; }) || undefined) : undefined,
                descStart: 0, descEnd: 0
              });
              idx = hosts.length - 1;
              if (toastRow) toasts[toastHere].row = idx;
            }
          }
        }
        var before = hosts.length;
        walk(fiber.child, hiddenHere, insidePressable || press, overlayHere, toastHere);
        if (idx >= 0) { hosts[idx].descStart = before; hosts[idx].descEnd = hosts.length; }
        fiber = fiber.sibling;
      }
    }

    try {
      hook.renderers.forEach(function (_, id) {
        hook.getFiberRoots(id).forEach(function (r) { walk(r.current, false, false, false, -1); });
      });
    } catch (e) {
      return JSON.stringify({ available: false, error: "fiber walk failed: " + String(e) });
    }

    if (!hosts.length) {
      return JSON.stringify({
        available: false,
        error: "walked " + fibers + " fibers, " + measurables + " measurable host components, none with testID / press handler / text"
      });
    }

    var out = new Array(hosts.length);
    var viewport = null;
    var expected = hosts.length + (rootMeasurer ? 1 : 0);
    var got = 0;
    var settle = null;

    function measureInto(m, cb) {
      var called = false;
      function once(v) { if (!called) { called = true; cb(v); } }
      try {
        m(function (x, y, w, h) { once(typeof x === "number" ? { x: x, y: y, w: w, h: h } : null); });
      } catch (e) { once(null); }
      return once;
    }
    function onOne() { got++; if (got >= expected && settle) settle(); }

    function clip(r) {
      if (!viewport) return r;
      var x1 = Math.max(r.x, viewport.x), y1 = Math.max(r.y, viewport.y);
      var x2 = Math.min(r.x + r.w, viewport.x + viewport.w), y2 = Math.min(r.y + r.h, viewport.y + viewport.h);
      if (x2 <= x1 || y2 <= y1) return null;
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }

    // D37: a virtualised list parks its recycled containers far outside the
    // content instead of unmounting them (LegendList: translateY(-1e7), and a
    // sentinel at top:1e7), and a parked container still holds the row it last
    // rendered. measureInWindow is window-relative, so everything really
    // reachable by scrolling sits within the mounted content's extent of the
    // viewport — a million units (~1200 screens) is beyond any of it and well
    // short of the parking constants. Such a frame, or one that is not a finite
    // number at all, is not a place on any screen: the element is dropped.
    var PARKED = 1e6;
    function absurd(r) {
      if (!isFinite(r.x) || !isFinite(r.y) || !isFinite(r.w) || !isFinite(r.h)) return true;
      var vx = viewport ? viewport.x : 0, vy = viewport ? viewport.y : 0;
      var vw = viewport ? viewport.w : 0, vh = viewport ? viewport.h : 0;
      return r.x + r.w < vx - PARKED || r.x > vx + vw + PARKED ||
        r.y + r.h < vy - PARKED || r.y > vy + vh + PARKED;
    }

    function hasTextDescendant(i) {
      var h = hosts[i];
      for (var j = h.descStart; j < h.descEnd; j++) if (hosts[j].text) return true;
      return false;
    }

    // D5: a Text and its inner spans, or an icon and its nested svg layers, are
    // the same tap target, but their measured centres are rarely pixel-identical
    // (padding, rounding) — real observed drift was 2-17px. Exact-coordinate
    // dedup left both in the list, so tap({text:"Dismiss"}) saw "2 elements" for
    // one button. A real second "Dismiss" on the other side of the screen must
    // still show up as 2, so this needs a tolerance, not exact equality: 20px
    // sits with margin above the observed noise ceiling (17px) and margin below
    // half the typical spacing between repeated rows in a real list (>=40px
    // apart), so it absorbs the noise without hiding a genuine duplicate.
    // Bucketed by a DEDUPE_TOL grid (keyed by same label) so this stays roughly
    // linear on a busy (~300-element) screen instead of comparing every pair;
    // each candidate checks the 3x3 neighborhood of buckets around its own so a
    // pair straddling a bucket boundary is still found.
    var DEDUPE_TOL = 20;
    var dedupeBuckets = {};
    function dedupeBucketCoord(v) { return Math.floor(v / DEDUPE_TOL); }
    function isNearDuplicate(label, cx, cy) {
      var bx = dedupeBucketCoord(cx), by = dedupeBucketCoord(cy);
      for (var dx = -1; dx <= 1; dx++) {
        for (var dy = -1; dy <= 1; dy++) {
          var arr = dedupeBuckets[(bx + dx) + "," + (by + dy)];
          if (!arr) continue;
          for (var k = 0; k < arr.length; k++) {
            if (arr[k].label === label && Math.abs(arr[k].cx - cx) <= DEDUPE_TOL && Math.abs(arr[k].cy - cy) <= DEDUPE_TOL) {
              return true;
            }
          }
        }
      }
      return false;
    }
    function rememberDedupe(label, cx, cy) {
      var bkey = dedupeBucketCoord(cx) + "," + dedupeBucketCoord(cy);
      if (!dedupeBuckets[bkey]) dedupeBuckets[bkey] = [];
      dedupeBuckets[bkey].push({ label: label, cx: cx, cy: cy });
    }

    function build() {
      var els = [];
      var seenExact = {};

      // A LogBox *toast* is also a LogBox subtree and covers nothing. Only an
      // overlay that owns most of the viewport hides what is behind it.
      var overlayArea = 0;
      for (var oi = 0; oi < out.length; oi++) {
        if (!hosts[oi].overlay) continue;
        var orect = out[oi];
        if (orect && orect.w > 0 && orect.h > 0 && !absurd(orect)) {
          var oa = orect.w * orect.h;
          if (oa > overlayArea) overlayArea = oa;
        }
      }
      var vpArea = viewport ? viewport.w * viewport.h : 0;
      var covering = vpArea > 0 && overlayArea >= vpArea * 0.6;

      // D34: a toast is rendered after the app's own children, so it is painted
      // over whatever shares its rect — on a tab-bar app, the tab bar. The test
      // is the tap point, not containment: a tab cell a few dp taller than the
      // toast is still a cell whose tap lands on the toast.
      var toastRects = [];
      for (var ti = 0; ti < toasts.length; ti++) {
        var trow = toasts[ti].row;
        var tr = trow >= 0 ? out[trow] : null;
        if (tr && tr.w > 0 && tr.h > 0 && !absurd(tr) && !hosts[trow].hidden) {
          toastRects.push({ id: ti, r: tr, text: toasts[ti].label, covers: 0 });
        }
      }

      for (var i = 0; i < out.length; i++) {
        var r = out[i];
        if (!r || !(r.w > 0) || !(r.h > 0)) continue;
        if (absurd(r)) continue;
        var h = hosts[i];
        if (!h.labelled) continue;
        var vis = clip(r);
        var cx = Math.round((vis || r).x + (vis || r).w / 2);
        var cy = Math.round((vis || r).y + (vis || r).h / 2);
        var dedupeLabel = (h.text || "") + "|" + (h.testID || "") + "|" + (h.placeholder || "");
        if (h.text || h.testID || h.placeholder) {
          if (isNearDuplicate(dedupeLabel, cx, cy)) continue;
          rememberDedupe(dedupeLabel, cx, cy);
        } else {
          // Nothing to key on but the position: a row of unlabeled icon buttons
          // all share the empty label, and a tolerant match there would delete
          // real tap targets. Exact centres only, as before the tolerance.
          var exactKey = cx + "," + cy;
          if (seenExact[exactKey]) continue;
          seenExact[exactKey] = 1;
        }

        var e = { text: h.text, testID: h.testID, type: h.type, x: r.x, y: r.y, w: r.w, h: r.h };
        if (h.input) {
          e.input = true;
          if (h.placeholder) e.placeholder = h.placeholder;
          if (h.value !== undefined) e.value = h.value;
        }
        if (vis && (vis.x !== r.x || vis.y !== r.y || vis.w !== r.w || vis.h !== r.h)) e.visible = vis;
        if (!vis) { e.offscreen = true; }
        if (h.hidden) { e.hidden = true; e.hiddenBy = "inactive-screen"; }
        if (!e.hidden && !e.offscreen) {
          for (var tj = 0; tj < toastRects.length; tj++) {
            var tb = toastRects[tj];
            if (h.toast !== tb.id && cx >= tb.r.x && cx <= tb.r.x + tb.r.w && cy >= tb.r.y && cy <= tb.r.y + tb.r.h) {
              e.hidden = true; e.hiddenBy = "covered"; tb.covers++;
              break;
            }
          }
        }
        // Everything the overlay is painted over is unreachable: findByText and
        // tap already refuse a covered element with "covered by another view",
        // and the redbox's own Dismiss button stays visible because it is
        // inside the overlay (field test D12).
        //
        // D38: this verdict rests on JS state alone, and on Android the
        // inspector's surface measures full-size whether or not its dialog was
        // ever shown. So it is made reversible: the inspector's elements are
        // tagged, and each covered element keeps what it was before, for the
        // tool to restore when the OS says no such window is up.
        if (covering && h.overlay) e.overlay = true;
        if (covering && !h.overlay) {
          e.beneath = e.hidden ? e.hiddenBy : "visible";
          e.hidden = true; e.hiddenBy = "covered";
        }

        // Noise suppression: kept in the payload (so search and tap still find
        // them) but flagged, because a screen of icon testIDs and glued-together
        // container labels is most of the output and none of the value.
        if (h.testID && !h.text && !h.press && h.insidePressable) e.decorative = true;
        // The testID that identifies this button lives on the icon inside it,
        // where the decorative rule hides it. Borrowing it is the difference
        // between a listing of "?" and a tappable name (field test D17).
        if (h.press && !h.text && !h.testID && !h.placeholder) {
          for (var b = h.descStart; b < h.descEnd; b++) {
            var cand = hosts[b];
            if (cand.testID && !cand.text) { e.labelFrom = cand.testID; break; }
          }
        }
        // A wrapper's text is assembled from its descendants' children props,
        // so a View around one Text wears that Text's label at a different
        // centre — dedupe cannot help, and the wrapper polluted both the listing
        // and substring search (field test D16). One joined leaf is enough to
        // call it a container; text hosts are excluded so an RCTText nesting an
        // RCTVirtualText is not mistaken for one.
        var isTextHost = typeof h.type === "string" && /text/i.test(h.type);
        if (!h.testID && !h.press && h.text && !isTextHost) {
          var parts = [];
          for (var j = h.descStart; j < h.descEnd; j++) {
            var d = hosts[j];
            if (d.text && !hasTextDescendant(j)) parts.push(d.text);
          }
          if (parts.length >= 1 && parts.join("") === h.text) e.container = true;
        }
        els.push(e);
      }
      return JSON.stringify({
        available: els.length > 0,
        viewport: viewport,
        truncated: truncated,
        overlay: covering,
        toasts: toastRects.length ? toastRects.map(function (t) {
          return { x: t.r.x, y: t.r.y, w: t.r.w, h: t.r.h, text: t.text, covers: t.covers };
        }) : undefined,
        els: els,
        error: els.length > 0 ? undefined : "measured " + hosts.length + " candidates, none had a usable frame (zero-sized, or parked far outside the screen)"
      });
    }

    if (rootMeasurer) {
      var stopRoot = measureInto(rootMeasurer, function (r) { viewport = r; onOne(); });
      setTimeout(function () { stopRoot(null); }, 400);
    }
    for (var i = 0; i < hosts.length; i++) {
      (function (idx) {
        var stop = measureInto(hosts[idx].m, function (r) { out[idx] = r; onOne(); });
        setTimeout(function () { stop(null); }, 400);
      })(i);
    }

    if (got >= expected) return build();
    return new Promise(function (resolve) {
      settle = function () { resolve(build()); };
      setTimeout(function () { resolve(build()); }, 600);
    });
  })()`;
}
