import { describe, it, expect } from "vitest";
import {
  getStateExpression,
  componentTreeExpression,
  currentRouteExpression,
} from "../../src/state/snippets.js";

// The snippets are strings evaluated in-app; here we execute them in a sandbox
// with a fake global to verify they produce the right shape.
function run(expr: string, globals: Record<string, any>): any {
  const g: any = { JSON, ...globals };
  const fn = new Function("globalThis", `return (${expr});`);
  return JSON.parse(fn(g));
}

// Same sandbox as `run`, but returns the raw JSON *string* instead of the
// parsed object — needed to inspect key order / survive-a-slice behaviour,
// which JSON.parse would otherwise hide.
function runRaw(expr: string, globals: Record<string, any>): string {
  const g: any = { JSON, ...globals };
  const fn = new Function("globalThis", `return (${expr});`);
  return fn(g);
}

describe("state snippets", () => {
  it("getStateExpression reads a store global and walks a path", () => {
    const out = run(getStateExpression("user.name"), {
      store: { getState: () => ({ user: { name: "Ada" } }) },
    });
    expect(out.found).toBe(true);
    expect(out.value).toBe("Ada");
  });

  // The not-found hint is the only surface a caller debugging a live app ever
  // sees (the README isn't in the loop) — it must spell out both accepted
  // shapes so a map assignment (the shape the plural name promises) isn't
  // guessed wrong (field test D18).
  it("getStateExpression's not-found hint names both accepted shapes", () => {
    const out = run(getStateExpression(), {});
    expect(out.found).toBe(false);
    expect(out.hint).toContain("__RNE_STORES__");
    expect(out.hint).toContain("single store");
    expect(out.hint).toContain("map of named stores");
  });

  // D6: `found:true` used to mean only "a store exists" — a typo'd path silently
  // produced `{found:true}` with no `value` key (JSON.stringify drops `undefined`),
  // indistinguishable from a path that legitimately resolves to `undefined`.
  it("getStateExpression reports resolved:false with the failing segment and available keys for a path that does not exist", () => {
    const out = run(getStateExpression("nope.not.here"), {
      store: { getState: () => ({ user: { name: "Ada" } }) },
    });
    expect(out.found).toBe(true);
    expect(out.resolved).toBe(false);
    expect(out.failedAt).toBe("nope");
    expect(out.availableKeys).toEqual(["user"]);
    expect(out.value).toBeUndefined();
  });

  it("getStateExpression reports resolved:false at the segment that breaks, not the whole path, for a partially-valid path", () => {
    const out = run(getStateExpression("user.nickname"), {
      store: { getState: () => ({ user: { name: "Ada" } }) },
    });
    expect(out.resolved).toBe(false);
    expect(out.failedAt).toBe("user.nickname");
    expect(out.availableKeys).toEqual(["name"]);
  });

  it("getStateExpression distinguishes an honest undefined from an unresolved path via resolved:true", () => {
    const out = run(getStateExpression("user.nickname"), {
      store: { getState: () => ({ user: { nickname: undefined, name: "Ada" } }) },
    });
    expect(out.found).toBe(true);
    expect(out.resolved).toBe(true);
    expect(out.value).toBeUndefined();
  });

  it("getStateExpression reports resolved:true for a path that resolves to null", () => {
    const out = run(getStateExpression("user.middleName"), {
      store: { getState: () => ({ user: { middleName: null } }) },
    });
    expect(out.resolved).toBe(true);
    expect(out.value).toBeNull();
  });

  it("getStateExpression still resolves the root path with no path argument", () => {
    const out = run(getStateExpression(), {
      store: { getState: () => ({ count: 1 }) },
    });
    expect(out.found).toBe(true);
    expect(out.resolved).toBe(true);
    expect(out.value).toEqual({ count: 1 });
  });

  it("getStateExpression accepts a map of named stores, which is what the plural name promises", () => {
    // The natural shape for an app with several zustand stores, and the one the
    // plural name suggests. Only the map itself used to be checked for getState,
    // so it was reported as the state and every path failed at its first
    // segment with availableKeys:["getState"] (field test D18).
    const out = run(getStateExpression("cart.items"), {
      __RNE_STORES__: {
        cart: { getState: () => ({ items: 2 }) },
        auth: { getState: () => ({ user: "gio" }) },
      },
    });
    expect(out).toMatchObject({ found: true, resolved: true, value: 2 });
  });

  it("getStateExpression still accepts a single store assigned directly", () => {
    const out = run(getStateExpression("items"), { __RNE_STORES__: { getState: () => ({ items: 5 }) } });
    expect(out).toMatchObject({ found: true, resolved: true, value: 5 });
  });

  it("getStateExpression leaves a plain object that is not a store map alone", () => {
    const out = run(getStateExpression("user.name"), { __RNE_STORES__: { user: { name: "Ada" } } });
    expect(out).toMatchObject({ found: true, resolved: true, value: "Ada" });
  });

  // Finding 2 (field test 2 review): the candidate loop used to `break` only
  // when `unwrapStores(candidates[i])` returned something other than
  // `undefined` — but a legitimate, not-yet-initialised store's getState()
  // also returns `undefined`, so the loop walked on and could pick up
  // globalThis.store or globalThis.__store__ instead and report THAT object's
  // contents as if it were the app's state, with no signal that the intended
  // __RNE_STORES__ was bypassed. This is a "wrong answer that looks normal".
  it("does not substitute globalThis.store when __RNE_STORES__.getState() legitimately returns undefined", () => {
    const out = run(getStateExpression(), {
      __RNE_STORES__: { getState: () => undefined },
      store: { getState: () => ({ secret: "should not leak" }) },
    });
    // The developer-designated store was found, it just isn't initialised yet
    // — that is the honest, if under-informative, outcome, not a stray global's data.
    expect(out.found).toBe(false);
    expect(JSON.stringify(out)).not.toContain("should not leak");
  });

  it("does not substitute globalThis.__store__ either, when both __RNE_STORES__ and globalThis.store return undefined", () => {
    const out = run(getStateExpression(), {
      __RNE_STORES__: { getState: () => undefined },
      store: { getState: () => undefined },
      __store__: { getState: () => ({ secret: "should not leak" }) },
    });
    expect(out.found).toBe(false);
    expect(JSON.stringify(out)).not.toContain("should not leak");
  });

  // The discoverability half of the same defect: a developer who assigned
  // __RNE_STORES__ should be able to tell, from the response alone, that they
  // are looking at their own store and not at some stray globalThis.store.
  it("names __RNE_STORES__ as the source when that is where the state came from", () => {
    const out = run(getStateExpression(), { __RNE_STORES__: { getState: () => ({ count: 1 }) } });
    expect(out.found).toBe(true);
    expect(out.source).toBe("__RNE_STORES__");
  });

  it("names globalThis.store as the source when __RNE_STORES__ is absent", () => {
    const out = run(getStateExpression(), { store: { getState: () => ({ count: 1 }) } });
    expect(out.found).toBe(true);
    expect(out.source).toBe("store");
  });

  // A store's getState() is arbitrary user code; one throwing entry in the map
  // must not take down the other stores or crash the whole expression, and the
  // failing entry should say why it has no state instead of silently vanishing.
  it("getStateExpression reports a throwing store's own error without breaking the other stores in the map", () => {
    const out = run(getStateExpression("cart.items"), {
      __RNE_STORES__: {
        cart: { getState: () => ({ items: 2 }) },
        auth: {
          getState: () => {
            throw new Error("boom");
          },
        },
      },
    });
    expect(out).toMatchObject({ found: true, resolved: true, value: 2 });

    const authOut = run(getStateExpression("auth.__rneStoreError"), {
      __RNE_STORES__: {
        cart: { getState: () => ({ items: 2 }) },
        auth: {
          getState: () => {
            throw new Error("boom");
          },
        },
      },
    });
    expect(authOut.found).toBe(true);
    expect(authOut.resolved).toBe(true);
    expect(typeof authOut.value).toBe("string");
    expect(authOut.value).toContain("boom");
  });

  it("currentRouteExpression returns an object", () => {
    const out = run(currentRouteExpression(), {});
    expect(out).toHaveProperty("route");
  });

  // Discovery: a fake React tree holding a react-navigation container ref in a
  // context Provider's `value`, which is where react-navigation always puts it.
  function navHook(ref: unknown) {
    const root = {
      child: { type: { $$typeof: Symbol.for("react.provider") }, memoizedProps: { value: ref }, child: null },
    };
    return { renderers: new Map([[1, {}]]), getFiberRoots: () => new Set([{ current: root }]) };
  }

  // The whole point of the fiber walk: no app-side setup, no globals assigned,
  // and check_state still reports where the app is (before this, the route was
  // null for every app that had not volunteered a global).
  it("currentRouteExpression finds the route by discovery when no global is assigned", () => {
    const ref = {
      navigate() {},
      goBack() {},
      resetRoot() {},
      getRootState: () => ({
        index: 0,
        routes: [{ name: "Tabs", state: { index: 1, routes: [{ name: "Home" }, { name: "Post", params: { id: 42 } }] } }],
      }),
    };
    const out = run(currentRouteExpression(), { __REACT_DEVTOOLS_GLOBAL_HOOK__: navHook(ref) });
    // The deepest focused route, not the navigator that hosts it.
    expect(out.route).toEqual({ name: "Post", params: { id: 42 } });
    expect(out.source).toMatch(/fiber/);
    expect(out.hint).toBeUndefined();
  });

  it("currentRouteExpression prefers getCurrentRoute() when the discovered ref has one", () => {
    const ref = {
      dispatch() {},
      getRootState: () => ({ index: 0, routes: [{ name: "Home" }] }),
      getCurrentRoute: () => ({ name: "Post", params: { id: 7 } }),
    };
    const out = run(currentRouteExpression(), { __REACT_DEVTOOLS_GLOBAL_HOOK__: navHook(ref) });
    expect(out.route).toEqual({ name: "Post", params: { id: 7 } });
  });

  // The hint is the only thing a caller sees when the route is null, so it has
  // to say what was actually tried and why it came up empty.
  it("currentRouteExpression's hint reports why discovery failed", () => {
    const out = run(currentRouteExpression(), {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: navHook({ some: "unrelated context value" }),
    });
    expect(out.route).toBeNull();
    expect(out.hint).toMatch(/react-navigation container/i);
    expect(out.hint).toContain("__RNE_NAV__");
  });

  it("currentRouteExpression still prefers an explicitly published __RNE_ROUTE__", () => {
    const out = run(currentRouteExpression(), {
      __RNE_ROUTE__: { name: "Explicit" },
      __REACT_DEVTOOLS_GLOBAL_HOOK__: navHook({
        dispatch() {},
        getRootState: () => ({ index: 0, routes: [{ name: "Discovered" }] }),
      }),
    });
    expect(out.source).toBe("__RNE_ROUTE__");
  });

  it("componentTreeExpression returns a serializable value without a hook", () => {
    const out = run(componentTreeExpression(2), {});
    expect(out).toBeDefined();
  });

  // D7: on a real RN 0.83 app, max_depth 10 never got past RN/NativeWind
  // wrappers (`CssInterop.View` -> `View` -> `RCTView`, repeating) because every
  // named fiber — wrapper or not — spent a depth level. Fix: only fibers with an
  // "authored" React work tag (FunctionComponent/ClassComponent/Indeterminate)
  // spend budget; host components and structural wrappers (forwardRef, memo,
  // simple-memo, context provider/consumer) are free, however many repeat.
  function findByName(nodes: any[], name: string): any {
    for (const n of nodes) {
      if (n.name === name) return n;
      if (n.children) {
        const hit = findByName(n.children, name);
        if (hit) return hit;
      }
    }
    return undefined;
  }

  // React's stable work-tag numbers (unchanged since the Fiber reconciler
  // shipped): 0 FunctionComponent, 1 ClassComponent, 2 IndeterminateComponent,
  // 9 ContextConsumer, 10 ContextProvider, 11 ForwardRef, 14 MemoComponent, 15
  // SimpleMemoComponent. Host fibers carry a string `type` instead of a tag.
  function host(type: string, child: any = null) {
    return { type, tag: 5, memoizedProps: {}, child, sibling: null };
  }
  function wrapper(name: string, tag: number, child: any = null) {
    return { type: { displayName: name }, tag, memoizedProps: {}, child, sibling: null };
  }
  function named(name: string, child: any = null, props: Record<string, unknown> = {}) {
    return { type: { displayName: name }, tag: 0, memoizedProps: props, child, sibling: null };
  }
  function hookWithRoot(root: any) {
    return { __REACT_DEVTOOLS_GLOBAL_HOOK__: { renderers: new Map([[1, {}]]), getFiberRoots: () => [{ current: root }] } };
  }

  it("componentTreeExpression does not spend depth on host/forwardRef/memo/context wrapper chains", () => {
    // CssInterop.View (forwardRef) -> View (forwardRef) -> RCTView (host),
    // repeated 3x, then a real app component two layers deep.
    const homeScreen = named("HomeScreen", null, { children: "Home" });
    const bootstrap = named("Bootstrap", homeScreen);
    let chain = bootstrap;
    for (let i = 0; i < 3; i++) {
      chain = wrapper("CssInterop.View", 11, wrapper("View", 11, host("RCTView", chain)));
    }
    const out = run(componentTreeExpression(1), hookWithRoot(chain));
    const found = findByName(out.roots, "Bootstrap");
    expect(found).toBeDefined();
    expect(findByName(found.children, "HomeScreen")).toBeDefined();
  });

  it("componentTreeExpression does not spend depth on context provider/consumer or memo wrappers", () => {
    const target = named("DeepTarget");
    const tree = wrapper("SomeContext.Provider", 10, wrapper("SomeContext.Consumer", 9, wrapper("Memo(Thing)", 14, target)));
    const out = run(componentTreeExpression(0), hookWithRoot(tree));
    expect(findByName(out.roots, "DeepTarget")).toBeDefined();
  });

  it("componentTreeExpression still spends depth on named application components", () => {
    // A -> B -> C -> D, all authored function components; max_depth 2 shows
    // A/B/C (the node at the boundary still renders, childless) but never
    // walks far enough to create D at all.
    const d = named("D");
    const c = named("C", d);
    const b = named("B", c);
    const a = named("A", b);
    const out = run(componentTreeExpression(2), hookWithRoot(a));
    const nodeC = findByName(out.roots, "C");
    expect(nodeC).toBeDefined();
    expect(nodeC.children).toBeUndefined();
    expect(findByName(out.roots, "D")).toBeUndefined();
  });

  it("componentTreeExpression drops RN dev-only subtrees entirely instead of just being free", () => {
    const noise = named("LogBoxStateSubscription", named("ShouldNotAppear"));
    const real = named("Bootstrap", named("HomeScreen"));
    noise.sibling = real;
    const out = run(componentTreeExpression(5), hookWithRoot(noise));
    expect(findByName(out.roots, "LogBoxStateSubscription")).toBeUndefined();
    expect(findByName(out.roots, "ShouldNotAppear")).toBeUndefined();
    expect(findByName(out.roots, "Bootstrap")).toBeDefined();
  });

  it("componentTreeExpression keeps the app: RootTagContext sits above every screen", () => {
    // The real chain from the field test:
    //   AppContainer -> RootTagContext -> ... -> Bootstrap -> App
    // RootTagContext was in DROP_SUBTREES, so the whole app below it was thrown
    // away and the answer still claimed to be complete (D15).
    const app = named("Bootstrap", named("HomeScreen"));
    const tree = named("AppContainer", wrapper("RootTagContext", 10, app));
    const out = run(componentTreeExpression(10), hookWithRoot(tree));
    expect(findByName(out.roots, "Bootstrap")).toBeDefined();
    expect(findByName(out.roots, "HomeScreen")).toBeDefined();
  });

  it("componentTreeExpression reports truncation when the depth budget stopped the walk", () => {
    const d = named("D");
    const c = named("C", d);
    const b = named("B", c);
    const a = named("A", b);
    // The walk never creates D. Saying truncated:false there presents a cut
    // tree as the whole tree, which is what made D15 silent.
    const out = run(componentTreeExpression(2), hookWithRoot(a));
    expect(findByName(out.roots, "D")).toBeUndefined();
    expect(out.truncated).toBe(true);
  });

  it("componentTreeExpression does not claim truncation when the tree simply ended", () => {
    const out = run(componentTreeExpression(5), hookWithRoot(named("A", named("B"))));
    expect(out.truncated).toBe(false);
  });

  // A node landing exactly on the depth budget (depth + 1 === maxDepth + 1,
  // i.e. one past the boundary) but with no children of its own is not a cut
  // tree — there was nothing more to show. This pins the off-by-one distinction
  // the brief calls out: truncated must mean "there is more tree than shown",
  // not "the walk touched the depth ceiling."
  it("componentTreeExpression does not claim truncation for a leaf sitting exactly on the depth limit", () => {
    const out = run(componentTreeExpression(0), hookWithRoot(named("Leaf")));
    expect(findByName(out.roots, "Leaf")).toBeDefined();
    expect(out.truncated).toBe(false);
  });

  it("componentTreeExpression does not drop unrelated siblings after a depth cutoff elsewhere in the tree", () => {
    // ScreenA trips the depth cutoff (3 authored levels deep, maxDepth 1).
    // ScreenB is an unrelated, shallow sibling well within budget. A depth
    // cutoff in one branch must only prune that branch's own children — it
    // must not abort traversal of siblings not yet visited.
    const screenA = named("ScreenA", named("Mid", named("Leaf")));
    const screenB = named("ScreenB");
    screenA.sibling = screenB;
    const out = run(componentTreeExpression(1), hookWithRoot(screenA));
    expect(findByName(out.roots, "ScreenB")).toBeDefined();
    expect(out.truncated).toBe(true);
  });

  it("componentTreeExpression truncates and flags it instead of building an unbounded response", () => {
    // 600 siblings at the root, not nested — this exercises the node-count
    // cap (not the depth cap), the new safety valve made necessary by
    // wrappers no longer bounding how far the walk goes.
    let head: any = null;
    let prev: any = null;
    for (let i = 0; i < 600; i++) {
      const node = named("Item" + i);
      if (prev) prev.sibling = node;
      else head = node;
      prev = node;
    }
    const out = run(componentTreeExpression(1000), hookWithRoot(head));
    expect(out.truncated).toBe(true);
    expect(out.roots.length).toBeLessThan(600);
  });

  // Finding 3 (field test 2 review): `truncated` used to be emitted as the
  // *last* key, right after the (potentially huge) `roots` array. The tool's
  // own 4000-char wire cap slices raw JSON text, not the parsed object — on
  // exactly the tree large enough to set truncated:true, the flag proving it
  // was cut is also the thing most likely to be cut off itself, leaving the
  // caller with invalid JSON and no visible signal anything was wrong.
  it("componentTreeExpression puts available/truncated ahead of roots so a wire-size slice cannot remove them", () => {
    let head: any = null;
    let prev: any = null;
    for (let i = 0; i < 600; i++) {
      const node = named("Item" + i);
      if (prev) prev.sibling = node;
      else head = node;
      prev = node;
    }
    const raw = runRaw(componentTreeExpression(1000), hookWithRoot(head));
    // Sanity: this tree is genuinely big enough to exceed the tool's 4000-char
    // cap — otherwise this test would pass for the wrong reason.
    expect(raw.length).toBeGreaterThan(4000);
    const sliced = raw.slice(0, 4000);
    expect(sliced).toContain('"available":true');
    expect(sliced).toContain('"truncated":true');
  });
});
