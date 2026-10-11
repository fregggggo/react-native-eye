import { describe, it, expect } from "vitest";
import {
  RENDER_PROFILER_SOURCE,
  RENDER_PROFILER_VERSION,
  renderProfileExpression,
  formatReport,
  type RenderReport,
} from "../../src/profile/renders.js";

// The snippets run inside Hermes, where there is no module scope: they read and
// write `globalThis`. `new Function("globalThis", ...)` gives each test its own
// fake global, and — like test/core/inject.test.ts — it is also what catches a
// syntax error in the snippet before a device ever would.
type Fake = Record<string, any>;

function install(g: Fake): string {
  return new Function("globalThis", `return ${RENDER_PROFILER_SOURCE.trim()}`)(g) as string;
}

function fakeGlobal(hook?: Fake): Fake {
  return { __REACT_DEVTOOLS_GLOBAL_HOOK__: hook === undefined ? { renderers: new Map() } : hook };
}

function fireCommit(g: Fake, root: Fake): void {
  g.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot(1, root, undefined);
}

function start(g: Fake): void {
  g.__RNE_RP__.start();
}

function collect(g: Fake): RenderReport {
  return g.__RNE_RP__.collect() as RenderReport;
}

// --- fiber fixtures ---------------------------------------------------------
// Tags: 0 function, 1 class, 3 HostRoot, 5 host, 11 forwardRef, 15 SimpleMemo.
const PERFORMED_WORK = 1;

type FiberOpts = {
  tag?: number;
  type?: unknown;
  flags?: number;
  subtreeFlags?: number | undefined;
  props?: Record<string, unknown>;
  prevProps?: Record<string, unknown> | null;
  /** React 17 and earlier: `effectTag` instead of `flags`, no `subtreeFlags`. */
  legacy?: boolean;
  /** Omitted entirely by `noTiming`, to stand in for a non-ProfileMode build. */
  actualDuration?: number;
  actualStartTime?: number;
};

function fiber(o: FiberOpts = {}): Fake {
  const f: Fake = {
    tag: o.tag ?? 0,
    type: o.type,
    child: null,
    sibling: null,
    memoizedProps: o.props ?? {},
    alternate: null,
  };
  if (o.legacy) {
    f.effectTag = o.flags ?? 0;
    f.subtreeFlags = undefined;
  } else {
    f.flags = o.flags ?? 0;
    f.subtreeFlags = o.subtreeFlags ?? 0;
  }
  if (o.actualDuration !== undefined) f.actualDuration = o.actualDuration;
  if (o.actualStartTime !== undefined) f.actualStartTime = o.actualStartTime;
  if (o.prevProps !== undefined && o.prevProps !== null) {
    f.alternate = { tag: f.tag, type: f.type, memoizedProps: o.prevProps };
  }
  return f;
}

function kids(parent: Fake, list: Fake[]): Fake {
  parent.child = list[0] ?? null;
  for (let i = 0; i < list.length; i++) list[i].sibling = list[i + 1] ?? null;
  return parent;
}

/** Marks a fiber as one the walk must never look inside. */
function trap(f: Fake, what: string[]): Fake {
  for (const k of what) {
    Object.defineProperty(f, k, {
      get() {
        throw new Error(`pruned subtree was visited (${k})`);
      },
      configurable: true,
    });
  }
  return f;
}

function App() {}
function Feed() {}
function Row() {}
function Header() {}

/**
 * root → App → [Header (memo, idle), Feed → Row×3].
 *
 * Feed re-rendered because its `items` prop changed; the rows mounted. The
 * `actualDuration` values are the field finding in miniature: App's 999 and
 * Header's 50 are stale sums left over from earlier commits (neither rendered
 * here), so only Feed's and the rows' self time may be counted — 15 + 3×5 = 30.
 */
