import { NAV_FIND_FN } from "./navSnippets.js";

// Serialisation happens *inside* the app: the whole store used to be
// JSON.stringify'd, shipped over CDP and only then cut to 4000 chars, which
// produced invalid JSON chopped mid-string and burned the transfer anyway.
// Depth, breadth and string length are bounded at the source instead.
const SUMMARIZE_FN = `
  function __rneSummarize(v, depth, maxDepth, seen) {
    if (v === null || v === undefined) return v === null ? null : undefined;
    var t = typeof v;
    if (t === "string") return v.length > 200 ? v.slice(0, 200) + "…(+" + (v.length - 200) + " chars)" : v;
    if (t === "number" || t === "boolean") return v;
    if (t === "function") return "[Function " + (v.name || "anonymous") + "]";
    if (t !== "object") return String(v);
    for (var s = 0; s < seen.length; s++) if (seen[s] === v) return "[Circular]";
    if (Array.isArray(v)) {
      if (depth >= maxDepth) return "[Array(" + v.length + ")]";
      seen.push(v);
      var arr = [];
      for (var i = 0; i < Math.min(v.length, 20); i++) arr.push(__rneSummarize(v[i], depth + 1, maxDepth, seen));
      seen.pop();
      if (v.length > 20) arr.push("…(+" + (v.length - 20) + " more)");
      return arr;
    }
    var keys = Object.keys(v);
    if (depth >= maxDepth) return "{" + keys.slice(0, 8).join(", ") + (keys.length > 8 ? ", …" : "") + "}";
    seen.push(v);
    var out = {};
    for (var k = 0; k < Math.min(keys.length, 50); k++) out[keys[k]] = __rneSummarize(v[keys[k]], depth + 1, maxDepth, seen);
    seen.pop();
    if (keys.length > 50) out["…"] = "(+" + (keys.length - 50) + " more keys)";
    return out;
  }
`;

export function getStateExpression(path?: string, maxDepth = 3): string {
  const pathLiteral = JSON.stringify(path ?? "");
  return `(function () {
    ${SUMMARIZE_FN}
    // "__RNE_STORES__" is plural and a map of named stores is the natural shape
    // for an app with several (zustand, jotai). Only the map itself used to be
    // checked for getState, so the map was reported as the state and every path
    // failed at its first segment (field test D18).
    //
    // Returns { found: false } when 'c' is not a store-ish object at all (the
    // global was never assigned), and { found: true, value: ... } otherwise —
    // "found" here means "this candidate IS a store (or store map, or plain
    // state object)", never "and its value happened to be truthy". A single
    // store's getState() can legitimately return undefined (not yet
    // initialised); that must read as "found the store, no state yet", not as
    // "this candidate doesn't count, try the next global" (field test 2 review
    // finding 2) — walking on from an honest undefined silently substituted an
    // unrelated global (globalThis.store / globalThis.__store__) and reported
    // its contents as the app's state.
    function unwrapStores(c) {
      if (!c || typeof c !== "object") return { found: false };
      if (typeof c.getState === "function") {
        // A user-supplied getState() is arbitrary code and must not be allowed
        // to throw into the app or take down the whole answer.
        try { return { found: true, value: c.getState() }; }
        catch (e) { return { found: true, value: { __rneStoreError: "getState() threw: " + String(e) } }; }
      }
      var keys = Object.keys(c);
      var out = {};
      var any = false;
      for (var k = 0; k < keys.length; k++) {
        var v = c[keys[k]];
        if (v && typeof v.getState === "function") {
          any = true;
          try { out[keys[k]] = v.getState(); }
          catch (e) { out[keys[k]] = { __rneStoreError: "getState() threw: " + String(e) }; }
        }
        else out[keys[k]] = v;
      }
      return { found: true, value: any ? out : c };
    }
    var candidateNames = ["__RNE_STORES__", "store", "__store__"];
    var candidates = [globalThis.__RNE_STORES__, globalThis.store, globalThis.__store__];
    var state, source;
    for (var i = 0; i < candidates.length; i++) {
      var got = unwrapStores(candidates[i]);
      // Stop at the first candidate that IS a store, whatever it returned —
      // never fall through to an unrelated global just because this one's
      // state is undefined right now.
      if (got.found) { state = got.value; source = candidateNames[i]; break; }
    }
    if (state === undefined) return JSON.stringify({ found: false, hint: "No store found. Assign your store (a single store, or a map of named stores) to globalThis.__RNE_STORES__ for reliable access." });
    var p = ${pathLiteral};
    // "found" only ever meant "a store exists". Whether the given dot-path
    // actually resolved is tracked separately so a typo'd segment (nothing
    // found) can be told apart from a path that legitimately bottoms out at
    // undefined/null (found, resolved, no further value).
    var resolved = true;
    var failedAt, availableKeys;
    var value = state;
    if (p) {
      var parts = p.split(".");
      var cursor = state;
      for (var j = 0; j < parts.length; j++) {
        var seg = parts[j];
        var cursorIsObj = cursor !== null && typeof cursor === "object";
        if (!cursorIsObj || !(seg in cursor)) {
          resolved = false;
          failedAt = parts.slice(0, j + 1).join(".");
          availableKeys = cursorIsObj ? Object.keys(cursor) : [];
          break;
        }
        cursor = cursor[seg];
      }
      value = resolved ? cursor : undefined;
    }
    if (!resolved) {
      return JSON.stringify({
        found: true,
        source: source,
        resolved: false,
        path: p,
        failedAt: failedAt,
        availableKeys: availableKeys,
        hint: "Path segment '" + failedAt + "' not found. Available keys at that level: " + (availableKeys.length ? availableKeys.join(", ") : "(none)")
      });
    }
    var keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value) : undefined;
    try {
      return JSON.stringify({ found: true, source: source, resolved: true, path: p || "(root)", topLevelKeys: keys, value: __rneSummarize(value, 0, ${maxDepth}, []) });
    } catch (e) {
      return JSON.stringify({ found: true, source: source, resolved: true, path: p || "(root)", value: String(value), note: "value could not be serialised: " + String(e) });
    }
  })()`;
}

