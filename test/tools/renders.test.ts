import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerRenderTools } from "../../src/tools/renders.js";
import { resetJobs, listJobs } from "../../src/core/jobs.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, type FakeMetro } from "../helpers/fakeCdp.js";

let metro: FakeMetro;
beforeEach(() => {
  getRegistry().reset();
  resetJobs();
});
afterEach(async () => {
  getRegistry().reset();
  resetJobs();
  await metro?.close();
});

const REPORT = {
  version: 1,
  pruned: true,
  profiling: true,
  durationMs: 5000,
  commitCount: 2,
  renderCount: 4,
  totalRenderMs: 30,
  commits: [
    { t: 1234, t0: 1230, n: 4, renderMs: 30, pruned: true, roots: [{ name: "Feed", why: "props: items" }] },
  ],
  counts: [
    { name: "Row", n: 3, c: 1, selfMs: 15 },
    { name: "Feed", n: 1, c: 1, selfMs: 15 },
  ],
  truncated: false,
  errors: 0,
};

/** The envelope core/evaluate.ts wraps every expression in. */
function ok(value: unknown): { result: { value: string } } {
  return { result: { value: JSON.stringify({ s: "ok", v: value }) } };
}

/**
 * `installStatus` answers the install snippet; everything else is the profiling
 * snippet, recognised by the `rp.start()` call only it contains (the expression
 * reaches the fake JSON-escaped inside the eval wrapper, which leaves plain
 * substrings intact).
 */
async function connect(installStatus: string, report: unknown = REPORT): Promise<string[]> {
  const seen: string[] = [];
  metro = await startFakeMetro({ port: 0 });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", (p) => {
    const expr = String(p.expression);
    seen.push(expr);
    if (expr.includes("rp.start()")) return ok(report);
    if (expr.includes("no-hook")) return ok(installStatus);
    return ok(undefined);
  });
  await getRegistry().connect({ port: metro.port });
  return seen;
}

function server() {
  const s = makeServer();
  registerRenderTools(s);
  return s;
}

describe("profile_renders", () => {
  it("installs the hook, profiles, and formats the report", async () => {
    const seen = await connect("ok");
    const res = await callTool(server(), "profile_renders", { duration_ms: 1000 });
    expect(res.isError).toBeFalsy();
    const out = res.content[0].text as string;
    expect(out).toContain("5.0s · 2 commits · 4 component renders");
    expect(out).toContain("Row ×3");
    expect(out).toContain("Feed (props: items)");
    // Install first, then profile — and the install is version-checked, not
    // blindly re-run per commit.
    expect(seen.some((e) => e.includes("no-hook"))).toBe(true);
    expect(seen.some((e) => e.includes("rp.start()"))).toBe(true);
  });

  it("honours the top parameter", async () => {
    await connect("ok");
    const res = await callTool(server(), "profile_renders", { duration_ms: 1000, top: 1 });
    const out = res.content[0].text as string;
    expect(out).toContain("Row ×3");
    expect(out).not.toMatch(/^ *Feed ×1/m);
  });

  it("explains that a dev build is required when the DevTools hook is missing", async () => {
    await connect("no-hook");
    const res = await callTool(server(), "profile_renders", { duration_ms: 1000 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/dev build/i);
  });

  it("asks for a reload when an older profiler version is wedged in place", async () => {
    await connect("stale");
    const res = await callTool(server(), "profile_renders", { duration_ms: 1000 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/reload/i);
  });

  it("reports an unusable result instead of pretending it parsed", async () => {
    await connect("ok", "not a report");
    const res = await callTool(server(), "profile_renders", { duration_ms: 1000 });
    expect(res.isError).toBe(true);
  });

  it("rejects a duration the caller cannot wait out", async () => {
    await connect("ok");
    const res = await callTool(server(), "profile_renders", { duration_ms: 600000 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/60000|60s/);
  });

  it("starts a background job and hands back a pollable id", async () => {
    await connect("ok");
    const res = await callTool(server(), "profile_renders", {
      duration_ms: 1000,
      background: true,
      label: "scroll the feed",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/job j1 started/);
    expect(res.content[0].text).toContain("get_job");
    const jobs = listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].label).toBe("scroll the feed");
  });

  it("does not start a background job when the hook is missing", async () => {
    await connect("no-hook");
    const res = await callTool(server(), "profile_renders", { duration_ms: 1000, background: true });
    expect(res.isError).toBe(true);
    expect(listJobs()).toHaveLength(0);
  });
});