function scene(opts: { legacy?: boolean; noTiming?: boolean; startedAt?: number } = {}): {
  root: Fake;
  header: Fake;
  feed: Fake;
} {
  const L = opts.legacy;
  const d = (n: number): number | undefined => (opts.noTiming ? undefined : n);
  const t = (n: number): number | undefined =>
    opts.noTiming || opts.startedAt === undefined ? undefined : opts.startedAt + n;
  const rows = [0, 1, 2].map((i) =>
    fiber({
      type: Row,
      flags: PERFORMED_WORK,
      subtreeFlags: 0,
      legacy: L,
      actualDuration: d(5),
      actualStartTime: t(10 + i),
    }),
  );
  const feed = kids(
    fiber({
      type: Feed,
      flags: PERFORMED_WORK,
      subtreeFlags: PERFORMED_WORK,
      props: { items: [1, 2, 3], refreshing: false },
      prevProps: { items: [1, 2], refreshing: false },
      legacy: L,
      actualDuration: d(30),
      actualStartTime: t(4),
    }),
    rows,
  );
  const header = fiber({
    tag: 15,
    type: Header,
    flags: 0,
    subtreeFlags: 0,
    legacy: L,
    actualDuration: d(50),
    actualStartTime: t(0),
  });
  const app = kids(
    fiber({ type: App, flags: 0, subtreeFlags: PERFORMED_WORK, legacy: L, actualDuration: d(999) }),
    [header, feed],
  );
  const hostRoot = kids(
    fiber({ tag: 3, flags: 0, subtreeFlags: PERFORMED_WORK, legacy: L, actualDuration: d(999) }),
    [app],
  );
  return { root: { current: hostRoot }, header, feed };
}

// --- install ----------------------------------------------------------------

describe("render profiler install", () => {
  it("reports no-hook when the DevTools global hook is absent", () => {
    const g = fakeGlobal(undefined);
    delete g.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    expect(install(g)).toBe("no-hook");
  });

  it("wraps onCommitFiberRoot and chains to the original", () => {
    const seen: unknown[][] = [];
    const g = fakeGlobal({
      renderers: new Map(),
      onCommitFiberRoot: function (...args: unknown[]) {
        seen.push(args);
      },
    });
    expect(install(g)).toBe("ok");
    const { root } = scene();
    fireCommit(g, root);
    expect(seen).toHaveLength(1);
    expect(seen[0][1]).toBe(root);
  });

  it("installs on a hook that has no onCommitFiberRoot yet", () => {
    const g = fakeGlobal({ renderers: new Map() });
    expect(install(g)).toBe("ok");
    expect(typeof g.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot).toBe("function");
  });

  it("is idempotent — a second install does not double-count commits", () => {
    const g = fakeGlobal({ renderers: new Map(), onCommitFiberRoot: function () {} });
    expect(install(g)).toBe("ok");
    const wrapper = g.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot;
    expect(install(g)).toBe("ok");
    expect(g.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot).toBe(wrapper);
    start(g);
    fireCommit(g, scene().root);
    expect(collect(g).commitCount).toBe(1);
  });

  it("re-wraps when the app replaced our wrapper (a reload), without double-chaining", () => {
    let appCalls = 0;
    const g = fakeGlobal({
      renderers: new Map(),
      onCommitFiberRoot: function () {
        appCalls++;
      },
    });
    install(g);
    // A reload reinstalls the app's own hook over ours: the flag still says
    // "installed", but nothing of ours is in the slot any more.
    g.__REACT_DEVTOOLS_GLOBAL_HOOK__.onCommitFiberRoot = function () {
      appCalls++;
    };
    expect(install(g)).toBe("ok");
    start(g);
    fireCommit(g, scene().root);
    expect(collect(g).commitCount).toBe(1);
    expect(appCalls).toBe(1);
  });

  it("declines to re-install over an older version it cannot unwrap", () => {
    const g = fakeGlobal({ renderers: new Map(), onCommitFiberRoot: function () {} });
    g.__RNE_RP__ = { version: RENDER_PROFILER_VERSION - 1, wrapper: function () {} };
    expect(install(g)).toBe("stale");
  });

  it("restores an older version's original before re-wrapping", () => {
    let appCalls = 0;
    const orig = function () {
      appCalls++;
    };
    const oldWrapper = function (...args: unknown[]) {
      return (orig as any).apply(null, args);
    };
    const g = fakeGlobal({ renderers: new Map(), onCommitFiberRoot: oldWrapper });
    g.__RNE_RP__ = { version: RENDER_PROFILER_VERSION - 1, wrapper: oldWrapper, orig: orig };
    expect(install(g)).toBe("ok");
    start(g);
    fireCommit(g, scene().root);
    // Once, not twice: the old wrapper is out of the chain.
    expect(appCalls).toBe(1);
  });
});

