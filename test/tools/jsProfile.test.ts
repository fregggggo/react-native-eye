import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerJsProfileTools,
  captureProfile,
  STOP_GRACE_MS,
  type CdpSender,
} from "../../src/tools/jsProfile.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, type FakeMetro } from "../helpers/fakeCdp.js";
import type { CpuProfile } from "../../src/profile/cpuprofile.js";

const BUNDLE = "http://localhost:8081/index.bundle";

function profileFixture(): CpuProfile {
  const frame = (functionName: string, line: number, col: number) => ({
    functionName,
    url: BUNDLE,
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

let metro: FakeMetro;
let outDir: string;
let calls: string[];

/** A fake Metro with the Profiler domain wired up, already connected. */
async function connectWithProfiler(overrides?: Record<string, (p: any) => any>): Promise<void> {
  metro = await startFakeMetro({ port: 0 });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", () => ({ result: { value: JSON.stringify({ s: "ok", v: "ok" }) } }));
  for (const method of ["Profiler.enable", "Profiler.setSamplingInterval", "Profiler.start", "Profiler.disable"]) {
    metro.setHandler(method, () => {
      calls.push(method);
      return {};
    });
  }
  metro.setHandler("Profiler.stop", () => {
    calls.push("Profiler.stop");
    return { profile: profileFixture() };
  });
  for (const [method, fn] of Object.entries(overrides ?? {})) metro.setHandler(method, fn);
  await getRegistry().connect({ port: metro.port });
}

async function profileJs(args: Record<string, unknown>): Promise<any> {
  const server = makeServer();
  registerJsProfileTools(server);
  return callTool(server, "profile_js", args);
}

beforeEach(async () => {
  calls = [];
  getRegistry().reset();
  outDir = await mkdtemp(join(tmpdir(), "rne-profile-test-"));
  process.env.RNE_OUTPUT_DIR = outDir;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.RNE_OUTPUT_DIR;
  getRegistry().reset();
  await metro?.close();
  await rm(outDir, { recursive: true, force: true });
});

describe("profile_js CDP sequence", () => {
  it("enables, starts, stops and disables the Profiler domain", async () => {
    await connectWithProfiler();
    const res = await profileJs({ duration_ms: 10, save: false });
    expect(res.isError).toBeFalsy();
    expect(calls).toEqual(["Profiler.enable", "Profiler.start", "Profiler.stop", "Profiler.disable"]);
  });

  it("sets the sampling interval between enable and start when asked", async () => {
    await connectWithProfiler();
    let interval: unknown;
    metro.setHandler("Profiler.setSamplingInterval", (p) => {
      calls.push("Profiler.setSamplingInterval");
      interval = p?.interval;
      return {};
    });
    await profileJs({ duration_ms: 10, sampling_interval_us: 250, save: false });
    expect(calls).toEqual([
      "Profiler.enable",
      "Profiler.setSamplingInterval",
      "Profiler.start",
      "Profiler.stop",
      "Profiler.disable",
    ]);
    expect(interval).toBe(250);
  });

  it("still profiles when Hermes rejects the sampling interval, and says so", async () => {
    await connectWithProfiler({
      "Profiler.setSamplingInterval": () => {
        calls.push("Profiler.setSamplingInterval");
        throw new Error("Method not found");
      },
    });
    const res = await profileJs({ duration_ms: 10, sampling_interval_us: 250, save: false });
    expect(res.isError).toBeFalsy();
    expect(calls).toContain("Profiler.stop");
    expect(res.content[0].text).toMatch(/sampling_interval_us/);
  });

  it("still profiles when Profiler.enable is not implemented", async () => {
    await connectWithProfiler({
      "Profiler.enable": () => {
        calls.push("Profiler.enable");
        throw new Error("Method not found");
      },
    });
    const res = await profileJs({ duration_ms: 10, save: false });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Top self:");
  });

  it("explains a Profiler.start failure as a missing Profiler domain", async () => {
    await connectWithProfiler({
      "Profiler.start": () => {
        calls.push("Profiler.start");
        throw new Error("Method not found");
      },
    });
    const res = await profileJs({ duration_ms: 10, save: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Profiler domain/i);
    expect(calls).toContain("Profiler.disable");
  });

  it("disables the domain even when the profile fails", async () => {
    await connectWithProfiler({
      "Profiler.stop": () => {
        calls.push("Profiler.stop");
        throw new Error("Profiler domain not available");
      },
    });
    const res = await profileJs({ duration_ms: 10, save: false });
    expect(res.isError).toBe(true);
    expect(calls).toContain("Profiler.disable");
  });
});

describe("captureProfile", () => {
  function recorder(stop: () => Promise<any>): { cdp: CdpSender; sent: { method: string; opts?: any }[] } {
    const sent: { method: string; opts?: any }[] = [];
    const cdp: CdpSender = {
      send: async (method, _params, opts) => {
        sent.push({ method, opts });
        return method === "Profiler.stop" ? stop() : {};
      },
    };
    return { cdp, sent };
  }

  it("gives Profiler.stop the profile's own duration plus a grace period", async () => {
    const { cdp, sent } = recorder(async () => ({ profile: profileFixture() }));
    const { profile, notes } = await captureProfile(cdp, { durationMs: 20 });
    const stop = sent.find((s) => s.method === "Profiler.stop");
    expect(stop?.opts?.timeoutMs).toBe(20 + STOP_GRACE_MS);
    expect(profile.nodes).toHaveLength(8);
    expect(notes).toEqual([]);
  });

  it("reports a stop timeout as a blocked JS thread, not a lost connection", async () => {
    const { cdp } = recorder(async () => {
      throw new Error("Profiler.stop timed out after 30010ms — the app's JS thread may be blocked");
    });
    await expect(captureProfile(cdp, { durationMs: 10 })).rejects.toThrow(/JS thread/i);
    await expect(captureProfile(cdp, { durationMs: 10 })).rejects.toThrow(/longer duration|sample_cpu/i);
  });
});

describe("profile_js output", () => {
  it("summarises the profile and lists both tables", async () => {
    await connectWithProfiler();
    const res = await profileJs({ duration_ms: 10, save: false });
    const out = res.content[0].text as string;
    expect(out).toMatch(/busy 67% · idle 25% · GC 8%/);
    expect(out).toContain("Top self:");
    expect(out).toContain("Top inclusive:");
    expect(out).toContain("expensive");
    expect(out).toContain("index.bundle:30");
    expect(out).not.toContain("(idle)");
    expect(out.split("\n").length).toBeLessThanOrEqual(60);
  });

  it("honours top by trimming both tables", async () => {
    await connectWithProfiler();
    const res = await profileJs({ duration_ms: 10, save: false, top: 1 });
    const out = res.content[0].text as string;
    expect(out).toContain("expensive");
    expect(out).not.toContain("render");
  });

  it("keeps the columns aligned when a function name is very long", async () => {
    const long = "renderItemRowWithAnExtremelyLongNameIndeed";
    const profile = profileFixture();
    profile.nodes[5].callFrame.functionName = long;
    await connectWithProfiler({
      "Profiler.stop": () => {
        calls.push("Profiler.stop");
        return { profile };
      },
    });
    const res = await profileJs({ duration_ms: 10, save: false });
    const rows = (res.content[0].text as string).split("\n").filter((l) => l.includes("index.bundle:"));
    expect(rows.every((l) => l.indexOf("index.bundle:") === rows[0].indexOf("index.bundle:"))).toBe(true);
    expect(res.content[0].text).not.toContain(long);
  });

  it("mentions Chrome DevTools when the profile is saved", async () => {
    await connectWithProfiler();
    const res = await profileJs({ duration_ms: 10 });
    expect(res.content[0].text).toMatch(/Chrome DevTools/);
  });
});

describe("profile_js saving", () => {
  it("writes the raw profile next to the other recordings and names the path", async () => {
    await connectWithProfiler();
    const res = await profileJs({ duration_ms: 10 });
    const files = await readdir(outDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^rne-profile-.*\.cpuprofile$/);
    expect(res.content[0].text).toContain(join(outDir, files[0]));
    const saved = JSON.parse(await readFile(join(outDir, files[0]), "utf-8"));
    expect(saved.nodes).toHaveLength(8);
    expect(saved.samples).toHaveLength(10);
  });

  it("writes nothing with save: false", async () => {
    await connectWithProfiler();
    const res = await profileJs({ duration_ms: 10, save: false });
    expect(await readdir(outDir)).toEqual([]);
    expect(res.content[0].text).not.toContain("saved");
  });
});

describe("profile_js symbolication", () => {
  it("replaces bundle positions with source positions", async () => {
    await connectWithProfiler();
    let body: any;
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          stack: body.stack.map((f: any) => ({
            file: `/src/${f.methodName}.tsx`,
            lineNumber: f.lineNumber,
            column: f.column,
            methodName: f.methodName,
          })),
        }),
        { status: 200 },
      );
    });
    const res = await profileJs({ duration_ms: 10, save: false });
    const out = res.content[0].text as string;
    // CDP reports 0-based positions; Metro is asked in 1-based ones.
    expect(body.stack).toContainEqual({ file: BUNDLE, lineNumber: 30, column: 1, methodName: "expensive" });
    expect(out).toContain("expensive.tsx:30");
    expect(out).not.toContain("could not be symbolicated");
  });

  it("still produces the tables and adds a note when Metro cannot symbolicate", async () => {
    await connectWithProfiler();
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const res = await profileJs({ duration_ms: 10, save: false });
    const out = res.content[0].text as string;
    expect(res.isError).toBeFalsy();
    expect(out).toContain("expensive");
    expect(out).toContain("index.bundle:30");
    expect(out).toMatch(/symbolicate/i);
  });

  it("asks Metro about at most 200 frames", async () => {
    await connectWithProfiler();
    let count = 0;
    vi.stubGlobal("fetch", async (_url: string, init: any) => {
      count = JSON.parse(init.body).stack.length;
      return new Response("nope", { status: 500 });
    });
    await profileJs({ duration_ms: 10, save: false, top: 100 });
    expect(count).toBeLessThanOrEqual(200);
    expect(count).toBeGreaterThan(0);
  });
});

describe("profile_js failure modes", () => {
  it("reports an empty profile instead of printing empty tables", async () => {
    await connectWithProfiler({
      "Profiler.stop": () => {
        calls.push("Profiler.stop");
        return { profile: { nodes: [], samples: [], timeDeltas: [], startTime: 0, endTime: 0 } };
      },
    });
    const res = await profileJs({ duration_ms: 10, save: false });
    expect(res.content[0].text).toMatch(/no samples/i);
  });

  it("errors when there is no connection", async () => {
    getRegistry().reset();
    const res = await profileJs({ duration_ms: 10, save: false });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Not connected/);
  });
});
