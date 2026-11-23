import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRuntimeTools } from "../../src/tools/runtime.js";
import { resetJobs, listJobs } from "../../src/core/jobs.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, NO_REPLY, type FakeMetro } from "../helpers/fakeCdp.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

describe("eval_js", () => {
  it("returns the evaluated value", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) => {
      if (String(p.expression).includes("2 + 3")) return { result: { value: 5 } };
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerRuntimeTools(server);
    const res = await callTool(server, "eval_js", { code: "2 + 3" });
    expect(res.content[0].text).toContain("5");
  });

  it("rejects empty code with a UserInputError", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({ result: { value: undefined } }));
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerRuntimeTools(server);
    const res = await callTool(server, "eval_js", { code: "" });
    expect(res.isError).toBe(true);
  });
});

describe("eval_js failure reporting", () => {
  it("reports an app-side throw as an app error, not a lost connection", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({
      result: { value: JSON.stringify({ s: "err", e: "Error: BOOM_TEST" }) },
    }));
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerRuntimeTools(server);
    const res = await callTool(server, "eval_js", { code: "boom()" });
    expect(res.content[0].text).toContain("App error: Error: BOOM_TEST");
    expect(res.content[0].text).not.toMatch(/Not connected|starting Metro/i);
  });

  it("reports a busy JS thread as not responding, not as a lost connection", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({ result: { value: JSON.stringify({ s: "ok", v: "ok" }) } }));
    await getRegistry().connect({ port: metro.port });
    metro.setHandler("Runtime.evaluate", () => NO_REPLY); // the thread never gets to it
    const server = makeServer();
    registerRuntimeTools(server);
    const res = await callTool(server, "eval_js", { code: "1 + 1", timeout_ms: 150 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^App not responding: .*timed out after 150ms/);
    expect(res.content[0].text).toMatch(/socket is still open/);
    expect(res.content[0].text).not.toMatch(/Not connected|Run 'connect'|starting Metro/i);
    expect(getRegistry().active_or_null?.connected).toBe(true);
  });

  it("accepts a caller-supplied timeout for long operations", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    let seenPending = false;
    metro.setHandler("Runtime.evaluate", (p: any) => {
      const expr = String(p.expression);
      if (expr.includes("delete slots")) {
        // poll: settle on the second look
        if (!seenPending) {
          seenPending = true;
          return { result: { value: JSON.stringify({ s: "pending" }) } };
        }
        return { result: { value: JSON.stringify({ s: "ok", v: "SLOW_DONE" }) } };
      }
      return { result: { value: JSON.stringify({ s: "pending", t: "t1" }) } };
    });
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerRuntimeTools(server);
    const res = await callTool(server, "eval_js", { code: "slowThing()", timeout_ms: 30000 });
    expect(res.content[0].text).toBe("SLOW_DONE");
  });
});

describe("eval_js background mode + get_job", () => {
  async function connectedServer(): Promise<McpServer> {
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerRuntimeTools(server);
    return server;
  }

  beforeEach(() => resetJobs());

  it("returns a job id immediately while the evaluation is still running", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    // A promise that never settles: foreground eval_js would hang until timeout.
    // Only the snippet under test is pending — the interceptor installs that
    // connect() awaits must still answer.
    metro.setHandler("Runtime.evaluate", (p: any) => {
      const expr = String(p.expression);
      if (expr.includes("never()")) return { result: { value: JSON.stringify({ s: "pending", t: "t1" }) } };
      if (expr.includes("delete slots")) return { result: { value: JSON.stringify({ s: "pending" }) } };
      return { result: { value: JSON.stringify({ s: "ok", v: "ok" }) } };
    });
    const server = await connectedServer();
    const res = await callTool(server, "eval_js", { code: "never()", background: true });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("j1");
    expect(res.content[0].text).toMatch(/get_job/);

    const status = await callTool(server, "get_job", { id: "j1" });
    expect(status.content[0].text).toMatch(/running/);
  });

  it("hands back the value once the background job finishes", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({
      result: { value: JSON.stringify({ s: "ok", v: { total: 42 } }) },
    }));
    const server = await connectedServer();
    await callTool(server, "eval_js", { code: "measure()", background: true, label: "measure" });
    await new Promise((r) => setTimeout(r, 30));
    const status = await callTool(server, "get_job", { id: "j1" });
    expect(status.content[0].text).toMatch(/done/);
    expect(status.content[0].text).toContain('"total":42');
  });

  it("prints a profile_renders job as the formatted report, counts included", async () => {
    // A 5s window easily has 60 commits; raw, that JSON passed 4000 chars well
    // before the per-component counts and the cut removed them.
    const report = {
      version: 1, pruned: true, profiling: true, durationMs: 5000, commitCount: 60, renderCount: 180, totalRenderMs: 90,
      commits: Array.from({ length: 60 }, (_, i) => ({
        t: i * 80, n: 3, renderMs: 1.5, pruned: true,
        roots: [{ name: "FeedRowWithAVeryLongComponentName", why: "props: item, onPress" }],
      })),
      counts: [{ name: "FeedRowWithAVeryLongComponentName", n: 120, c: 60, selfMs: 60 }, { name: "Avatar", n: 60, c: 60, selfMs: 30 }],
      truncated: false, errors: 0,
    };
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({ result: { value: JSON.stringify({ s: "ok", v: report }) } }));
    const server = await connectedServer();
    await callTool(server, "eval_js", { code: "profile()", background: true });
    await new Promise((r) => setTimeout(r, 30));
    const out: string = (await callTool(server, "get_job", { id: "j1" })).content[0].text;
    expect(out).toMatch(/^j1 \[done\]/);
    expect(out).toContain("Top by renders:");
    expect(out).toContain("FeedRowWithAVeryLongComponentName ×120");
    expect(out).toContain("Avatar ×60");
    expect(out).not.toContain('"commits"');
  });

  it("reports an app-side throw as a failed job, not a tool error", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({
      result: { value: JSON.stringify({ s: "err", e: "Error: BG_BOOM" }) },
    }));
    const server = await connectedServer();
    await callTool(server, "eval_js", { code: "boom()", background: true });
    await new Promise((r) => setTimeout(r, 30));
    const status = await callTool(server, "get_job", { id: "j1" });
    expect(status.content[0].text).toMatch(/failed/);
    expect(status.content[0].text).toContain("BG_BOOM");
  });

  it("lists every job when called without an id, and rejects an unknown one", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({ result: { value: JSON.stringify({ s: "ok", v: 1 }) } }));
    const server = await connectedServer();
    expect((await callTool(server, "get_job", {})).content[0].text).toMatch(/no background jobs/i);

    await callTool(server, "eval_js", { code: "one()", background: true, label: "first" });
    await callTool(server, "eval_js", { code: "two()", background: true });
    await new Promise((r) => setTimeout(r, 30));
    const list = await callTool(server, "get_job", {});
    expect(list.content[0].text).toContain("j1");
    expect(list.content[0].text).toContain("first");
    expect(list.content[0].text).toContain("j2");

    const bad = await callTool(server, "get_job", { id: "j99" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/j99/);
  });

  it("leaves foreground eval_js unchanged when background is absent or false", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({ result: { value: JSON.stringify({ s: "ok", v: 7 }) } }));
    const server = await connectedServer();
    const res = await callTool(server, "eval_js", { code: "7", background: false });
    expect(res.content[0].text).toBe("7");
    expect(listJobs()).toHaveLength(0);
  });
});
