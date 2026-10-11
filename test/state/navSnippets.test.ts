import { describe, it, expect, vi } from "vitest";
import { navStateExpression, navActionExpression } from "../../src/state/navSnippets.js";

// The snippets are strings evaluated in-app (Hermes). Here they run in a
// sandbox whose `globalThis` is a fake object, exactly like
// test/state/snippets.test.ts does — `new Function` is also what catches a
// syntax error in a snippet before it ever reaches a device.
function run(expr: string, globals: Record<string, any>): any {
  const g: any = { JSON, ...globals };
  const fn = new Function("globalThis", `return (${expr});`);
  return JSON.parse(fn(g));
}

// Mutating actions resolve a promise (they wait for the navigator to settle
// before reading the new state back), so their tests await the result.
async function runAsync(expr: string, globals: Record<string, any>): Promise<any> {
  const g: any = { JSON, ...globals };
  const fn = new Function("globalThis", `return (${expr});`);
  return JSON.parse(await fn(g));
}

type Fiber = { type?: any; memoizedProps?: any; child?: Fiber | null; sibling?: Fiber | null };

function provider(value: unknown, child?: Fiber | null): Fiber {
  return { type: { $$typeof: Symbol.for("react.provider") }, memoizedProps: { value }, child: child ?? null };
}

function hookFor(root: Fiber, onGetRoots?: () => void) {
  return {
    renderers: new Map([[1, {}]]),
    getFiberRoots(_id: number) {
      onGetRoots?.();
      return new Set([{ current: root }]);
    },
  };
}

function makeRef(overrides: Record<string, any> = {}) {
  return {
    navigate: vi.fn(),
    goBack: vi.fn(),
    resetRoot: vi.fn(),
    dispatch: vi.fn(),
    canGoBack: () => true,
    getRootState: () => ({
      type: "stack",
      index: 1,
      routes: [{ name: "Feed" }, { name: "Post", params: { id: 42 } }],
    }),
    ...overrides,
  };
}