// --- counting ---------------------------------------------------------------

describe("render profiler counting", () => {
  it("does nothing but chain while inactive", () => {
    let chained = 0;
    const g = fakeGlobal({
      renderers: new Map(),
      onCommitFiberRoot: function () {
        chained++;
      },
    });
    install(g);
    const root: Fake = {};
    Object.defineProperty(root, "current", {
      get() {
        throw new Error("walked the tree while inactive");
      },
    });
    expect(() => fireCommit(g, root)).not.toThrow();
    expect(chained).toBe(1);
    expect(collect(g).commitCount).toBe(0);
  });

  it("counts only component fibers that performed work", () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    start(g);
    fireCommit(g, scene().root);
    const r = collect(g);
    expect(r.commitCount).toBe(1);
    // Feed + 3 Rows. The HostRoot and App did not render; Header was pruned.
    expect(r.renderCount).toBe(4);
    expect(r.commits[0].n).toBe(4);
    const byName = Object.fromEntries(r.counts.map((c) => [c.name, c]));
    expect(byName.Feed).toEqual({ name: "Feed", n: 1, c: 1, selfMs: 15 });
    expect(byName.Row).toEqual({ name: "Row", n: 3, c: 1, selfMs: 15 });
    expect(byName.App).toBeUndefined();
    expect(byName.Header).toBeUndefined();
  });

  it("never walks into a subtree whose flags say nothing rendered", () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    start(g);
    const { root, header } = scene();
    trap(header, ["child", "memoizedProps", "type"]);
    fireCommit(g, root);
    const r = collect(g);
    expect(r.errors).toBe(0);
    expect(r.pruned).toBe(true);
    expect(r.commits[0].pruned).toBe(true);
    expect(r.renderCount).toBe(4);
  });

  it("names the render roots of a commit and why each one rendered", () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    start(g);
    fireCommit(g, scene().root);
    // Only Feed: the rows have a rendered ancestor, so they are not roots.
    expect(collect(g).commits[0].roots).toEqual([{ name: "Feed", why: "props: items" }]);
  });

  it('reports "mount" for a fiber with no alternate and "own state/hook" when no prop changed', () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    start(g);
    const sameProps = { title: "hi" };
    const mounted = fiber({ type: Row, flags: PERFORMED_WORK });
    const stateful = fiber({
      tag: 1,
      type: Header,
      flags: PERFORMED_WORK,
      props: sameProps,
      prevProps: sameProps,
    });
    const root = {
      current: kids(fiber({ tag: 3, subtreeFlags: PERFORMED_WORK }), [stateful, mounted]),
    };
    fireCommit(g, root);
    expect(collect(g).commits[0].roots).toEqual([
      { name: "Header", why: "own state/hook" },
      { name: "Row", why: "mount" },
    ]);
  });

  it("unwraps memo and forwardRef names and falls back to Anonymous", () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    start(g);
    const memo = fiber({
      tag: 14,
      type: { $$typeof: Symbol.for("react.memo"), type: Feed },
      flags: PERFORMED_WORK,
    });
    const fwd = fiber({
      tag: 11,
      type: { $$typeof: Symbol.for("react.forward_ref"), render: function Sticky() {} },
      flags: PERFORMED_WORK,
    });
    const named = fiber({ tag: 0, type: { displayName: "Fancy(Thing)" }, flags: PERFORMED_WORK });
    const anon = fiber({ tag: 0, type: {}, flags: PERFORMED_WORK });
    const root = {
      current: kids(fiber({ tag: 3, subtreeFlags: PERFORMED_WORK }), [memo, fwd, named, anon]),
    };
    fireCommit(g, root);
    const names = collect(g).counts.map((c) => c.name);
    expect(names.sort()).toEqual(["Anonymous", "Fancy(Thing)", "Feed", "Sticky"]);
  });

  it("counts a name once per commit for the commit tally", () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    start(g);
    fireCommit(g, scene().root);
    fireCommit(g, scene().root);
    const row = collect(g).counts.find((c) => c.name === "Row")!;
    expect(row.n).toBe(6);
    expect(row.c).toBe(2);
  });

  it("falls back to a full walk on React 17 fibers and says so", () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    start(g);
    fireCommit(g, scene({ legacy: true }).root);
    const r = collect(g);
    expect(r.pruned).toBe(false);
    expect(r.commits[0].pruned).toBe(false);
    expect(r.renderCount).toBe(4);
  });

  it("caps stored commits but keeps the totals honest", () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    start(g);
    for (let i = 0; i < 305; i++) fireCommit(g, scene().root);
    const r = collect(g);
    expect(r.commitCount).toBe(305);
    expect(r.renderCount).toBe(305 * 4);
    expect(r.commits.length).toBe(300);
    expect(r.truncated).toBe(true);
  });

  it("counts a handler error instead of throwing into app code", () => {
    let chained = 0;
    const g = fakeGlobal({
      renderers: new Map(),
      onCommitFiberRoot: function () {
        chained++;
      },
    });
    install(g);
    start(g);
    const root: Fake = {};
    Object.defineProperty(root, "current", {
      get() {
        throw new Error("boom");
      },
    });
    expect(() => fireCommit(g, root)).not.toThrow();
    expect(chained).toBe(1);
    expect(collect(g).errors).toBe(1);
  });

  it("deactivates and clears on collect", () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    start(g);
    fireCommit(g, scene().root);
    expect(collect(g).commitCount).toBe(1);
    fireCommit(g, scene().root);
    const second = collect(g);
    expect(second.commitCount).toBe(0);
    expect(second.renderCount).toBe(0);
  });
});

