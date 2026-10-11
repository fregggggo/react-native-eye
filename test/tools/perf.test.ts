import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerPerfTools, rafSnippet } from "../../src/tools/perf.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, type FakeMetro } from "../helpers/fakeCdp.js";
import type { CpuSample, DeviceDriver, FrameStats } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

const base = {
  platform: "ios",
  listDevices: async () => [{ platform: "ios", udid: "u", name: "iPhone 17", booted: true }],
  screenshotPng: async () => Buffer.from(""),
  screenshotFile: async () => {},
  rawLayout: async () => axeLayout([]),
  tapXY: async () => AXE,
  swipe: async () => AXE,
  typeText: async () => AXE,
  pressKey: async () => AXE,
  launchApp: async () => {},
  installApp: async () => {},
  recordStart: async () => ({ finalize: async () => {} }),
};

function driverWith(extra: Partial<DeviceDriver>): DeviceDriver {
  return { ...base, ...extra } as unknown as DeviceDriver;
}

const SAMPLE: CpuSample = {
  pid: 501,
  durationS: 3,
  totalSamples: 1200,
  busySamples: 400,
  threads: [
    {
      id: "1",
      name: "DispatchQueue_1: com.apple.main-thread",
      role: "main",
      share: 0.75,
      busyFraction: 0.5,
      topFrames: [
        { frame: "argb32_shade_axial_RGB  (in CoreGraphics)", share: 0.6 },
        { frame: "objc_msgSend  (in libobjc.A.dylib)", share: 0.4 },
      ],
    },
    {
      id: "2",
      name: "com.facebook.react.runtime.JavaScript",
      role: "js",
      share: 0.25,
      busyFraction: 0.17,
      topFrames: [{ frame: "hermes::vm::Interpreter::interpretFunction()  (in hermesvm)", share: 1 }],
    },
    { id: "3", name: "com.apple.uikit.eventfetch-thread", role: "other", share: 0, busyFraction: 0 },
  ],
};

async function connect(appId: string, onEvaluate?: (expression: string) => any) {
  metro = await startFakeMetro({ port: 0, targets: [{ id: "1", title: "RN", appId } as any] });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", (p: any) => ({
    result: { value: onEvaluate?.(String(p.expression)) },
  }));
  await getRegistry().connect({ port: metro.port });
}