describe("nav discovery snippet", () => {
  it("finds the navigation container ref by walking the fiber tree", () => {
    const ref = makeRef();
    const root = { child: provider({ notNav: true }, provider(ref)) } as Fiber;
    const out = run(navStateExpression(), { __REACT_DEVTOOLS_GLOBAL_HOOK__: hookFor(root) });
    expect(out.found).toBe(true);
    expect(out.source).toBe("fiber");
    expect(out.state.routes.map((r: any) => r.name)).toEqual(["Feed", "Post"]);
    expect(out.state.index).toBe(1);
    expect(out.state.routes[1].params).toEqual({ id: 42 });
  });

  // The walk is cheap but not free, and check_state runs it on every call.
  it("caches the discovered ref on globalThis.__RNE_NAV__", () => {
    const ref = makeRef();
    const g: any = { JSON, __REACT_DEVTOOLS_GLOBAL_HOOK__: hookFor({ child: provider(ref) }) };
    const fn = new Function("globalThis", `return (${navStateExpression()});`);
    fn(g);
    expect(g.__RNE_NAV__).toBe(ref);
  });

  it("uses an already-cached __RNE_NAV__ without walking fibers at all", () => {
    const ref = makeRef();
    const walked = vi.fn();
    const out = run(navStateExpression(), {
      __RNE_NAV__: ref,
      __REACT_DEVTOOLS_GLOBAL_HOOK__: hookFor({ child: provider(makeRef()) }, walked),
    });
    expect(out.found).toBe(true);
    expect(out.source).toBe("__RNE_NAV__");
    expect(walked).not.toHaveBeenCalled();
  });

  // Never throw into app code: a missing hook or a missing container is a
  // structured answer the caller can act on, not an exception.
  it("reports found:false with a reason when the DevTools hook is absent", () => {
    const out = run(navStateExpression(), {});
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/DevTools/i);
  });

  it("reports found:false with a reason when no container is mounted", () => {
    const root = { child: provider({ some: "context" }) } as Fiber;
    const out = run(navStateExpression(), { __REACT_DEVTOOLS_GLOBAL_HOOK__: hookFor(root) });
    expect(out.found).toBe(false);
    expect(out.reason).toMatch(/react-navigation|NavigationContainer/i);
  });

  // A Reanimated-style props object throws when read (the same hazard
  // src/layout/runtimeSnippets.ts's `safe()` exists for) — one such fiber must
  // not abort the walk before it reaches the container below it.
  it("survives a fiber whose props throw on read", () => {
    const ref = makeRef();
    const hostile: Fiber = {
      get memoizedProps(): any {
        throw new Error("nope");
      },
      child: provider(ref),
    };
    const out = run(navStateExpression(), { __REACT_DEVTOOLS_GLOBAL_HOOK__: hookFor({ child: hostile }) });
    expect(out.found).toBe(true);
  });

  it("accepts a ref exposing only dispatch + getRootState", () => {
    const ref = { dispatch: vi.fn(), getRootState: () => ({ type: "stack", index: 0, routes: [{ name: "A" }] }) };
    const out = run(navStateExpression(), { __REACT_DEVTOOLS_GLOBAL_HOOK__: hookFor({ child: provider(ref) }) });
    expect(out.found).toBe(true);
  });

  // A screen's own `navigation` prop looks similar but cannot drive the root.
  it("ignores a context value that is not a container ref", () => {
    const screenNav = { navigate: vi.fn(), goBack: vi.fn(), dispatch: vi.fn() };
    const out = run(navStateExpression(), {
      __REACT_DEVTOOLS_GLOBAL_HOOK__: hookFor({ child: provider(screenNav) }),
    });
    expect(out.found).toBe(false);
  });

  it("reports nested navigator state as a nested level", () => {
    const ref = makeRef({
      getRootState: () => ({
        type: "stack",
        index: 0,
        routes: [
          { name: "Tabs", state: { type: "tab", index: 1, routes: [{ name: "Home" }, { name: "Settings" }] } },
        ],
      }),
    });
    const out = run(navStateExpression(), { __REACT_DEVTOOLS_GLOBAL_HOOK__: hookFor({ child: provider(ref) }) });
    expect(out.state.routes[0].state.type).toBe("tab");
    expect(out.state.routes[0].state.routes.map((r: any) => r.name)).toEqual(["Home", "Settings"]);
  });

  // Params are arbitrary app values; one unserialisable route must not cost the
  // whole answer.
  it("replaces unserialisable params with a note instead of failing", () => {
    const circular: any = {};
    circular.self = circular;
    const ref = makeRef({
      getRootState: () => ({ type: "stack", index: 0, routes: [{ name: "Post", params: circular }] }),
    });
    const out = run(navStateExpression(), { __REACT_DEVTOOLS_GLOBAL_HOOK__: hookFor({ child: provider(ref) }) });
    expect(out.found).toBe(true);
    expect(out.state.routes[0].params).toBeUndefined();
    expect(out.state.routes[0].paramsNote).toBeTruthy();
  });
});

