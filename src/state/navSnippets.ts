// ES5 fragments evaluated inside the app (Hermes): no let/const, no arrow
// functions, no template literals. Kept apart from snippets.ts because the
// discovery below is shared by two very different callers — `check_state` /
// `get_state`'s route read and the `navigate` tool.
//
// Why a fiber walk at all: the route used to be readable only if the app author
// had assigned their navigation container ref to a global, which almost nobody
// does. The alternative an agent ends up at — digging the ref out of Metro's
// `__r` module registry — depends on module ids that change on every bundle.
// The ref is, however, always in the React tree: react-navigation renders
// `NavigationContainerRefContext.Provider value={containerRef}` above every
// screen, and Expo Router sits on top of react-navigation, so it gets it too.

/**
 * Defines `__rneNavFind()` (returns `{ref, source}` or `{reason}`) and
 * `__rneNavSnapshot(state)` (JSON-safe copy of a navigation state tree).
 *
 * Interpolated into every expression below; never thrown from, so a caller
 * always gets a structured answer instead of an exception in app code.
 */
export const NAV_FIND_FN = `
  function __rneNavSafe(fn) { try { return fn(); } catch (e) { return undefined; } }

  // getRootState is what makes a value the *container* ref rather than a
  // screen's own "navigation" prop (which has navigate/goBack/dispatch but
  // cannot address the root). resetRoot narrows it further; dispatch alone is
  // accepted so a v7 ref that drops a method still works.
  function __rneNavIsRef(v) {
    if (!v || typeof v !== "object") return false;
    if (typeof v.getRootState !== "function") return false;
    if (typeof v.navigate === "function" && typeof v.goBack === "function" && typeof v.resetRoot === "function") return true;
    return typeof v.dispatch === "function";
  }

  // Depth-first, pre-order, iterative: pushing sibling before child makes the
  // child pop first, so the outermost container is the first match. A node
  // budget bounds the cost on a huge tree — the walk is cheap, but it is not
  // allowed to be unbounded.
  function __rneNavWalk(root) {
    var stack = [root];
    var n = 0;
    while (stack.length) {
      if (++n > 20000) return undefined;
      var f = stack.pop();
      if (!f) continue;
      // The context Provider's shape moved between React versions (the
      // provider object in <=18, the context object itself in 19), so the
      // fiber's "type" is not a reliable filter. A prop literally named
      // "value" holding an object with getRootState is unambiguous on its own.
      var v = __rneNavSafe(function () { return f.memoizedProps && f.memoizedProps.value; });
      if (__rneNavIsRef(v)) return v;
      var sib = __rneNavSafe(function () { return f.sibling; });
      if (sib) stack.push(sib);
      var kid = __rneNavSafe(function () { return f.child; });
      if (kid) stack.push(kid);
    }
    return undefined;
  }

  function __rneNavFind() {
    // A reload clears the global, so a stale ref cannot outlive its tree.
    var cached = globalThis.__RNE_NAV__;
    if (__rneNavIsRef(cached)) return { ref: cached, source: "__RNE_NAV__" };
    var names = ["navigationRef", "__navigationRef__"];
    var explicit = [globalThis.navigationRef, globalThis.__navigationRef__];
    for (var i = 0; i < explicit.length; i++) {
      if (__rneNavIsRef(explicit[i])) {
        globalThis.__RNE_NAV__ = explicit[i];
        return { ref: explicit[i], source: names[i] };
      }
    }
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers || !hook.getFiberRoots) {
      return { reason: "React DevTools hook not present — navigation discovery needs a dev build connected through Metro. Assign your navigation container ref to globalThis.__RNE_NAV__ to work without it." };
    }
    var roots = [];
    try {
      hook.renderers.forEach(function (_, id) {
        var fr = hook.getFiberRoots(id);
        if (fr) fr.forEach(function (r) { if (r && r.current) roots.push(r.current); });
      });
    } catch (e) {
      return { reason: "could not read React fiber roots: " + String(e) };
    }
    for (var j = 0; j < roots.length; j++) {
      var found = __rneNavWalk(roots[j]);
      if (found) {
        globalThis.__RNE_NAV__ = found;
        return { ref: found, source: "fiber" };
      }
    }
    return { reason: "no react-navigation container found in the React tree — is a NavigationContainer (or Expo Router) mounted?" };
  }

  // The route on screen is the focused one at the deepest nesting level — the
  // root state's focused route is a whole navigator whenever anything is
  // nested, so stopping at the top would report "Tabs" instead of "Post".
  function __rneNavFocused(st) {
    var cur;
    var guard = 0;
    while (st && st.routes && guard++ < 10) {
      var r = st.routes[typeof st.index === "number" ? st.index : 0];
      if (!r) break;
      cur = r;
      st = r.state;
    }
    return cur;
  }

  // Navigation state is JSON by design, but params are arbitrary app values: a
  // circular or huge one is reported as a note so the rest of the tree survives.
  function __rneNavSnapshot(st, depth) {
    if (!st || typeof st !== "object" || !st.routes || depth > 8) return undefined;
    var out = { type: st.type, index: typeof st.index === "number" ? st.index : 0, routes: [] };
    for (var i = 0; i < st.routes.length && i < 30; i++) {
      var r = st.routes[i] || {};
      var node = { name: String(r.name) };
      if (r.params !== undefined) {
        var s;
        try { s = JSON.stringify(r.params); } catch (e) { s = undefined; }
        if (s === undefined) node.paramsNote = "(unserialisable)";
        else if (s.length > 300) node.paramsNote = "(" + s.length + " chars, omitted)";
        else node.params = r.params;
      }
      var child = __rneNavSnapshot(r.state, depth + 1);
      if (child) node.state = child;
      out.routes.push(node);
    }
    if (st.routes.length > 30) out.more = st.routes.length - 30;
    return out;
  }
`;

