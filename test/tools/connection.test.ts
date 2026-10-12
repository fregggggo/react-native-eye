import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { registerConnectionTools, nativeAdvice, type ConnectionToolOpts } from "../../src/tools/connection.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, type FakeMetro } from "../helpers/fakeCdp.js";
import type { PoolEntryView } from "../../src/native/pool.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

async function demoMetro(target: Record<string, unknown> = { id: "t", title: "Demo" }) {
  metro = await startFakeMetro({ port: 0, targets: [target as any] });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", () => ({ result: { value: undefined } }));
}

function iosDriver(...devices: [udid: string, name: string][]) {
  return {
    platform: "ios",
    listDevices: async () => devices.map(([udid, name]) => ({ platform: "ios", udid, name, booted: true })),
  } as any;
}

function androidDriver(...devices: [serial: string, name: string][]) {
  return {
    platform: "android",
    listDevices: async () => devices.map(([udid, name]) => ({ platform: "android", udid, name, booted: true })),
  } as any;
}

// Mirrors T7: warm() flips the entry to "starting" synchronously, except a
// dead entry, which stays dead (with its reason) while it re-warms.
function fakePool(opts: { before?: PoolEntryView; warm?: () => Promise<PoolEntryView> } = {}) {
  const warms: string[] = [];
  const foregrounds: (string | undefined)[] = [];
  let current = opts.before;
  const pool = {
    view: () => current,
    warm: (p: "ios" | "android", u: string, o?: { foreground?: string }) => {
      warms.push(`${p}:${u}`);
      foregrounds.push(o?.foreground);
      if (current?.state !== "dead") current = { state: "starting" };
      return opts.warm ? opts.warm() : new Promise<PoolEntryView>(() => {});
    },
  };
  return { pool, warms, foregrounds };
}

/** G14: the driver build's version per platform (the artifacts manifest in production). */
const IOS_V = "0.0.1-6ee5255e";
const ANDROID_V = "0.0.1-a1b2c3d4";
const driverVersion = (p: "ios" | "android") => (p === "ios" ? IOS_V : ANDROID_V);

async function connectWith(opts: ConnectionToolOpts, args: Record<string, unknown> = {}) {
  const server = makeServer();
  registerConnectionTools(server, { warmPeekMs: 20, driverVersion, ...opts });
  return callTool(server, "connect", { port: metro.port, ...args });
}

describe("connect / list_targets tools", () => {
  it("connect returns a summary line", async () => {
    await demoMetro();
    const { pool } = fakePool();
    const res = await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool });
    expect(res.content[0].text).toContain('Connected to "Demo"');
  });

  // Without ErrorUtils the app cannot hand over what LogBox swallows, so
  // get_errors is blind to redboxes — the agent has to be told, not guess.
  it("connect warns when the app exposes no error handler to hook", async () => {
    metro = await startFakeMetro({ port: 0, targets: [{ id: "t", title: "Demo" }] });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) =>
      String(p.expression).includes("__RNE_ERR_INSTALLED__")
        ? { result: { value: "unavailable" } }
        : { result: { value: undefined } },
    );
    const { pool } = fakePool();
    const res = await connectWith({ drivers: [], pool });
    expect(res.content[0].text).toMatch(/redbox/i);
  });

  it("connect returns an actionable error when nothing is on the port, and warms nothing", async () => {
    const { pool, warms } = fakePool();
    const server = makeServer();
    registerConnectionTools(server, { drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool });
    const res = await callTool(server, "connect", { port: 1 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no React Native target|connect/i);
    expect(warms).toEqual([]);
  });

  it("list_targets reports when none found", async () => {
    // Pin discovery to a dead port so a real Metro on 8081 cannot leak in.
    getRegistry().setDefaultPort(1);
    const server = makeServer();
    registerConnectionTools(server, { drivers: [], pool: fakePool().pool });
    const res = await callTool(server, "list_targets", {});
    expect(res.content[0].text).toMatch(/no metro/i);
  });

  it("list_targets lists every target on a port, not just the first", async () => {
    metro = await startFakeMetro({
      port: 0,
      targets: [
        { id: "page-1", title: "app (iPhone)", description: "React Native Bridgeless" },
        { id: "page-3", title: "app (iPhone)", description: "UI" },
      ],
    });
    getRegistry().setDefaultPort(metro.port);
    const server = makeServer();
    registerConnectionTools(server, { drivers: [], pool: fakePool().pool });
    const res = await callTool(server, "list_targets", {});
    expect(res.content[0].text).toContain("page-1");
    expect(res.content[0].text).toContain("page-3");
  });
});

