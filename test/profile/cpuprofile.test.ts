import { describe, it, expect } from "vitest";
import { summarizeProfile, frameKey, type CpuProfile } from "../../src/profile/cpuprofile.js";

/**
 * One synthetic profile, reused by most cases:
 *
 *   (root) ─┬─ (program)            1ms self
 *           ├─ (idle)               3ms self
 *           ├─ (garbage collector)  1ms self
 *           └─ App ────┬── render ── expensive   (App 1ms, render 1ms, expensive 4ms)
 *                      └── render                (a second node for the same function, 1ms)
 *
 * callFrame line/column are 0-based, as CDP reports them, so App at source
 * 10:5 is stored here as 9:4.
 */
function fixture(): CpuProfile {
  const frame = (functionName: string, line: number, col: number) => ({
    functionName,
    url: "http://localhost:8081/index.bundle",
    scriptId: "1",
    lineNumber: line,
    columnNumber: col,
  });
  return {
    startTime: 0,
    endTime: 12000,
    nodes: [
      { id: 1, callFrame: frame("(root)", -1, -1), hitCount: 0, children: [2, 3, 4, 8] },
      { id: 2, callFrame: frame("(program)", -1, -1), hitCount: 1 },
      { id: 3, callFrame: frame("(idle)", -1, -1), hitCount: 3 },
      { id: 4, callFrame: frame("App", 9, 4), hitCount: 1, children: [5, 7] },
      { id: 5, callFrame: frame("render", 19, 2), hitCount: 1, children: [6] },
      { id: 6, callFrame: frame("expensive", 29, 0), hitCount: 4 },
      { id: 7, callFrame: frame("render", 19, 2), hitCount: 1 },
      { id: 8, callFrame: frame("(garbage collector)", -1, -1), hitCount: 1 },
    ],
    samples: [3, 3, 3, 2, 4, 5, 6, 6, 7, 8],
    timeDeltas: [1000, 1000, 1000, 1000, 1000, 1000, 2000, 2000, 1000, 1000],
  };
}

const find = (entries: { name: string }[], name: string) => entries.find((e) => e.name === name)!;

describe("summarizeProfile", () => {
  it("attributes self time from samples/timeDeltas", () => {
    const s = summarizeProfile(fixture());
    expect(s.totalMs).toBeCloseTo(12, 5);
    expect(s.sampleCount).toBe(10);
    expect(find(s.bySelf, "expensive").selfMs).toBeCloseTo(4, 5);
    expect(find(s.bySelf, "App").selfMs).toBeCloseTo(1, 5);
  });

  it("aggregates duplicate nodes for the same function", () => {
    const s = summarizeProfile(fixture());
    const render = find(s.bySelf, "render");
    // Two nodes, 1ms self each; inclusive 3ms (with expensive) + 1ms.
    expect(render.selfMs).toBeCloseTo(2, 5);
    expect(render.inclusiveMs).toBeCloseTo(6, 5);
    expect(s.bySelf.filter((e) => e.name === "render")).toHaveLength(1);
  });

  it("computes inclusive time over the node tree", () => {
    const s = summarizeProfile(fixture());
    expect(find(s.byInclusive, "App").inclusiveMs).toBeCloseTo(7, 5);
    expect(find(s.byInclusive, "expensive").inclusiveMs).toBeCloseTo(4, 5);
    expect(s.byInclusive[0].name).toBe("App");
  });

  it("reports percentages against the sampled total", () => {
    const s = summarizeProfile(fixture());
    expect(find(s.bySelf, "expensive").selfPct).toBeCloseTo((4 / 12) * 100, 3);
    expect(find(s.byInclusive, "App").inclusivePct).toBeCloseTo((7 / 12) * 100, 3);
  });

  it("splits the runtime frames into busy / idle / GC", () => {
    const s = summarizeProfile(fixture());
    expect(s.idlePct).toBeCloseTo(25, 3);
    expect(s.gcPct).toBeCloseTo((1 / 12) * 100, 3);
    // (program) is VM work, so it counts as busy even though it is not a JS frame.
    expect(s.busyPct).toBeCloseTo((8 / 12) * 100, 3);
    expect(s.busyPct + s.idlePct + s.gcPct).toBeCloseTo(100, 3);
  });

  it("keeps runtime frames out of the function tables", () => {
    const s = summarizeProfile(fixture());
    const names = s.bySelf.map((e) => e.name);
    expect(names).not.toContain("(idle)");
    expect(names).not.toContain("(root)");
    expect(names).not.toContain("(program)");
    expect(names).not.toContain("(garbage collector)");
  });

  it("sorts bySelf by self time and byInclusive by inclusive time", () => {
    const s = summarizeProfile(fixture());
    expect(s.bySelf.map((e) => e.name)).toEqual(["expensive", "render", "App"]);
    expect(s.byInclusive.map((e) => e.name)).toEqual(["App", "render", "expensive"]);
  });

  it("stores 1-based line/column and returns the raw url", () => {
    const s = summarizeProfile(fixture());
    const app = find(s.bySelf, "App");
    expect(app.line).toBe(10);
    expect(app.col).toBe(5);
    expect(app.url).toContain("index.bundle");
  });

  it("falls back to hitCount x mean delta when samples are missing", () => {
    const p = fixture();
    delete p.samples;
    delete p.timeDeltas;
    const s = summarizeProfile(p);
    // 12 hits spread over a 12ms span — the same numbers as the sampled path.
    expect(find(s.bySelf, "expensive").selfMs).toBeCloseTo(4, 5);
    expect(find(s.byInclusive, "App").inclusiveMs).toBeCloseTo(7, 5);
    expect(s.idlePct).toBeCloseTo(25, 3);
    expect(s.sampleCount).toBe(12);
  });

  it("returns an empty summary for a profile with no samples at all", () => {
    const s = summarizeProfile({ nodes: [], samples: [], timeDeltas: [] });
    expect(s.sampleCount).toBe(0);
    expect(s.bySelf).toEqual([]);
    expect(s.totalMs).toBe(0);
    expect(s.busyPct).toBe(0);
  });

  it("does not hang on a profile whose children form a cycle", () => {
    const p = fixture();
    p.nodes[5].children = [4]; // expensive -> App
    expect(() => summarizeProfile(p)).not.toThrow();
  });

  it("frameKey identifies a function by name and source position", () => {
    expect(frameKey({ functionName: "App", url: "b.js", lineNumber: 9, columnNumber: 4 })).toBe("App@b.js:10:5");
    expect(frameKey({ url: "b.js", lineNumber: 0, columnNumber: 0 })).toBe("(anonymous)@b.js:1:1");
  });
});