// --- render time ------------------------------------------------------------
// The root fiber's own actualDuration is an accumulated number, not this
// commit's cost: bubbleProperties sums every child's actualDuration and a
// bailed-out child keeps the stale value from the last time it rendered. Self
// time over the fibers that actually rendered is the only honest measure.

describe("render profiler timing", () => {
  it("sums self time over rendered fibers and ignores stale bailed-out children", () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    start(g);
    fireCommit(g, scene().root);
    const r = collect(g);
    expect(r.profiling).toBe(true);
    // Feed self (30 - 3×5) + rows (3×5). Header's stale 50 and App's stale 999
    // are both excluded.
    expect(r.commits[0].renderMs).toBe(30);
    expect(r.totalRenderMs).toBe(30);
  });

  it("reports the commit's start offset from the profile start", () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    start(g);
    const base = typeof performance === "object" ? performance.now() : Date.now();
    fireCommit(g, scene({ startedAt: base }).root);
    const t0 = collect(g).commits[0].t0;
    // Feed started 4ms after `base`, which is itself a hair after start().
    expect(t0).toBeGreaterThanOrEqual(4);
    expect(t0).toBeLessThan(1000);
  });

  it("reports null render time when the build has no profiling fields", () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    start(g);
    fireCommit(g, scene({ noTiming: true }).root);
    const r = collect(g);
    expect(r.profiling).toBe(false);
    expect(r.totalRenderMs).toBeNull();
    expect(r.commits[0].renderMs).toBeNull();
    expect(r.commits[0].t0).toBeUndefined();
    // The counts are still trustworthy — only the timing is missing.
    expect(r.renderCount).toBe(4);
    expect(r.counts.find((c) => c.name === "Row")!.selfMs).toBeNull();
  });
});

// --- the profiling expression ----------------------------------------------

describe("renderProfileExpression", () => {
  it("activates, waits and resolves with the report", async () => {
    const g = fakeGlobal({ renderers: new Map() });
    install(g);
    const run = new Function("globalThis", `return ${renderProfileExpression(20)}`)(g) as Promise<RenderReport>;
    fireCommit(g, scene().root);
    const r = await run;
    expect(r.version).toBe(RENDER_PROFILER_VERSION);
    expect(r.commitCount).toBe(1);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(g.__RNE_RP__.active).toBe(false);
  });

  it("reports a missing installation rather than throwing", () => {
    const g = fakeGlobal({ renderers: new Map() });
    const out = new Function("globalThis", `return ${renderProfileExpression(5)}`)(g);
    expect(out).toEqual({ error: "not-installed" });
  });
});