/** One level of a navigation state tree, as `__rneNavSnapshot` emits it. */
export type NavLevel = {
  type?: string;
  index: number;
  more?: number;
  routes: { name: string; params?: unknown; paramsNote?: string; state?: NavLevel }[];
};

export type NavResult = {
  found: boolean;
  source?: string;
  reason?: string;
  ok?: boolean;
  error?: string;
  note?: string;
  unhandled?: string;
  state?: NavLevel;
};

export type NavAction = {
  action: "navigate" | "push" | "back" | "pop" | "pop_to_top" | "reset";
  name?: string;
  params?: Record<string, unknown>;
  count?: number;
  state?: Record<string, unknown>;
};

/**
 * JSON.stringify leaves U+2028/U+2029 raw, and those are line terminators in an
 * ES5 program — a params value containing one would turn the interpolated
 * snippet into a syntax error on the device.
 *
 * The pattern is built from code points so this file holds no invisible
 * separators of its own.
 */
const LINE_SEPARATORS = new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]", "g");

function lit(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v).replace(LINE_SEPARATORS, function (c) {
    return "\\u" + c.charCodeAt(0).toString(16);
  });
}

/** Reads the current navigation state. Non-mutating, one round trip. */
export function navStateExpression(): string {
  return `(function () {
    ${NAV_FIND_FN}
    var f = __rneNavFind();
    if (!f.ref) return JSON.stringify({ found: false, reason: f.reason });
    var st;
    try { st = f.ref.getRootState(); }
    catch (e) { return JSON.stringify({ found: true, source: f.source, error: "getRootState() threw: " + String(e) }); }
    return JSON.stringify({ found: true, source: f.source, ok: true, state: __rneNavSnapshot(st, 0) });
  })()`;
}

function actionBody(a: NavAction): string {
  switch (a.action) {
    case "navigate":
      return `ref.navigate(${lit(a.name)}${a.params === undefined ? "" : `, ${lit(a.params)}`});`;
    case "push":
      return `ref.dispatch({ type: "PUSH", payload: { name: ${lit(a.name)}, params: ${lit(a.params)} } });`;
    case "pop":
      return `ref.dispatch({ type: "POP", payload: { count: ${a.count ?? 1} } });`;
    case "pop_to_top":
      return `ref.dispatch({ type: "POP_TO_TOP" });`;
    case "back":
      // canGoBack() returning false is an ordinary end-of-stack, not a failure.
      return `if (typeof ref.canGoBack === "function" && !ref.canGoBack()) { note = "cannot go back — nothing below this screen in the navigator."; } else { ref.goBack(); }`;
    case "reset":
      return `ref.resetRoot(${a.state === undefined ? "" : lit(a.state)});`;
  }
}

/**
 * Performs one navigation action and resolves with the state that follows.
 *
 * The settle wait lives *inside* the expression rather than in a second
 * evaluate so that the console.error patch below cannot outlive the call: an
 * unknown route name does not throw in react-navigation — its
 * `onUnhandledAction` console.errors "The action 'NAVIGATE' ... was not handled
 * by any navigator", which is the only signal that anything went wrong, and it
 * arrives after the dispatch returns.
 */
export function navActionExpression(a: NavAction, settleMs = 150): string {
  return `(function () {
    ${NAV_FIND_FN}
    var f = __rneNavFind();
    if (!f.ref) return JSON.stringify({ found: false, reason: f.reason });
    var ref = f.ref;
    var note, err, unhandled;
    var con = globalThis.console;
    var orig = con && con.error;
    if (orig) {
      con.error = function () {
        var s = "";
        for (var i = 0; i < arguments.length; i++) s += (i ? " " : "") + String(arguments[i]);
        if (!unhandled && /was not handled by any navigator/.test(s)) unhandled = s;
        // The app's own logging must still happen — swallowing it would hide
        // the message from get_logs/get_errors as well.
        try { orig.apply(con, arguments); } catch (e2) {}
      };
    }
    function restore() { if (orig) con.error = orig; }
    try { ${actionBody(a)} }
    catch (e) { err = String((e && e.message) || e); }
    if (err) { restore(); return JSON.stringify({ found: true, source: f.source, ok: false, error: err }); }
    return new Promise(function (resolve) {
      setTimeout(function () {
        restore();
        var st;
        try { st = ref.getRootState(); } catch (e3) {}
        resolve(JSON.stringify({
          found: true,
          source: f.source,
          ok: true,
          note: note,
          unhandled: unhandled,
          state: __rneNavSnapshot(st, 0)
        }));
      }, ${settleMs});
    });
  })()`;
}