describe("nav action snippet", () => {
  const fakeConsole = () => ({ error: vi.fn() });

  it("navigate calls navigate(name, params) and returns the settled state", async () => {
    const ref = makeRef();
    const out = await runAsync(navActionExpression({ action: "navigate", name: "Post", params: { id: 7 } }, 0), {
      __RNE_NAV__: ref,
      console: fakeConsole(),
    });
    expect(ref.navigate).toHaveBeenCalledWith("Post", { id: 7 });
    expect(out.ok).toBe(true);
    expect(out.state.routes.map((r: any) => r.name)).toEqual(["Feed", "Post"]);
  });

  it("push dispatches a StackActions.push payload", async () => {
    const ref = makeRef();
    await runAsync(navActionExpression({ action: "push", name: "Post", params: { id: 1 } }, 0), {
      __RNE_NAV__: ref,
      console: fakeConsole(),
    });
    expect(ref.dispatch).toHaveBeenCalledWith({ type: "PUSH", payload: { name: "Post", params: { id: 1 } } });
  });

  it("pop dispatches POP with the requested count", async () => {
    const ref = makeRef();
    await runAsync(navActionExpression({ action: "pop", count: 3 }, 0), { __RNE_NAV__: ref, console: fakeConsole() });
    expect(ref.dispatch).toHaveBeenCalledWith({ type: "POP", payload: { count: 3 } });
  });

  it("pop_to_top dispatches POP_TO_TOP", async () => {
    const ref = makeRef();
    await runAsync(navActionExpression({ action: "pop_to_top" }, 0), { __RNE_NAV__: ref, console: fakeConsole() });
    expect(ref.dispatch).toHaveBeenCalledWith({ type: "POP_TO_TOP" });
  });

  it("reset passes the given state to resetRoot", async () => {
    const ref = makeRef();
    const state = { index: 0, routes: [{ name: "Home" }] };
    await runAsync(navActionExpression({ action: "reset", state }, 0), { __RNE_NAV__: ref, console: fakeConsole() });
    expect(ref.resetRoot).toHaveBeenCalledWith(state);
  });

  // "Cannot go back" is an answer, not a failure — throwing would make a
  // perfectly ordinary end-of-stack look like a broken app.
  it("back reports a note instead of calling goBack when canGoBack() is false", async () => {
    const ref = makeRef({ canGoBack: () => false });
    const out = await runAsync(navActionExpression({ action: "back" }, 0), {
      __RNE_NAV__: ref,
      console: fakeConsole(),
    });
    expect(ref.goBack).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
    expect(out.note).toMatch(/cannot go back/i);
  });

  it("back calls goBack when it can", async () => {
    const ref = makeRef();
    await runAsync(navActionExpression({ action: "back" }, 0), { __RNE_NAV__: ref, console: fakeConsole() });
    expect(ref.goBack).toHaveBeenCalled();
  });

  // react-navigation does not throw on an unknown route name: it console.errors
  // "The action 'NAVIGATE' ... was not handled by any navigator." That message
  // is the single most useful signal there is, so the snippet catches it.
  it("captures react-navigation's unhandled-action message off console.error", async () => {
    const message =
      "The action 'NAVIGATE' with payload {\"name\":\"Nope\"} was not handled by any navigator.\n\nDo you have a screen named 'Nope'?";
    const con = { error: vi.fn() };
    const ref = makeRef({
      navigate: () => {
        con.error(message);
      },
    });
    const out = await runAsync(navActionExpression({ action: "navigate", name: "Nope" }, 0), {
      __RNE_NAV__: ref,
      console: con,
    });
    expect(out.unhandled).toContain("was not handled by any navigator");
  });

  it("restores console.error afterwards and still forwards app logs while patched", async () => {
    const con = { error: vi.fn() };
    const original = con.error;
    const ref = makeRef({
      navigate: () => {
        con.error("some unrelated app log");
      },
    });
    const out = await runAsync(navActionExpression({ action: "navigate", name: "Post" }, 0), {
      __RNE_NAV__: ref,
      console: con,
    });
    expect(con.error).toBe(original);
    expect(original).toHaveBeenCalledWith("some unrelated app log");
    expect(out.unhandled).toBeUndefined();
  });

  it("reports ok:false with the message when the action itself throws", async () => {
    const ref = makeRef({
      navigate: () => {
        throw new Error("boom");
      },
    });
    const out = await runAsync(navActionExpression({ action: "navigate", name: "Post" }, 0), {
      __RNE_NAV__: ref,
      console: fakeConsole(),
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/boom/);
  });

  it("reports found:false when there is no navigator to act on", async () => {
    const out = run(navActionExpression({ action: "back" }, 0), { console: fakeConsole() });
    expect(out.found).toBe(false);
    expect(out.reason).toBeTruthy();
  });
});

// Hermes evaluates ES5 only: an arrow function or a template literal in a
// snippet is a syntax error on the device, where nothing here would catch it.
describe("snippets stay ES5", () => {
  const all = [
    navStateExpression(),
    navActionExpression({ action: "navigate", name: "A", params: { b: 1 } }, 150),
    navActionExpression({ action: "reset", state: { routes: [] } }, 150),
  ];
  it("uses no arrow functions, let/const or template literals", () => {
    for (const s of all) {
      expect(s).not.toMatch(/=>/);
      expect(s).not.toMatch(/\b(let|const)\s/);
      expect(s).not.toMatch(/`/);
    }
  });
});