describe("sample_cpu", () => {
  it("names the hot thread and its frames", async () => {
    const server = makeServer();
    registerPerfTools(server, { drivers: [driverWith({ cpuSample: async () => SAMPLE })] });
    const res = await callTool(server, "sample_cpu", { app_id: "com.x.app" });
    const out = res.content[0].text as string;
    expect(out).toContain("pid 501");
    expect(out).toContain("main");
    expect(out).toContain("com.facebook.react.runtime.JavaScript");
    expect(out).toContain("argb32_shade_axial_RGB");
    expect(out).toContain("hermes::vm::Interpreter");
    // Output has to stay readable in a transcript.
    expect(out.split("\n").length).toBeLessThanOrEqual(40);
  });

  it("clamps the window instead of handing 10 minutes to the profiler", async () => {
    const seen: number[] = [];
    const server = makeServer();
    registerPerfTools(server, {
      drivers: [
        driverWith({
          cpuSample: async (_u: string, _a: string, d: number) => {
            seen.push(d);
            return { ...SAMPLE, durationS: d };
          },
        }),
      ],
    });
    await callTool(server, "sample_cpu", { app_id: "com.x.app", duration_s: 600 });
    await callTool(server, "sample_cpu", { app_id: "com.x.app", duration_s: 0 });
    await callTool(server, "sample_cpu", { app_id: "com.x.app" });
    expect(seen).toEqual([30, 1, 3]);
  });

  it("says the platform is unsupported when the driver cannot sample", async () => {
    const server = makeServer();
    registerPerfTools(server, { drivers: [driverWith({})] });
    const res = await callTool(server, "sample_cpu", { app_id: "com.x.app" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not supported on ios/);
  });

  it("asks for an app id when nothing is connected to name one", async () => {
    const server = makeServer();
    registerPerfTools(server, { drivers: [driverWith({ cpuSample: async () => SAMPLE })] });
    const res = await callTool(server, "sample_cpu", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/pass app_id/);
  });

  it("takes the app id from the connected target", async () => {
    await connect("com.connected.app");
    let asked = "";
    const server = makeServer();
    registerPerfTools(server, {
      drivers: [
        driverWith({
          cpuSample: async (_u: string, a: string) => {
            asked = a;
            return SAMPLE;
          },
        }),
      ],
    });
    await callTool(server, "sample_cpu", {});
    expect(asked).toBe("com.connected.app");
  });

  it("shows the raw output rather than an empty table it cannot back up", async () => {
    const server = makeServer();
    registerPerfTools(server, {
      drivers: [
        driverWith({
          cpuSample: async () => ({ pid: 9, durationS: 3, threads: [], unparsed: "sample: could not attach" }),
        }),
      ],
    });
    const res = await callTool(server, "sample_cpu", { app_id: "com.x.app" });
    expect(res.content[0].text).toContain("could not attach");
    expect(res.content[0].text).toMatch(/could not parse/i);
  });

  it("prints the Android caveat when the driver reports one", async () => {
    const androidSample: CpuSample = {
      pid: 7,
      durationS: 2,
      note: "Android reports per-thread %CPU only — no native stack frames.",
      threads: [
        { id: "7", name: "ndroid.x.app", role: "main", share: 0.6, cpuPercent: 60 },
        { id: "8", name: "mqt_js", role: "js", share: 0.4, cpuPercent: 40 },
      ],
    };
    const server = makeServer();
    registerPerfTools(server, {
      drivers: [driverWith({ platform: "android", cpuSample: async () => androidSample } as any)],
    });
    const out = (await callTool(server, "sample_cpu", { app_id: "com.x.app" })).content[0].text as string;
    expect(out).toContain("no native stack frames");
    expect(out).toContain("%cpu");
    // No sample counts on Android, so the header must not invent any.
    expect(out).not.toMatch(/\bsamples\b/);
  });
});

const FRAME_STATS: FrameStats = {
  durationMs: 2000,
  frameDurationsMs: [10, 12, 14, 40],
  totalRendered: 4,
  jankyFrames: 1,
  jankyPct: 25,
};

const RAF_OK = { frames: 118, elapsedMs: 2003, maxGapMs: 41, slowGaps: 2 };

describe("get_fps", () => {
  it("reports UI-thread frames and the rAF proxy from one window", async () => {
    await connect("com.x.app", (expr) =>
      expr.includes("requestAnimationFrame") ? JSON.stringify({ s: "ok", v: RAF_OK }) : undefined,
    );
    const server = makeServer();
    registerPerfTools(server, {
      drivers: [driverWith({ platform: "android", frameStats: async () => FRAME_STATS } as any)],
    });
    const out = (await callTool(server, "get_fps", {})).content[0].text as string;
    expect(out).toContain("UI-thread frames (dumpsys gfxinfo)");
    expect(out).toContain("4 frames in 2000ms");
    expect(out).toContain("janky 1 (25.0%)");
    expect(out).toContain("p90 40.0ms");
    expect(out).toContain("JS-thread FPS (rAF)");
    expect(out).toContain("118 callbacks in 2003ms");
    // A still screen producing few frames is not a low frame rate; say so.
    expect(out).toMatch(/idle screen/i);
  });

  it("states plainly that the iOS simulator has no UI-thread frames", async () => {
    await connect("com.x.app", (expr) =>
      expr.includes("requestAnimationFrame") ? JSON.stringify({ s: "ok", v: RAF_OK }) : undefined,
    );
    const server = makeServer();
    registerPerfTools(server, { drivers: [driverWith({})] });
    const out = (await callTool(server, "get_fps", {})).content[0].text as string;
    expect(out).toMatch(/not available on the iOS simulator/);
    expect(out).toContain("xctrace");
    expect(out).toContain("JS-thread FPS (rAF)");
    expect(out).toContain("58.9 fps");
  });

  it("clamps the window", async () => {
    const seen: number[] = [];
    await connect("com.x.app", (expr) =>
      expr.includes("requestAnimationFrame") ? JSON.stringify({ s: "ok", v: RAF_OK }) : undefined,
    );
    const server = makeServer();
    registerPerfTools(server, {
      drivers: [
        driverWith({
          platform: "android",
          frameStats: async (_u: string, _a: string, d: number) => {
            seen.push(d);
            return { ...FRAME_STATS, durationMs: d };
          },
        } as any),
      ],
    });
    await callTool(server, "get_fps", { duration_ms: 99999 });
    await callTool(server, "get_fps", {});
    expect(seen).toEqual([15000, 2000]);
  });

  it("still reports the native block when the runtime has no rAF", async () => {
    await connect("com.x.app", (expr) =>
      expr.includes("requestAnimationFrame")
        ? JSON.stringify({ s: "ok", v: { error: "this runtime has no requestAnimationFrame" } })
        : undefined,
    );
    const server = makeServer();
    registerPerfTools(server, {
      drivers: [driverWith({ platform: "android", frameStats: async () => FRAME_STATS } as any)],
    });
    const out = (await callTool(server, "get_fps", {})).content[0].text as string;
    expect(out).toContain("4 frames in 2000ms");
    expect(out).toContain("unavailable: this runtime has no requestAnimationFrame");
  });

  it("says so when there is no runtime to ask", async () => {
    const server = makeServer();
    registerPerfTools(server, {
      drivers: [driverWith({ platform: "android", frameStats: async () => FRAME_STATS } as any)],
    });
    const out = (await callTool(server, "get_fps", { app_id: "com.x.app" })).content[0].text as string;
    expect(out).toMatch(/unavailable: no app runtime is connected/);
    expect(out).toContain("4 frames in 2000ms");
  });

  it("explains an empty gfxinfo dump instead of reporting 0 fps", async () => {
    const server = makeServer();
    registerPerfTools(server, {
      drivers: [
        driverWith({
          platform: "android",
          frameStats: async () => ({
            durationMs: 2000,
            frameDurationsMs: [],
            unparsed: "No process found for: com.x.app",
          }),
        } as any),
      ],
    });
    const out = (await callTool(server, "get_fps", { app_id: "com.x.app" })).content[0].text as string;
    expect(out).toContain("No process found");
    expect(out).not.toContain("0.0 frames/s");
  });
});

describe("rafSnippet", () => {
  it("is ES5 and self-contained — Hermes evaluates it with no async/await", () => {
    const code = rafSnippet(1234);
    expect(code).toContain("1234");
    expect(code).not.toMatch(/\b(async|await|=>|let |const )/);
    // Read off globalThis, so a runtime without them returns an error rather
    // than throwing a ReferenceError the caller sees as a lost connection.
    expect(code).toContain("globalThis.requestAnimationFrame");
    expect(code).toContain("globalThis.Promise");
  });
});
