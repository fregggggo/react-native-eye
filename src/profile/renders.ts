// Answers "which components re-rendered, how many times, and what started each
// commit" without the agent hand-writing a tree-walking hook — the version it
// writes walks the whole fiber tree on every commit and costs up to 20% of the
// JS thread.
//
// Two things keep this cheap:
//   1. it is switchable — while `active` is false the wrapper does nothing but
//      chain to the hook it replaced, so an installed-but-idle profiler costs
//      one function call per commit;
//   2. it prunes — React 18 bubbles every child's flags into the parent's
//      `subtreeFlags`, so a subtree that did no work is skipped without reading
//      a single one of its fibers. The walk then costs what the commit costs,
//      not what the tree costs.
//
// Like src/core/inject.ts, the hook must never throw into app code: an
// exception out of onCommitFiberRoot surfaces as a redbox, i.e. the tool would
// fabricate the very errors it exists to observe. The whole commit handler is
// wrapped and failures are counted into `errors` instead.

export const RENDER_PROFILER_VERSION = 1;

export type RenderRoot = {
  name: string;
  /** "mount", "own state/hook", or "props: a, b" — the shallow-compare answer. */
  why: string;
};

export type CommitRecord = {
  /** ms since the profile started. */
  t: number;
  /** Start of the render phase, ms since the profile started. Absent when React's clock could not be lined up with ours. */
  t0?: number;
  /** Component fibers that rendered in this commit. */
  n: number;
  /** Summed self time of those fibers, or null when the build has no profiling fields. */
  renderMs: number | null;
  /** False when this commit had to be walked in full (React 17 fibers). */
  pruned: boolean;
  roots: RenderRoot[];
  /** Render roots beyond the per-commit cap. */
  more?: number;
};

export type NameCount = {
  name: string;
  /** Renders. */
  n: number;
  /** Commits this name rendered in. */
  c: number;
  /** Summed self time, or null when the build has no profiling fields. */
  selfMs: number | null;
};

export type RenderReport = {
  version: number;
  /** False when any commit fell back to a full walk (React 17 and earlier). */
  pruned: boolean;
  /** False when React's profiling fields were missing — counts stay valid, timings do not. */
  profiling: boolean;
  durationMs: number;
  commitCount: number;
  renderCount: number;
  totalRenderMs: number | null;
  commits: CommitRecord[];
  counts: NameCount[];
  /** A cap was hit: the totals are still complete, the detail below them is not. */
  truncated: boolean;
  /** Commits whose handler threw and were skipped rather than surfaced to the app. */
  errors: number;
};

/** "ok" — installed and live; "no-hook" — not a dev build; "stale" — an older version is wedged in place. */
export type InstallStatus = "ok" | "no-hook" | "stale";