export function currentRouteExpression(): string {
  return `(function () {
    ${NAV_FIND_FN}
    var route;
    var source;
    var reason;
    try {
      if (globalThis.__RNE_ROUTE__ !== undefined) { route = globalThis.__RNE_ROUTE__; source = "__RNE_ROUTE__"; }
      // React Navigation's container ref, when the app exposes one.
      if (route === undefined) {
        var refs = [globalThis.__RNE_NAV__, globalThis.navigationRef, globalThis.__navigationRef__];
        for (var i = 0; i < refs.length; i++) {
          var r = refs[i];
          if (r && typeof r.getCurrentRoute === "function") {
            var cur = r.getCurrentRoute();
            if (cur) { route = { name: cur.name, params: cur.params }; source = "navigationRef"; break; }
          }
        }
      }
      // Last resort, and in practice the usual one: find the container ref in
      // the React tree. Nobody assigns the globals above, so before this the
      // route was almost always null and an agent had to go digging through
      // Metro's module registry for the ref by hand.
      if (route === undefined) {
        var f = __rneNavFind();
        if (f.ref) {
          var deep = typeof f.ref.getCurrentRoute === "function" ? f.ref.getCurrentRoute() : undefined;
          if (!deep) { try { deep = __rneNavFocused(f.ref.getRootState()); } catch (e2) {} }
          if (deep) { route = { name: deep.name, params: deep.params }; source = f.source === "fiber" ? "fiber walk" : f.source; }
          else reason = "a navigation container was found but it has no route yet (still mounting?)";
        } else {
          reason = f.reason;
        }
      }
    } catch (e) {}
    return JSON.stringify({
      route: route === undefined ? null : route,
      source: source,
      hint: route === undefined
        ? "No route found — " + (reason || "no navigation container could be discovered") + ". Discovery walks the React tree for a react-navigation container ref; if your app navigates some other way, assign a ref exposing getRootState/navigate to globalThis.__RNE_NAV__, or set globalThis.__RNE_ROUTE__ on navigation."
        : undefined
    });
  })()`;
}