describe("connect warms the native driver", () => {
  it("starts it in the background and says so", async () => {
    await demoMetro();
    const { pool, warms } = fakePool();
    const res = await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool });
    expect(warms).toEqual(["ios:SIM-1"]);
    expect(res.content[0].text).toMatch(/\nnative driver: starting in background \(0\.0\.1-6ee5255e\) — OS taps, swipes and layout wait for it \(up to 45 s\), then use axe\.$/);
  });

  it("tells the driver which app to keep in front: the target's appId", async () => {
    await demoMetro({ id: "t", title: "Demo", appId: "com.example.demo" });
    const { pool, foregrounds } = fakePool();
    await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool });
    expect(foregrounds).toEqual(["com.example.demo"]);
  });

  it("reports a live runner found at once as reused", async () => {
    await demoMetro();
    const { pool } = fakePool({ warm: async () => ({ state: "ready", via: "reused" }) });
    const res = await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool });
    expect(res.content[0].text).toMatch(/\nnative driver: ready \(reused, 0\.0\.1-6ee5255e\)$/);
  });

  it("android: reports a live server found at once as reused and warms android:<serial>", async () => {
    await demoMetro();
    const { pool, warms } = fakePool({ warm: async () => ({ state: "ready", via: "reused" }) });
    const res = await connectWith({ drivers: [androidDriver(["emulator-5554", "sdk_gphone64_arm64"])], pool });
    expect(warms).toEqual(["android:emulator-5554"]);
    expect(res.content[0].text).toMatch(/\nnative driver: ready \(reused, 0\.0\.1-a1b2c3d4\)$/);
  });

  it("android: a server still starting names adb as the fallback", async () => {
    await demoMetro();
    const { pool } = fakePool();
    const res = await connectWith({ drivers: [androidDriver(["emulator-5554", "sdk_gphone64_arm64"])], pool });
    expect(res.content[0].text).toMatch(/\nnative driver: starting in background \(0\.0\.1-a1b2c3d4\) — until it is ready, taps, swipes and layout use adb\.$/);
  });

  it("reports an entry that is already ready without starting anything", async () => {
    await demoMetro();
    const { pool, warms } = fakePool({ before: { state: "ready", via: "simctl", startedMs: 5800 } });
    const res = await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool });
    expect(warms).toEqual([]);
    expect(res.content[0].text).toMatch(/\nnative driver: ready \(reused, 0\.0\.1-6ee5255e\)$/);
  });

  it("names the reason and the next step when the kill switch is on", async () => {
    await demoMetro();
    const { pool } = fakePool({ warm: async () => ({ state: "failed", reason: "disabled (RNE_NATIVE_DRIVER=off)" }) });
    const res = await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool });
    expect(res.content[0].text).toMatch(
      /\nnative driver: unavailable — disabled \(RNE_NATIVE_DRIVER=off\)\. Unset RNE_NATIVE_DRIVER to turn it back on\.$/,
    );
  });

  it("does not repeat advice the runner's own failure already gives", async () => {
    await demoMetro();
    const reason =
      "iOS runner not built — build/drivers/manifest.json or the runner app it names is missing. " +
      "Run scripts/build-drivers.sh (needs Xcode), then reconnect; until then input goes through axe.";
    const { pool } = fakePool({ warm: async () => ({ state: "failed", reason }) });
    const res = await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool });
    expect(res.content[0].text.endsWith(`\nnative driver: unavailable — ${reason}`)).toBe(true);
  });

  it("says restarting while the pool re-warms a dead runner", async () => {
    await demoMetro();
    const { pool } = fakePool({ before: { state: "dead", reason: "socket hang up" } });
    const res = await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool });
    expect(res.content[0].text).toMatch(/\nnative driver: restarting in background \(0\.0\.1-6ee5255e\) — /);
  });

  it("G14: a fresh start that is ready within the peek names the version too", async () => {
    await demoMetro();
    const { pool } = fakePool({ warm: async () => ({ state: "ready", via: "instrument" }) });
    const res = await connectWith({ drivers: [androidDriver(["emulator-5554", "sdk_gphone64_arm64"])], pool });
    expect(res.content[0].text).toMatch(/\nnative driver: ready \(0\.0\.1-a1b2c3d4\)$/);
  });

  it("G14: without a known version the lines read as before", async () => {
    await demoMetro();
    const ready = fakePool({ warm: async () => ({ state: "ready", via: "reused" }) });
    const r1 = await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool: ready.pool, driverVersion: () => undefined });
    expect(r1.content[0].text).toMatch(/\nnative driver: ready \(reused\)$/);
    getRegistry().reset();
    const starting = fakePool();
    const r2 = await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool: starting.pool, driverVersion: () => undefined });
    expect(r2.content[0].text).toMatch(/\nnative driver: starting in background — OS taps, swipes and layout wait for it/);
  });

  it("reports a warm-up that throws as unavailable, and connect still succeeds", async () => {
    await demoMetro();
    const { pool } = fakePool({ warm: async () => Promise.reject(new Error("boom")) });
    const res = await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toMatch(/native driver: unavailable — boom\. /);
  });

  it("still connects when the device cannot be resolved, and says why nothing started", async () => {
    await demoMetro();
    const { pool, warms } = fakePool();
    const res = await connectWith({ drivers: [], pool });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('Connected to "Demo"');
    expect(res.content[0].text).toMatch(/\nnative driver: not started — No booted device found/);
    expect(warms).toEqual([]);
  });

  it("warms the device the debugged app runs on, not the first booted one", async () => {
    await demoMetro({ id: "t", title: "Demo", deviceName: "iPhone 16e" });
    const { pool, warms } = fakePool();
    await connectWith({ drivers: [iosDriver(["SIM-A", "iPhone 17 Pro"], ["SIM-B", "iPhone 16e"])], pool });
    expect(warms).toEqual(["ios:SIM-B"]);
  });

  it("does not wait for a slow start", async () => {
    await demoMetro();
    const { pool } = fakePool();
    const t0 = Date.now();
    await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool, warmPeekMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("D30: connect accepts an adb serial or a simulator UDID as device", () => {
  async function metroWith(...targets: Record<string, unknown>[]) {
    metro = await startFakeMetro({ port: 0, targets: targets as any });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({ result: { value: undefined } }));
  }

  it("android: the serial finds the target Metro names by model, and the warm-up uses that serial", async () => {
    await metroWith(
      { id: "ios", title: "Demo (iPhone 17 Pro)", deviceName: "iPhone 17 Pro" },
      { id: "and", title: "com.demo (sdk_gphone64_arm64)", deviceName: "sdk_gphone64_arm64 - 16 - API 36" },
    );
    const { pool, warms } = fakePool();
    const res = await connectWith(
      { drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"]), androidDriver(["emulator-5554", "sdk_gphone64_arm64"])], pool },
      { device: "emulator-5554" },
    );
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain("target and)");
    expect(warms).toEqual(["android:emulator-5554"]);
  });

  it("the serial is matched whatever its case, by Metro's normalised name (D20)", async () => {
    await metroWith({ id: "and", title: "com.demo", deviceName: "SDK gPhone64 arm64 - 16 - API 36" });
    const { pool, warms } = fakePool();
    const res = await connectWith({ drivers: [androidDriver(["emulator-5554", "sdk_gphone64_arm64"])], pool }, { device: "EMULATOR-5554" });
    expect(res.isError).toBeUndefined();
    expect(warms).toEqual(["android:emulator-5554"]);
  });

  it("ios: a UDID picks the simulator for the driver even when two booted simulators share the name, and says so", async () => {
    await metroWith({ id: "t", title: "Demo (iPhone 17 Pro)", deviceName: "iPhone 17 Pro" });
    const { pool, warms } = fakePool();
    const res = await connectWith(
      { drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"], ["SIM-2", "iPhone 17 Pro"])], pool },
      { device: "SIM-2" },
    );
    expect(res.isError).toBeUndefined();
    expect(warms).toEqual(["ios:SIM-2"]);
    expect(res.content[0].text).toMatch(/Note: 2 booted devices are named "iPhone 17 Pro" \(SIM-1, SIM-2\)/);
    expect(res.content[0].text).toMatch(/Metro tells targets apart by device name only/);
  });

  it("the picked id stays on the connection, so device tools keep using it", async () => {
    await metroWith({ id: "t", title: "Demo (iPhone 17 Pro)", deviceName: "iPhone 17 Pro" });
    await connectWith(
      { drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"], ["SIM-2", "iPhone 17 Pro"])], pool: fakePool().pool },
      { device: "SIM-2" },
    );
    expect(getRegistry().active().meta.deviceId).toBe("SIM-2");
  });

  it("a serial whose device runs no target on this Metro says which devices do", async () => {
    await metroWith({ id: "ios", title: "Demo", deviceName: "iPhone 17 Pro" });
    const { pool, warms } = fakePool();
    const res = await connectWith(
      { drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"]), androidDriver(["emulator-5554", "sdk_gphone64_arm64"])], pool },
      { device: "emulator-5554" },
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("android sdk_gphone64_arm64 (emulator-5554)");
    expect(res.content[0].text).toContain('"iPhone 17 Pro"');
    expect(warms).toEqual([]);
  });

  it("a device that is not booted is refused by name", async () => {
    await metroWith({ id: "ios", title: "Demo", deviceName: "iPhone 17 Pro" });
    const off = { platform: "ios", listDevices: async () => [{ platform: "ios", udid: "SIM-9", name: "iPhone 17 Pro", booted: false }] } as any;
    const res = await connectWith({ drivers: [off], pool: fakePool().pool }, { device: "SIM-9" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/ios iPhone 17 Pro \(SIM-9\) is not booted/);
  });

  it("a device name still works as before (substring of Metro's name)", async () => {
    await metroWith({ id: "and", title: "com.demo", deviceName: "sdk_gphone64_arm64 - 16 - API 36" });
    const { pool, warms } = fakePool();
    const res = await connectWith({ drivers: [androidDriver(["emulator-5554", "sdk_gphone64_arm64"])], pool }, { device: "sdk_gphone64" });
    expect(res.isError).toBeUndefined();
    expect(warms).toEqual(["android:emulator-5554"]);
  });

  it("a driver that cannot list devices does not break connect by name", async () => {
    await metroWith({ id: "t", title: "Demo", deviceName: "iPhone 17 Pro" });
    const broken = { platform: "android", listDevices: async () => Promise.reject(new Error("adb not found")) } as any;
    const { pool, warms } = fakePool();
    const res = await connectWith({ drivers: [broken, iosDriver(["SIM-1", "iPhone 17 Pro"])], pool }, { device: "iPhone 17" });
    expect(res.isError).toBeUndefined();
    expect(warms).toEqual(["ios:SIM-1"]);
  });
});

describe("D31: the flap text names this platform's fallback only", () => {
  it("android: adb, not axe", async () => {
    await demoMetro();
    const reason = "runner unstable — POST /viewHierarchy on 127.0.0.1:53600 lost: ECONNRESET (died twice within 60s)";
    const { pool } = fakePool({ warm: async () => ({ state: "failed", reason }) });
    const res = await connectWith({ drivers: [androidDriver(["emulator-5554", "sdk_gphone64_arm64"])], pool });
    expect(res.content[0].text).toContain("Taps, swipes and layout use adb meanwhile; the server retries by itself after 5 minutes.");
    expect(res.content[0].text).not.toMatch(/axe/);
  });

  it("ios: axe, not adb", async () => {
    await demoMetro();
    const { pool } = fakePool({ warm: async () => ({ state: "failed", reason: "runner unstable — x (died twice within 60s)" }) });
    const res = await connectWith({ drivers: [iosDriver(["SIM-1", "iPhone 17 Pro"])], pool });
    expect(res.content[0].text).toContain("Taps, swipes and layout use axe meanwhile; the runner retries by itself after 5 minutes.");
    expect(res.content[0].text).not.toMatch(/adb/);
  });
});

describe("nativeAdvice", () => {
  it("gives the next step for the reasons the pool reports, and none when the reason has one", () => {
    expect(nativeAdvice("disabled (RNE_NATIVE_DRIVER=off)")).toBe("Unset RNE_NATIVE_DRIVER to turn it back on.");
    expect(nativeAdvice("unsupported: something", "android")).toMatch(/Android/);
    expect(nativeAdvice("unsupported: something", "android")).not.toMatch(/Xcode|axe/);
    expect(nativeAdvice("Android server not built — … Run scripts/build-drivers.sh android (needs JDK 17+ and the Android SDK), then reconnect; until then input goes through adb.", "android")).toBe("");
    expect(nativeAdvice("Installing the RNEye Android server (dev.rneye.server) on S failed: X On a physical device allow installs over USB …; until then input goes through adb.", "android")).toBe("");
    expect(nativeAdvice("unsupported: XCPointerEventPath")).toMatch(/private API/);
    expect(nativeAdvice("… Run scripts/build-drivers.sh (needs Xcode), then reconnect; until then input goes through axe.")).toBe("");
    expect(
      nativeAdvice("iOS runner did not start on SIM-1: … Input falls back to axe and the runner is retried in 5 minutes; to see the runner's own output run `xcrun simctl spawn SIM-1 log show --last 2m --predicate 'process CONTAINS \"RNERunner\"'`, or set RNE_NATIVE_DRIVER=off to stay on axe."),
    ).toBe("");
    expect(nativeAdvice("something else")).toBe("Taps, swipes and layout use axe meanwhile; the runner retries by itself after 5 minutes.");
    expect(nativeAdvice("something else", "android")).toBe("Taps, swipes and layout use adb meanwhile; the server retries by itself after 5 minutes.");
  });
});