// Hermes evaluates ES5 only: an arrow function, `let`/`const` or a template
// literal in a snippet is a syntax error on the device, where nothing here
// would catch it.
describe("snippets stay ES5", () => {
  it("uses no arrow functions, let/const or template literals", () => {
    for (const s of [RENDER_PROFILER_SOURCE, renderProfileExpression(1000)]) {
      expect(s).not.toMatch(/=>/);
      expect(s).not.toMatch(/\b(let|const)\s/);
      expect(s).not.toMatch(/`/);
    }
  });
});

// --- formatting -------------------------------------------------------------

function report(over: Partial<RenderReport> = {}): RenderReport {
  return {
    version: RENDER_PROFILER_VERSION,
    pruned: true,
    profiling: true,
    durationMs: 5000,
    commitCount: 2,
    renderCount: 5,
    totalRenderMs: 41.2,
    commits: [
      { t: 120, t0: 118, n: 1, renderMs: 13.9, pruned: true, roots: [{ name: "Header", why: "own state/hook" }] },
      {
        t: 1234,
        t0: 1230,
        n: 4,
        renderMs: 27.3,
        pruned: true,
        roots: [{ name: "Feed", why: "props: items, refreshing" }],
      },
    ],
    counts: [
      { name: "Row", n: 3, c: 1, selfMs: 9 },
      { name: "Feed", n: 1, c: 1, selfMs: 18.3 },
      { name: "Header", n: 1, c: 1, selfMs: 13.9 },
    ],
    truncated: false,
    errors: 0,
    ...over,
  };
}

describe("formatReport", () => {
  it("leads with the window, the commit count, the render time and the walk mode", () => {
    const out = formatReport(report(), 15);
    expect(out.split("\n")[0]).toBe(
      "5.0s · 2 commits · 5 component renders · total render 41ms · pruned walk",
    );
  });

  it("says when the walk could not be pruned", () => {
    expect(formatReport(report({ pruned: false }), 15)).toContain("full walk (React <18)");
  });

  it("lists the top names with their render counts and self time", () => {
    const out = formatReport(report(), 2);
    expect(out).toContain("Row ×3  9ms (in 1 commit)");
    expect(out).toContain("Feed ×1  18ms (in 1 commit)");
    expect(out).not.toMatch(/^ *Header ×1/m);
  });

  it("adds a self-time table, since the hottest component is not the most frequent", () => {
    const out = formatReport(report(), 15);
    expect(out).toContain("Top by self time:");
    const selfTable = out.slice(out.indexOf("Top by self time:"));
    expect(selfTable.split("\n")[1]).toContain("Feed");
  });

  it("shows the most recent commits with their render time and roots", () => {
    const out = formatReport(report(), 15);
    expect(out).toContain("t+1234ms  4 renders  27.3ms ← Feed (props: items, refreshing)");
  });

  it("drops every timing column and explains why when profiling fields are absent", () => {
    const out = formatReport(
      report({
        profiling: false,
        totalRenderMs: null,
        commits: [{ t: 10, n: 2, renderMs: null, pruned: true, roots: [{ name: "Feed", why: "mount" }] }],
        counts: [{ name: "Feed", n: 2, c: 1, selfMs: null }],
      }),
      15,
    );
    expect(out).toContain("profiling fields unavailable");
    expect(out).not.toContain("total render");
    expect(out).not.toContain("Top by self time:");
    expect(out).toContain("t+10ms  2 renders ← Feed (mount)");
  });

  it("explains an empty window instead of printing empty sections", () => {
    const out = formatReport(
      report({ commitCount: 0, renderCount: 0, totalRenderMs: 0, commits: [], counts: [] }),
      15,
    );
    expect(out).toContain("no commits in window");
    expect(out).toContain("background: true");
    expect(out).not.toContain("Top by renders");
  });

  it("flags truncation and handler errors", () => {
    const out = formatReport(report({ truncated: true, errors: 3 }), 15);
    expect(out).toMatch(/truncated/i);
    expect(out).toMatch(/3 commits/);
  });

  it("stays short enough to read", () => {
    const many = report({
      commitCount: 60,
      commits: Array.from({ length: 300 }, (_, i) => ({
        t: i * 10,
        n: 3,
        renderMs: 1.5,
        pruned: true,
        roots: [{ name: "Feed", why: "mount" }],
      })),
      counts: Array.from({ length: 100 }, (_, i) => ({ name: `C${i}`, n: 100 - i, c: 2, selfMs: 100 - i })),
    });
    expect(formatReport(many, 15).split("\n").length).toBeLessThanOrEqual(50);
  });
});