export const RENDER_PROFILER_SOURCE = `
(function () {
  var VERSION = ${RENDER_PROFILER_VERSION};
  // RN installs the DevTools global hook in dev builds even with no DevTools
  // attached, and React reads onCommitFiberRoot off it at call time — so
  // replacing the property after React injected still works. No hook at all
  // means a production bundle, which this tool cannot profile.
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return "no-hook";

  var prev = globalThis.__RNE_RP__;
  // The installed-flag alone is a lie a reload outlives (see inject.ts): the
  // app's own hook takes the slot back and the flag keeps claiming we are
  // chained. The wrapper function in the slot is the only honest evidence.
  var live = !!prev && hook.onCommitFiberRoot === prev.wrapper;
  if (prev && prev.version === VERSION && live) return "ok";
  if (prev && prev.version !== VERSION) {
    // An older build's wrapper is in the chain. Wrapping on top of it would
    // count every commit twice, so this is only safe when that build saved
    // what it replaced; otherwise say so — a reload clears it.
    var unwrappable = false;
    try { unwrappable = Object.prototype.hasOwnProperty.call(prev, "orig"); } catch (e) {}
    if (!unwrappable) return "stale";
    try { hook.onCommitFiberRoot = prev.orig; } catch (e) { return "stale"; }
  }
  // Same version but our wrapper is gone: chain onto whatever is live now.
  // Restoring first would put the *pre-reload* handler back and lose the app's.
  var orig = hook.onCommitFiberRoot;

  var PW = 1;              // PerformedWork. 0b1 in every React from 16.5 to 19.
  var MAX_COMMITS = 300;
  var MAX_NAMES = 400;
  var MAX_REPORT_NAMES = 100;
  var MAX_ROOTS = 6;
  var MAX_PROPS = 5;
  var MAX_SIBLINGS = 5000;

  var state = {
    version: VERSION,
    active: false,
    wrapper: null,
    orig: orig,
    startedAt: 0,
    startedAtReact: 0,
    commits: [],
    counts: {},
    names: 0,
    commitCount: 0,
    renderCount: 0,
    totalRenderMs: 0,
    profiling: true,
    pruned: true,
    truncated: false,
    errors: 0
  };

  function safe(fn) { try { return fn(); } catch (e) { return undefined; } }
  function round1(x) { return Math.round(x * 10) / 10; }

  // React stamps actualStartTime from the Scheduler's clock, which prefers
  // performance.now() and falls back to Date.now(). Reading the same one here
  // is what makes a commit's t0 comparable to the profile start; when a build
  // disagrees the offset lands outside the window and is dropped rather than
  // reported as a nonsense timeline.
  function reactNow() {
    if (typeof performance === "object" && performance && typeof performance.now === "function") {
      return performance.now();
    }
    return Date.now();
  }

  // 0 function, 1 class, 11 forwardRef, 14 memo, 15 simple memo. Host
  // components, context and fragments are structure, not components a
  // developer can memoize, so counting them would only add noise.
  function isComponent(tag) {
    return tag === 0 || tag === 1 || tag === 11 || tag === 14 || tag === 15;
  }

  function nameOf(fiber) {
    var n = safe(function () {
      var t = fiber.type;
      for (var i = 0; i < 4; i++) {
        if (!t) return "";
        if (typeof t === "string") return t;
        if (t.displayName) return String(t.displayName);
        if (typeof t === "function") return t.name ? String(t.name) : "";
        // memo(X) is {type: X}; forwardRef(render) is {render: render}. A
        // SimpleMemoComponent already carries the inner function as its type.
        if (t.type) { t = t.type; continue; }
        if (t.render) { t = t.render; continue; }
        return "";
      }
      return "";
    });
    return n || "Anonymous";
  }

  function differs(a, b, key) {
    return safe(function () { return a[key] !== b[key]; }) === true;
  }

  // Deliberately shallow: this is the same comparison React.memo and a
  // dependency array make, so it answers the question the caller is actually
  // asking — "was this render avoidable by memoizing?".
  function whyOf(fiber) {
    var alt = safe(function () { return fiber.alternate; });
    if (!alt) return "mount";
    var next = safe(function () { return fiber.memoizedProps; });
    var prevProps = safe(function () { return alt.memoizedProps; });
    if (!next || !prevProps || typeof next !== "object" || typeof prevProps !== "object") return "own state/hook";
    var changed = [];
    var k;
    for (k in next) {
      if (changed.length > MAX_PROPS) break;
      if (differs(prevProps, next, k)) changed.push(k);
    }
    for (k in prevProps) {
      if (changed.length > MAX_PROPS) break;
      // A prop that was removed differs too, and only shows up from this side.
      if (safe(function () { return k in next; }) !== true) changed.push(k);
    }
    if (!changed.length) return "own state/hook";
    if (changed.length > MAX_PROPS) return "props: " + changed.slice(0, MAX_PROPS).join(", ") + ", ...";
    return "props: " + changed.join(", ");
  }

  /**
   * The fiber's own render cost. The root's actualDuration cannot be used as
   * the commit's cost: bubbleProperties sums every child's actualDuration, and
   * a child that bailed out keeps the stale value from the last time it
   * rendered — so the root's number is an accumulated total, not this commit's.
   * Subtracting the direct children's durations leaves only this fiber's work,
   * and summing that over the fibers that actually rendered is honest.
   */
  function selfTimeOf(fiber) {
    var d = safe(function () { return fiber.actualDuration; });
    if (typeof d !== "number") return null;
    var sum = 0;
    var c = safe(function () { return fiber.child; });
    var guard = 0;
    while (c && guard++ < MAX_SIBLINGS) {
      var cd = safe(function () { return c.actualDuration; });
      if (typeof cd === "number") sum += cd;
      c = safe(function () { return c.sibling; });
    }
    var self = d - sum;
    return self > 0 ? self : 0;
  }

  function bump(name, self, seen) {
    var key = "$" + name;   // prefixed: a raw "__proto__" key would set the prototype, not a count
    var e = state.counts[key];
    if (!e) {
      if (state.names >= MAX_NAMES) {
        state.truncated = true;
        name = "(other)";
        key = "$(other)";
        e = state.counts[key];
      }
      if (!e) {
        e = { name: name, n: 0, c: 0, selfMs: 0 };
        state.counts[key] = e;
        state.names++;
      }
    }
    e.n++;
    if (self === null) e.selfMs = null;
    else if (e.selfMs !== null) e.selfMs += self;
    if (!seen[key]) { seen[key] = 1; e.c++; }
  }

  function handle(root) {
    var current = root && root.current;
    if (!current) return;
    var rec = { t: Date.now() - state.startedAt, n: 0, renderMs: 0, pruned: true, roots: [] };
    var seen = {};
    var timed = true;
    var minStart = -1;
    var extraRoots = 0;
    // Past the cap a commit is still counted, it just stops carrying detail.
    var detail = state.commits.length < MAX_COMMITS;

    // Siblings are iterated and only children recurse, so a long list grows the
    // stack by one frame per level rather than one per row.
    function visit(fiber, ancestorRendered) {
      while (fiber) {
        var flags = fiber.flags;
        if (flags === undefined) flags = fiber.effectTag;   // React 17 and earlier
        var sub = fiber.subtreeFlags;
        if (sub === undefined) rec.pruned = false;
        var did = ((flags || 0) & PW) !== 0;
        if (!did && sub !== undefined && (sub & PW) === 0) {
          // Nothing here or below it rendered. Skipping without reading child,
          // type or props is the whole point: the cost tracks the commit, not
          // the tree. (React 17 has no subtreeFlags, so it never gets here.)
          fiber = fiber.sibling;
          continue;
        }
        var isComp = did && isComponent(fiber.tag);
        if (isComp) {
          rec.n++;
          var name = nameOf(fiber);
          var self = selfTimeOf(fiber);
          if (self === null) timed = false;
          else rec.renderMs += self;
          var st = safe(function () { return fiber.actualStartTime; });
          if (typeof st === "number" && (minStart < 0 || st < minStart)) minStart = st;
          bump(name, self, seen);
          // A render root is a rendered fiber with no rendered ancestor — the
          // update that started this commit landed there.
          if (!ancestorRendered) {
            if (detail && rec.roots.length < MAX_ROOTS) rec.roots.push({ name: name, why: whyOf(fiber) });
            else extraRoots++;
          }
        }
        var child = safe(function () { return fiber.child; });
        if (child) visit(child, ancestorRendered || isComp);
        fiber = fiber.sibling;
      }
    }

    visit(current, false);

    state.commitCount++;
    state.renderCount += rec.n;
    if (!rec.pruned) state.pruned = false;
    if (timed) state.totalRenderMs += rec.renderMs;
    else state.profiling = false;
    rec.renderMs = timed ? round1(rec.renderMs) : null;
    if (timed && minStart >= 0) {
      var offset = minStart - state.startedAtReact;
      if (offset >= 0 && offset <= rec.t + 1000) rec.t0 = Math.round(offset);
    }
    if (extraRoots) rec.more = extraRoots;
    if (detail) state.commits.push(rec);
    else state.truncated = true;
  }

  function clear() {
    state.commits = [];
    state.counts = {};
    state.names = 0;
    state.commitCount = 0;
    state.renderCount = 0;
    state.totalRenderMs = 0;
    state.profiling = true;
    state.pruned = true;
    state.truncated = false;
    state.errors = 0;
  }

  state.start = function () {
    clear();
    state.startedAt = Date.now();
    state.startedAtReact = reactNow();
    state.active = true;
    return true;
  };

  state.collect = function () {
    state.active = false;
    var all = [];
    for (var k in state.counts) {
      if (!Object.prototype.hasOwnProperty.call(state.counts, k)) continue;
      var e = state.counts[k];
      all.push({ name: e.name, n: e.n, c: e.c, selfMs: e.selfMs === null ? null : round1(e.selfMs) });
    }
    all.sort(function (a, b) { return b.n - a.n; });
    var out = all.slice(0, MAX_REPORT_NAMES);
    if (all.length > MAX_REPORT_NAMES) {
      // The hottest component is not always the most frequent one, so the
      // self-time leaders survive the cap even when their render count does not.
      var bySelf = all.slice();
      bySelf.sort(function (a, b) { return (b.selfMs || 0) - (a.selfMs || 0); });
      for (var i = 0; i < 10 && i < bySelf.length; i++) {
        if (out.indexOf(bySelf[i]) < 0) out.push(bySelf[i]);
      }
    }
    var report = {
      version: VERSION,
      pruned: state.pruned,
      profiling: state.profiling,
      durationMs: Date.now() - state.startedAt,
      commitCount: state.commitCount,
      renderCount: state.renderCount,
      totalRenderMs: state.profiling ? round1(state.totalRenderMs) : null,
      commits: state.commits,
      counts: out,
      truncated: state.truncated,
      errors: state.errors
    };
    clear();
    return report;
  };

  var wrapper = function () {
    // Idle costs one branch. Everything else is guarded: an exception out of
    // this handler would paint a redbox the app never had.
    if (state.active) {
      try { handle(arguments[1]); } catch (e) { state.errors++; }
    }
    if (typeof orig === "function") return orig.apply(hook, arguments);
  };
  state.wrapper = wrapper;
  globalThis.__RNE_RP__ = state;
  hook.onCommitFiberRoot = wrapper;
  return "ok";
})();
`;

