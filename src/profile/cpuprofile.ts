/**
 * Aggregation over a Chrome `.cpuprofile` — the shape `Profiler.stop` returns.
 *
 * Kept pure and free of CDP so the arithmetic that decides "which function is
 * burning the frame budget" can be fixture-tested: the profiles that expose the
 * interesting edge cases (no `samples` array, the same function split across
 * dozens of nodes, a GC-dominated run) are the ones that are hardest to
 * reproduce against a live app.
 */

export type CallFrame = {
  functionName?: string;
  url?: string;
  scriptId?: string;
  /** 0-based, as CDP reports it. */
  lineNumber?: number;
  /** 0-based, as CDP reports it. */
  columnNumber?: number;
};

export type ProfileNode = {
  id: number;
  callFrame: CallFrame;
  hitCount?: number;
  children?: number[];
};

export type CpuProfile = {
  nodes: ProfileNode[];
  /** Microseconds. */
  startTime?: number;
  /** Microseconds. */
  endTime?: number;
  /** Node id per sample. */
  samples?: number[];
  /** Microseconds since the previous sample, one per entry in `samples`. */
  timeDeltas?: number[];
};

export type Entry = {
  name: string;
  url: string;
  /** 1-based — see frameKey. */
  line: number;
  /** 1-based — see frameKey. */
  col: number;
  selfMs: number;
  inclusiveMs: number;
  selfPct: number;
  inclusivePct: number;
};

export type ProfileSummary = {
  totalMs: number;
  busyPct: number;
  idlePct: number;
  gcPct: number;
  /** Samples the profile carried (or total hitCount on the fallback path). */
  sampleCount: number;
  /** Every function, self time descending. The caller slices. */
  bySelf: Entry[];
  /** Every function, inclusive time descending. */
  byInclusive: Entry[];
};

const IDLE_FRAME = "(idle)";
const GC_FRAME = "(garbage collector)";

/**
 * Frames the VM synthesises. They answer a different question than the function
 * tables do — "was the JS thread busy at all" — so they are reported as one
 * busy/idle/GC block and never as rows a user could go and optimise.
 */
export const RUNTIME_FRAME_NAMES = new Set(["(root)", "(program)", IDLE_FRAME, GC_FRAME]);

const ANONYMOUS = "(anonymous)";

/**
 * Identity of a *function*, not of a node: a hot function appears once per call
 * path, so `render` under `App` and `render` under `List` are separate nodes
 * that have to be summed back together.
 *
 * Line and column are stored 1-based. CDP reports them 0-based, but every
 * consumer downstream — the human reading `App.tsx:20`, and Metro's
 * /symbolicate, which takes the 1-based positions RN's own symbolicator posts —
 * wants 1-based, so the +1 happens once, here, rather than at each use site.
 */
export function frameKey(frame: CallFrame): string {
  return `${functionName(frame)}@${frame.url ?? ""}:${line1(frame.lineNumber)}:${line1(frame.columnNumber)}`;
}

function functionName(frame: CallFrame): string {
  return frame.functionName && frame.functionName.length > 0 ? frame.functionName : ANONYMOUS;
}

function line1(value: number | undefined): number {
  // Synthetic frames report -1; anything below the first real line clamps to it
  // so no row ever shows a negative or zero source position.
  return typeof value === "number" && value >= 0 ? value + 1 : 1;
}

function spanMicros(profile: CpuProfile): number | undefined {
  const { startTime, endTime } = profile;
  if (typeof startTime !== "number" || typeof endTime !== "number") return undefined;
  const span = endTime - startTime;
  return Number.isFinite(span) && span > 0 ? span : undefined;
}

/**
 * Self time per node id, in microseconds.
 *
 * `timeDeltas[i]` is the gap that ended at `samples[i]`, so it is charged to
 * that sample's node. When the profile carries no samples (some Hermes builds
 * return hitCounts only) the wall-clock span is spread evenly over the hits —
 * an estimate, but one that still ranks functions correctly.
 */
function selfMicrosByNode(profile: CpuProfile): { self: Map<number, number>; sampleCount: number } {
  const self = new Map<number, number>();
  const add = (id: number, us: number) => self.set(id, (self.get(id) ?? 0) + us);

  const { samples, timeDeltas } = profile;
  if (Array.isArray(samples) && samples.length > 0 && Array.isArray(timeDeltas)) {
    for (let i = 0; i < samples.length; i++) add(samples[i], timeDeltas[i] ?? 0);
    return { self, sampleCount: samples.length };
  }

  const nodes = profile.nodes ?? [];
  const hits = nodes.reduce((n, node) => n + (node.hitCount ?? 0), 0);
  if (hits === 0) return { self, sampleCount: 0 };
  const deltaSum = Array.isArray(timeDeltas) ? timeDeltas.reduce((a, b) => a + (b ?? 0), 0) : 0;
  // Last resort (no span, no deltas): Hermes' default sampling interval, 1ms.
  const durationUs = spanMicros(profile) ?? (deltaSum > 0 ? deltaSum : hits * 1000);
  const meanUs = durationUs / hits;
  for (const node of nodes) if (node.hitCount) add(node.id, node.hitCount * meanUs);
  return { self, sampleCount: hits };
}

