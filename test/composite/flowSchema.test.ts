import { describe, it, expect } from "vitest";
import { parseFlow, parseFlowInput } from "../../src/composite/flowSchema.js";

describe("parseFlow", () => {
  it("accepts a valid flow", () => {
    const steps = parseFlow({ steps: [{ tap: { text: "Login" } }, { expect: { text: "Home" } }] });
    expect(steps).toHaveLength(2);
  });

  it("rejects more than 20 steps", () => {
    const steps = Array.from({ length: 21 }, () => ({ tap: { text: "x" } }));
    expect(() => parseFlow({ steps })).toThrow(/20/);
  });

  it("rejects an unknown step", () => {
    expect(() => parseFlow({ steps: [{ frobnicate: {} }] })).toThrow();
  });

  it("accepts duration_ms in a tap step", () => {
    const steps = parseFlow({ steps: [{ tap: { x: 1, y: 2, duration_ms: 500 } }] });
    expect((steps[0].tap as any).duration_ms).toBe(500);
  });

  it("accepts timeout_ms in wait_for, the spelling every other duration key uses", () => {
    // Field report: an agent wrote {wait_for:{text,timeout_ms}} by analogy with
    // duration_ms and got a bare "Unrecognized key(s)", concluding the wait
    // budget was not configurable at all.
    const steps = parseFlow({ steps: [{ wait_for: { text: "Email", timeout_ms: 5000 } }] });
    expect((steps[0].wait_for as any).timeout_ms).toBe(5000);
    expect((parseFlow({ steps: [{ wait_for: { text: "Email", timeout: 5000 } }] })[0].wait_for as any).timeout).toBe(
      5000,
    );
  });

  it("refuses both timeout spellings in one wait_for rather than picking a winner", () => {
    expect(() => parseFlow({ steps: [{ wait_for: { text: "Email", timeout: 1000, timeout_ms: 5000 } }] })).toThrow(
      /not both/,
    );
  });

  it("rejects unknown keys inside a step object instead of silently stripping them", () => {
    // Real-world failure: an agent sent {wait_for: {ms: 2000}}; "ms" was silently
    // dropped, leaving wait_for({}) which always times out.
    expect(() => parseFlow({ steps: [{ wait_for: { ms: 2000 } }] })).toThrow(/ms/);
    expect(() => parseFlow({ steps: [{ tap: { testId: "x" } }] })).toThrow(/testId/);
  });
});

describe("one action per step", () => {
  it("rejects a step carrying two actions instead of silently running the first", () => {
    // {tap, expect} used to run the tap and drop the assertion — a green flow
    // that verified nothing.
    expect(() => parseFlow({ steps: [{ tap: { text: "Settings" }, expect: { text: "NOPE" } }] })).toThrow(
      /2 actions \(tap, expect\)/,
    );
  });

  it("rejects an empty step", () => {
    expect(() => parseFlow({ steps: [{}] })).toThrow(/no action/i);
  });

  it("allows settle alongside an action (it is a modifier)", () => {
    const steps = parseFlow({ steps: [{ tap: { text: "Go" }, settle: 200 }] });
    expect(steps[0].settle).toBe(200);
  });

  it("still accepts a well-formed multi-step flow", () => {
    const steps = parseFlow({ steps: [{ tap: { text: "Login" } }, { expect: { text: "Home" } }] });
    expect(steps).toHaveLength(2);
  });
});

describe("swipe needs a direction or four coordinates (D9)", () => {
  // {swipe:{}} used to pass validation and reach `axe swipe` with undefined
  // coordinates, which answered with its own usage dump. The plain `swipe` tool
  // has always refused the same input with this sentence; both surfaces now do.
  it("rejects an empty swipe with the same message the swipe tool uses", () => {
    expect(() => parseFlow({ steps: [{ swipe: {} }] })).toThrow("Provide a direction or x1,y1,x2,y2.");
  });

  it("accepts a directional swipe", () => {
    const steps = parseFlow({ steps: [{ swipe: { direction: "up" } }] });
    expect((steps[0].swipe as any).direction).toBe("up");
  });

  it("accepts a fully specified coordinate swipe", () => {
    const steps = parseFlow({ steps: [{ swipe: { x1: 1, y1: 2, x2: 3, y2: 4 } }] });
    expect((steps[0].swipe as any).x2).toBe(3);
  });

  it("rejects a partial coordinate set — half a vector is not a swipe", () => {
    expect(() => parseFlow({ steps: [{ swipe: { x1: 1, y1: 2 } }] })).toThrow(
      "Provide a direction or x1,y1,x2,y2.",
    );
  });

  it("still refuses an unknown key inside swipe", () => {
    // The refinement must sit on top of .strict(), not replace it.
    expect(() => parseFlow({ steps: [{ swipe: { direction: "up", durationMs: 300 } }] })).toThrow(
      /durationMs/,
    );
  });
});

describe("input path and typing target", () => {
  it("accepts via on a tap step and rejects a value outside the enum", () => {
    const steps = parseFlow({ steps: [{ tap: { text: "x", via: "js" } }] });
    expect((steps[0].tap as any).via).toBe("js");
    expect(() => parseFlow({ steps: [{ tap: { text: "x", via: "nope" } }] })).toThrow("received 'nope'");
  });

  it("accepts a flow-level via as the default for every step", () => {
    const flow = parseFlowInput({ steps: [{ tap: { text: "x" } }], via: "js" });
    expect(flow.via).toBe("js");
    expect(flow.steps).toHaveLength(1);
    expect(() => parseFlowInput({ steps: [{ tap: { text: "x" } }], via: "nope" })).toThrow(
      "received 'nope'",
    );
  });

  it("still accepts a bare string into, which means a testID", () => {
    // Backward compatibility is deliberate: flows written against the old
    // testID-only parameter must keep running unchanged.
    const steps = parseFlow({ steps: [{ type: { text: "x", into: "someTestID" } }] });
    expect((steps[0].type as any).into).toBe("someTestID");
  });

  it("accepts an into object selecting by placeholder", () => {
    // The tested app's search field has placeholder "Search" and no testID at
    // all — the case that made the testID-only parameter dead on a real app.
    const steps = parseFlow({ steps: [{ type: { text: "x", into: { placeholder: "Search" } } }] });
    expect((steps[0].type as any).into.placeholder).toBe("Search");
  });

  it("rejects a misspelled key inside into instead of silently dropping it", () => {
    // Lowercase d. A widened parameter must not widen into a place where typos
    // go quiet: {testId} would resolve to no input at all.
    expect(() => parseFlow({ steps: [{ type: { text: "x", into: { testId: "x" } } }] })).toThrow(
      /testId/,
    );
  });

  it("accepts via on a type step", () => {
    const steps = parseFlow({ steps: [{ type: { text: "x", via: "os" } }] });
    expect((steps[0].type as any).via).toBe("os");
  });
});