/**
 * Activates the installed profiler, waits, and resolves with the report.
 *
 * Returning a thenable is deliberate: core/evaluate.ts parks a promise and
 * polls it with the app's own `.then`, so one snippet covers the whole window
 * without holding a CDP round trip open — and the same snippet runs unchanged
 * as a background job.
 */
export function renderProfileExpression(durationMs: number): string {
  const ms = Math.max(0, Math.round(durationMs));
  return `(function () {
    var rp = globalThis.__RNE_RP__;
    if (!rp || typeof rp.start !== "function" || typeof rp.collect !== "function") return { error: "not-installed" };
    rp.start();
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(rp.collect()); }, ${ms});
    });
  })()`;
}

export function isRenderReport(value: unknown): value is RenderReport {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.commits) && Array.isArray(v.counts) && typeof v.commitCount === "number";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const RECENT_COMMITS = 10;
const SELF_TIME_ROWS = 5;

/**
 * Exported so a later change can pretty-print a background job's raw value the
 * same way the foreground path does.
 */
export function formatReport(report: RenderReport, top: number): string {
  const header = [
    `${(report.durationMs / 1000).toFixed(1)}s`,
    plural(report.commitCount, "commit"),
    `${report.renderCount} component renders`,
  ];
  const timed = report.profiling && report.totalRenderMs !== null;
  if (timed) header.push(`total render ${Math.round(report.totalRenderMs as number)}ms`);
  header.push(report.pruned ? "pruned walk" : "full walk (React <18)");

  const lines = [header.join(" · ")];

  if (report.commitCount === 0) {
    lines.push(
      "",
      "no commits in window — interact with the app while profiling, or use background: true and drive it with tap/swipe",
    );
    return lines.join("\n");
  }

  if (!report.profiling) {
    lines.push(
      "render time: profiling fields unavailable (production or profiling-disabled build) — the counts below are still accurate",
    );
  }
  if (report.truncated) {
    lines.push("truncated — the totals above are complete, the per-commit and per-name detail below is not");
  }
  if (report.errors > 0) {
    lines.push(`note: ${plural(report.errors, "commit")} could not be inspected (the commit handler threw)`);
  }

  const byRenders = [...report.counts].sort((a, b) => b.n - a.n);
  lines.push("", "Top by renders:");
  for (const c of byRenders.slice(0, top)) {
    const ms = timed && c.selfMs !== null ? `  ${Math.round(c.selfMs)}ms` : "";
    lines.push(`  ${c.name} ×${c.n}${ms} (in ${plural(c.c, "commit")})`);
  }

  if (timed) {
    const bySelf = report.counts
      .filter((c) => typeof c.selfMs === "number")
      .sort((a, b) => (b.selfMs as number) - (a.selfMs as number))
      .slice(0, SELF_TIME_ROWS);
    if (bySelf.length > 0) {
      lines.push("", "Top by self time:");
      for (const c of bySelf) lines.push(`  ${c.name} ${Math.round(c.selfMs as number)}ms (×${c.n})`);
    }
  }

  lines.push("", "Recent commits:");
  for (const c of report.commits.slice(-RECENT_COMMITS)) {
    const ms = timed && typeof c.renderMs === "number" ? `  ${c.renderMs.toFixed(1)}ms` : "";
    const roots = c.roots.length
      ? c.roots.map((r) => `${r.name} (${r.why})`).join(", ") + (c.more ? ` +${c.more} more` : "")
      : "(no component roots)";
    lines.push(`  t+${c.t}ms  ${plural(c.n, "render")}${ms} ← ${roots}`);
  }

  return lines.join("\n");
}