/** Self + every descendant, per node id. */
function inclusiveMicrosByNode(profile: CpuProfile, self: Map<number, number>): Map<number, number> {
  const byId = new Map((profile.nodes ?? []).map((n) => [n.id, n]));
  const memo = new Map<number, number>();
  const onStack = new Set<number>();

  const walk = (id: number): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    // A malformed profile (or one truncated mid-write) can point a child back at
    // an ancestor; counting that edge as zero keeps the tool from hanging.
    if (onStack.has(id)) return 0;
    onStack.add(id);
    let total = self.get(id) ?? 0;
    for (const child of byId.get(id)?.children ?? []) total += walk(child);
    onStack.delete(id);
    memo.set(id, total);
    return total;
  };

  for (const node of profile.nodes ?? []) walk(node.id);
  return memo;
}

type Bucket = { name: string; url: string; line: number; col: number; selfUs: number; inclusiveUs: number };

export function summarizeProfile(profile: CpuProfile): ProfileSummary {
  const nodes = profile?.nodes ?? [];
  const { self, sampleCount } = selfMicrosByNode(profile ?? { nodes: [] });
  const inclusive = inclusiveMicrosByNode(profile ?? { nodes: [] }, self);

  let accountedUs = 0;
  for (const us of self.values()) accountedUs += us;

  let idleUs = 0;
  let gcUs = 0;
  const buckets = new Map<string, Bucket>();

  for (const node of nodes) {
    const name = functionName(node.callFrame ?? {});
    const selfUs = self.get(node.id) ?? 0;
    if (name === IDLE_FRAME) {
      idleUs += selfUs;
      continue;
    }
    if (name === GC_FRAME) {
      gcUs += selfUs;
      continue;
    }
    // (root)/(program) is VM bookkeeping: it counts as busy below, but it is not
    // a function anyone can go and fix, so it gets no row.
    if (RUNTIME_FRAME_NAMES.has(name)) continue;

    const key = frameKey(node.callFrame ?? {});
    const bucket = buckets.get(key) ?? {
      name,
      url: node.callFrame?.url ?? "",
      line: line1(node.callFrame?.lineNumber),
      col: line1(node.callFrame?.columnNumber),
      selfUs: 0,
      inclusiveUs: 0,
    };
    bucket.selfUs += selfUs;
    // Recursion double-counts here (an inner frame's time is inside its outer
    // frame's too). That is how every flat profile view reports it, and the
    // alternative — dropping nested occurrences — hides genuinely hot recursion.
    bucket.inclusiveUs += inclusive.get(node.id) ?? 0;
    buckets.set(key, bucket);
  }

  // Percentages are of the time the samples actually account for, so busy + idle
  // + GC is always 100% even when the profile's span disagrees with its deltas.
  const denominator = accountedUs > 0 ? accountedUs : 1;
  const pct = (us: number) => (us / denominator) * 100;
  const busyUs = Math.max(0, accountedUs - idleUs - gcUs);

  const entries = [...buckets.values()].map(
    (b): Entry => ({
      name: b.name,
      url: b.url,
      line: b.line,
      col: b.col,
      selfMs: b.selfUs / 1000,
      inclusiveMs: b.inclusiveUs / 1000,
      selfPct: pct(b.selfUs),
      inclusivePct: pct(b.inclusiveUs),
    }),
  );

  const bySelf = [...entries].sort((a, b) => b.selfMs - a.selfMs || b.inclusiveMs - a.inclusiveMs);
  const byInclusive = [...entries].sort((a, b) => b.inclusiveMs - a.inclusiveMs || b.selfMs - a.selfMs);

  return {
    totalMs: (spanMicros(profile ?? { nodes: [] }) ?? accountedUs) / 1000,
    busyPct: accountedUs > 0 ? pct(busyUs) : 0,
    idlePct: accountedUs > 0 ? pct(idleUs) : 0,
    gcPct: accountedUs > 0 ? pct(gcUs) : 0,
    sampleCount,
    bySelf,
    byInclusive,
  };
}
