import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { run } from "../../src/core/exec.js";
import { androidArtifact, type AndroidArtifact } from "../../src/native/artifacts.js";
import { startAndroidServer, type AndroidServerHandle } from "../../src/native/androidServer.js";
import { AndroidServerBackend } from "../../src/native/androidBackend.js";
import { RNE_IME } from "../../src/native/androidIme.js";
import { probeStatus } from "../../src/native/iosRunner.js";
import { NativePool } from "../../src/native/pool.js";
import { AndroidDriver } from "../../src/drivers/android.js";
import { parseUiautomator } from "../../src/layout/parseUiautomator.js";

/**
 * The Android server against a real device. Gated:
 *   RNE_INTEGRATION_ANDROID_SERIAL=emulator-5554 npm run test:integration
 * Use the rne_test AVD — this file uninstalls dev.rneye.server{,.test} and
 * force-stops apps. Needs build/drivers from scripts/build-drivers.sh android.
 */
const serial = process.env.RNE_INTEGRATION_ANDROID_SERIAL;
const APP = "com.example.demo.dev";

async function adb(args: string[], timeoutMs = 60_000) {
  return (await run("adb", ["-s", serial!, ...args], { timeoutMs })).stdout;
}

async function until<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

function pngSize(buf: Buffer): { w: number; h: number } {
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

const versionName = async (pkg: string) => /versionName=(\S+)/.exec(await adb(["shell", "dumpsys", "package", pkg]))?.[1];
const currentIme = async () => (await adb(["shell", "settings", "get", "secure", "default_input_method"])).trim();

describe.skipIf(!serial)("Android server on a real device", () => {
  const S = serial!;
  let art: AndroidArtifact;
  let first: AndroidServerHandle;
  let backend: AndroidServerBackend;
  const pools: NativePool[] = [];

  async function xml(): Promise<string> {
    return ((await backend.hierarchy()) as { hierarchy: string }).hierarchy;
  }
  async function probeCenter(testID: string): Promise<{ x: number; y: number }> {
    const el = parseUiautomator(await xml()).find((e) => e.testID === testID);
    expect(el, `${testID} not on screen`).toBeDefined();
    return { x: Math.round(el!.x + el!.w / 2), y: Math.round(el!.y + el!.h / 2) };
  }
  async function probeText(testID: string): Promise<string | undefined> {
    return parseUiautomator(await xml()).find((e) => e.testID === testID)?.text;
  }

  beforeAll(async () => {
    expect((await adb(["shell", "getprop", "sys.boot_completed"])).trim(), `${S} has not finished booting`).toBe("1");
    const a = androidArtifact();
    expect(a, "build/drivers has no android section — run scripts/build-drivers.sh android").toBeDefined();
    art = a!;
  });

  afterAll(async () => {
    for (const p of pools) await p.shutdown().catch(() => {});
  });

  it("cold start: installs both APKs (versionName = driver version) and answers /status", async () => {
    await adb(["uninstall", art.testPackage]).catch(() => "");
    await adb(["uninstall", art.appPackage]).catch(() => "");
    const t0 = Date.now();
    first = await startAndroidServer(S);
    console.log(`[android] cold start with install: ${Date.now() - t0} ms, port ${first.port}`);
    expect(first.via).toBe("instrument");
    expect(await versionName(art.appPackage)).toBe(art.version);
    expect(await versionName(art.testPackage)).toBe(art.version);
    expect(await probeStatus(first.port)).toBe(art.version);
    backend = new AndroidServerBackend(first.port, S);
  });

  it("reattaches to the running server through its adb forward", async () => {
    const t0 = Date.now();
    const again = await startAndroidServer(S);
    expect(again.via).toBe("reused");
    expect(again.port).toBe(first.port);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(again.socket).toBe(first.socket);
    expect(first.socket).toMatch(/^rneye-[0-9a-f]{16}$/);
    const forwards = (await run("adb", ["forward", "--list"])).stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith(`${S} `) && l.includes(" localabstract:rneye-"));
    expect(forwards).toEqual([`${S} tcp:${first.port} localabstract:${first.socket}`]);
  });

  it("drives every route on the probe activity", async () => {
    await adb(["shell", "am", "start", "-W", "-n", "dev.rneye.server/.ProbeActivity"]);
    const button = await until("probe_button", async () => ((await xml()).includes("probe_button") ? true : undefined));
    expect(button).toBe(true);
    const c = await probeCenter("probe_button");
    await backend.touch(c.x, c.y);
    expect(await until("tapped 1", async () => ((await probeText("probe_button")) === "tapped 1" ? true : undefined), 5000)).toBe(true);
    await backend.touch(c.x, c.y, 800);
    expect(await until("long-pressed", async () => ((await probeText("probe_button")) === "long-pressed" ? true : undefined), 5000)).toBe(true);

    const input = await probeCenter("probe_input");
    await backend.touch(input.x, input.y);
    await backend.inputText("Hello 42!");
    expect(await until("typed", async () => ((await probeText("probe_input")) === "Hello 42!" ? true : undefined), 5000)).toBe(true);
    await backend.eraseText(3);
    expect(await until("erased", async () => ((await probeText("probe_input")) === "Hello " ? true : undefined), 5000)).toBe(true);

    const size = /(\d+)x(\d+)/.exec(await adb(["shell", "wm", "size"]))!;
    expect(await backend.deviceInfo()).toEqual({ widthPixels: Number(size[1]), heightPixels: Number(size[2]) });
    expect(typeof (await backend.isScreenStatic())).toBe("boolean");
    await backend.swipe(700, 2400, 700, 900, 300);
    await backend.pressKey("back");
  });

  it("types non-ASCII text and emoji through the IME and gives the keyboard back", async () => {
    await adb(["shell", "am", "start", "-W", "-n", "dev.rneye.server/.ProbeActivity"]);
    const before = await currentIme();
    expect(before).not.toBe(RNE_IME);
    const input = await probeCenter("probe_input");
    await backend.touch(input.x, input.y);
    const existing = (await probeText("probe_input")) ?? "";
    if (existing && existing !== "rne probe input") await backend.eraseText([...existing].length);
    await backend.inputText("こんにちは, 世界 👋");
    expect(await until("unicode", async () => ((await probeText("probe_input"))?.includes("こんにちは, 世界 👋") ? true : undefined), 5000)).toBe(true);
    expect(await currentIme()).toBe(before);
  });

  it("screenshot has the device's pixel size", async () => {
    const shot = pngSize(await backend.screenshot());
    const { stdoutBuffer } = await run("adb", ["-s", S, "exec-out", "screencap", "-p"], { timeoutMs: 30_000 });
    expect(shot).toEqual(pngSize(stdoutBuffer));
  });

  it("reinstalls a missing test APK and starts again", async () => {
    await adb(["uninstall", art.testPackage]);
    // Measured on API 36: the instrumentation runs in dev.rneye.server's
    // process, so uninstalling the test APK does not kill it — the server keeps
    // answering /status and a start right now would (correctly) reuse it. Stop
    // it so the start has to reinstall.
    console.log(`[android] /status right after uninstalling the test APK: ${(await probeStatus(first.port)) ?? "no answer"}`);
    await adb(["shell", "am", "force-stop", art.appPackage]);
    const h = await startAndroidServer(S);
    expect(h.via).toBe("instrument");
    expect(await versionName(art.testPackage)).toBe(art.version);
    first = h;
    backend = new AndroidServerBackend(h.port, S);
  });

  it("a server killed mid-session: the next gesture falls back to adb, the pool re-warms, the one after uses the server", async () => {
    const pool = new NativePool();
    pools.push(pool);
    expect((await pool.warm("android", S)).state).toBe("ready");
    const driver = new AndroidDriver(undefined, undefined, undefined, pool);
    expect(await driver.tapXY(S, 50, 1500)).toEqual({ path: "runner" });
    await adb(["shell", "am", "force-stop", art.appPackage]);
    const os = await driver.tapXY(S, 50, 1500);
    console.log(`[android] tap after force-stop → ${JSON.stringify(os)}`);
    expect(os.path).toBe("adb");
    expect(os.reason).toMatch(/^runner dead: .*(nothing answers behind the adb forward|ECONNREFUSED)/);
    await until("re-warm", async () => (pool.view("android", S)?.state === "ready" ? true : undefined), 30_000);
    expect(await driver.tapXY(S, 50, 1500)).toEqual({ path: "runner" });
  });

  it("survives app switches and a force-stop of the app under test", async () => {
    const pool = new NativePool();
    pools.push(pool);
    await pool.warm("android", S);
    const driver = new AndroidDriver(undefined, undefined, undefined, pool);
    const port = (await startAndroidServer(S)).port;
    await driver.launchApp(S, APP, { terminateRunning: true });
    await new Promise((r) => setTimeout(r, 3000));
    await driver.pressKey(S, "home");
    await adb(["shell", "am", "start", "-W", "-n", "dev.rneye.server/.ProbeActivity"]);
    await driver.launchApp(S, APP, { terminateRunning: true });
    expect(await probeStatus(port)).toBe(art.version);
    expect((await driver.rawLayout(S)).os).toEqual({ path: "runner" });
  });

  it("session shutdown leaves the ready server running for the next session", async () => {
    const pool = new NativePool();
    await pool.warm("android", S);
    const port = (await startAndroidServer(S)).port;
    await pool.shutdown();
    expect(await probeStatus(port)).toBe(art.version);
  });

  it("records what `uiautomator dump` does while the server holds UiAutomation, and that we recover", async () => {
    const port = (await startAndroidServer(S)).port;
    const dump = await run("adb", ["-s", S, "exec-out", "uiautomator", "dump", "/dev/tty"], { timeoutMs: 45_000 }).then(
      (r) => r.stdout.slice(0, 200),
      (e: Error) => `threw: ${e.message.slice(0, 200)}`,
    );
    const alive = await probeStatus(port);
    console.log(`[android] uiautomator dump while server live → ${JSON.stringify(dump)}; /status after: ${alive ?? "no answer"}`);
    if (alive === art.version) {
      // The server survived, so the dump must have failed in the shape the
      // driver recognises (android.ts UIAUTOMATION_HELD_RE): `Killed` (T9,
      // API 36) or "already registered" (T1). rawLayout never falls back to
      // the dump while the server answers, and names this failure when it does.
      expect(dump).toMatch(/Killed\b|already registered/);
      expect(dump).not.toMatch(/<hierarchy|<node\b/);
    } else {
      const h = await startAndroidServer(S);
      expect(await probeStatus(h.port)).toBe(art.version);
    }
  });

  it("I3: RNE_NATIVE_DRIVER=off releases a server an earlier session left, so uiautomator dump works again", async () => {
    const h = await startAndroidServer(S);
    expect(await probeStatus(h.port)).toBe(art.version);
    const pool = new NativePool({ env: { RNE_NATIVE_DRIVER: "off" } });
    pools.push(pool);
    expect(await pool.warm("android", S)).toEqual({ state: "failed", reason: "disabled (RNE_NATIVE_DRIVER=off)" });
    expect(await probeStatus(h.port)).toBeUndefined();
    const forwards = (await run("adb", ["forward", "--list"])).stdout;
    expect(forwards).not.toContain(`localabstract:${h.socket}`);
    // An idle native screen, so the dump does not trip over a busy RN app (D19).
    // Opened only now: the release force-stops our package, probe included.
    await adb(["shell", "am", "start", "-W", "-n", "dev.rneye.server/.ProbeActivity"]);
    const dump = await run("adb", ["-s", S, "exec-out", "uiautomator", "dump", "/dev/tty"], { timeoutMs: 45_000 });
    expect(dump.stdout).toMatch(/<hierarchy/);
  });
});