export function componentTreeExpression(maxDepth: number): string {
  return `(function () {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers) return JSON.stringify({ available: false, hint: "React DevTools hook not present." });
    // RN's own dev-only infrastructure — LogBox internals, the debugging
    // overlay — is never what a caller asked for, and its whole subtree is
    // dropped rather than merely made depth-free so it cannot show up buried
    // under a real screen either. RootTagContext is deliberately NOT here: it
    // is a provider RN mounts directly above the entire app, so dropping its
    // subtree dropped the app (field test D15).
    var DROP_SUBTREES = { LogBoxStateSubscription: 1, DebuggingOverlay: 1 };
    // React's work-tag numbers, stable since the Fiber reconciler shipped
    // (0 FunctionComponent, 1 ClassComponent, 2 IndeterminateComponent — the
    // only tags a developer actually authored). Everything else — host
    // components (RCTView, RCTText, ...) plus structural wrappers
    // (ForwardRef/Memo/SimpleMemo — the shape of a styling HOC like
    // NativeWind's cssInterop, or React.memo — and Context
    // Provider/Consumer) — is free: it can repeat any number of times
    // without eating into max_depth, the same way an unnamed fiber already
    // got lifted into its parent for free below.
    var NAMED_TAGS = { 0: 1, 1: 1, 2: 1 };
    // Wrappers no longer bound how far a walk goes, so a node budget is the
    // safety valve against an unbounded response on a huge real tree.
    var MAX_NODES = 500;
    var nodeCount = 0;
    // truncated is report-only: it tells the caller "there is more tree than
    // you are seeing" and never influences whether the walk continues. stopped
    // is the walk's own abort switch, owned solely by the node-count budget —
    // a genuine resource limit that must halt traversal everywhere. Folding
    // both into one flag turned a single branch's depth cutoff into a global
    // abort that silently dropped unrelated, in-budget siblings elsewhere in
    // the tree.
    var truncated = false;
    var stopped = false;
    function nameOf(fiber) {
      var t = fiber.type;
      if (!t) return null;
      if (typeof t === "string") return t;
      return t.displayName || t.name || null;
    }
    function textOf(children, depth) {
      if (depth > 2 || children == null) return "";
      if (typeof children === "string" || typeof children === "number") return String(children);
      if (Array.isArray(children)) {
        var s = "";
        for (var i = 0; i < children.length; i++) s += textOf(children[i], depth + 1);
        return s;
      }
      return "";
    }
    // Unnamed fibers (fragments, context providers, memo wrappers) used to drop
    // their whole subtree; their children are lifted into the parent instead.
    function collect(fiber, depth) {
      var out = [];
      while (fiber) {
        if (stopped) return out;
        var name = nameOf(fiber);
        if (name && DROP_SUBTREES[name]) { fiber = fiber.sibling; continue; }
        var spend = name && NAMED_TAGS[fiber.tag] ? 1 : 0;
        if (name) {
          if (nodeCount >= MAX_NODES) { truncated = true; stopped = true; return out; }
          nodeCount++;
        }
        var p = fiber.memoizedProps || {};
        var overBudget = spend && depth + 1 > ${maxDepth};
        if (overBudget && fiber.child) truncated = true;
        var kids = overBudget ? [] : collect(fiber.child, depth + spend);
        if (name) {
          var node = { name: name };
          if (p.testID) node.testID = p.testID;
          var txt = textOf(p.children, 0).trim();
          if (txt) node.text = txt.length > 60 ? txt.slice(0, 60) + "…" : txt;
          if (kids.length) node.children = kids;
          out.push(node);
        } else {
          for (var i = 0; i < kids.length; i++) out.push(kids[i]);
        }
        fiber = fiber.sibling;
      }
      return out;
    }
    var roots = [];
    try {
      hook.renderers.forEach(function (_, id) {
        var fiberRoots = hook.getFiberRoots ? hook.getFiberRoots(id) : [];
        fiberRoots.forEach(function (r) {
          var tree = collect(r.current, 0);
          for (var i = 0; i < tree.length; i++) roots.push(tree[i]);
        });
      });
    } catch (e) { return JSON.stringify({ available: false, error: String(e) }); }
    // 'available' and 'truncated' go first, 'roots' (unbounded — up to
    // MAX_NODES) last: the tool that reads this slices the JSON string at a
    // wire-size cap, not the parsed object, and a 500-node tree serialises to
    // well over that cap. Emitting the flags after 'roots' put the one field
    // that says "there is more than this" exactly where truncation was most
    // likely to remove it (field test 2 review, finding 3).
    return JSON.stringify({ available: true, truncated: truncated, roots: roots });
  })()`;
}
