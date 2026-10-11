import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/core/exec.js";
import { iosArtifact, driversRoot } from "../../src/native/artifacts.js";
import { startIosRunner, type RunnerHandle } from "../../src/native/iosRunner.js";
import { IosRunnerBackend } from "../../src/native/iosBackend.js";
import { NativePool } from "../../src/native/pool.js";
import { IosDriver } from "../../src/drivers/ios.js";
import { parseXcRunner } from "../../src/layout/parseXcRunner.js";
import { parseAppPid } from "../../src/perf/parseSample.js";

/**
 * The runner against a real booted simulator. Gated like gate.test.ts:
 *   RNE_INTEGRATION_UDID=<udid> npm run test:integration
 * Needs build/drivers from scripts/build-drivers.sh. Tests run in file order
 * and build on each other (cold start → reuse → routes → reinstall → kill).
 */
const udid = process.env.RNE_INTEGRATION_UDID;
const BUNDLE = "dev.rneye.runnerUITests.xctrunner";
const SETTINGS = "com.apple.Preferences";

async function sh(cmd: string, args: string[], timeoutMs = 60_000) {
  return run(cmd, args, { timeoutMs });
}

async function until<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 60_000): Promise<T> {
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

describe.skipIf(!udid)("iOS native runner on a real simulator", () => {
  const U = udid!;
  let first: RunnerHandle;
  let tmp: string | undefined;
  const pools: NativePool[] = [];

  async function installedVersion(): Promise<string | undefined> {
    try {
      const { stdout: container } = await sh("xcrun", ["simctl", "get_app_container", U, BUNDLE]);
      const { stdout } = await sh("plutil", ["-extract", "RNEDriverVersion", "raw", join(container.trim(), "Info.plist")]);
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  async function runnerPid(): Promise<number | undefined> {
    const { stdout } = await sh("xcrun", ["simctl", "spawn", U, "launchctl", "list"]);
    return parseAppPid(stdout, BUNDLE);
  }

  async function killRunner(): Promise<void> {
    await sh("xcrun", ["simctl", "terminate", U, BUNDLE]).catch(() => {});
    await until("the runner process to exit", async () => ((await runnerPid()) === undefined ? true : undefined), 20_000);
  }

  beforeAll(async () => {
    if (!iosArtifact()) throw new Error("build/drivers is missing or incomplete — run scripts/build-drivers.sh first.");
    await sh("xcrun", ["simctl", "launch", U, SETTINGS]);
  });

  afterAll(async () => {
    for (const p of pools) await p.shutdown();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("cold-starts through simctl install + launch", async () => {
    await sh("xcrun", ["simctl", "uninstall", U, BUNDLE]).catch(() => {});
    const t0 = Date.now();
    first = await startIosRunner(U);
    const ms = Date.now() - t0;
    console.log(`[integration] cold start with install: ${ms} ms via ${first.via}, port ${first.port}`);
    expect(first.via).toBe("simctl");
    expect(await installedVersion()).toBe(iosArtifact()!.version);
    expect((await new IosRunnerBackend(first.port).status()).version).toBe(iosArtifact()!.version);
  });

  it("reattaches to the live runner instead of starting another", async () => {
    const t0 = Date.now();
    const again = await startIosRunner(U);
    console.log(`[integration] reattach: ${Date.now() - t0} ms`);
    expect(again.via).toBe("reused");
    expect(again.port).toBe(first.port);
  });

  it("answers every route", async () => {
    const b = new IosRunnerBackend(first.port);
    expect(await b.status()).toMatchObject({ status: "ok", version: iosArtifact()!.version });
    const info = await b.deviceInfo();
    expect(info.widthPixels).toBeGreaterThan(0);
    expect(info.heightPixels).toBeGreaterThan(0);
    const els = parseXcRunner(await b.hierarchy());
    expect(els.length).toBeGreaterThan(0);
    expect(typeof (await b.isScreenStatic())).toBe("boolean");
    pngSize(await b.screenshot());
    const w = info.widthPoints ?? 402;
    const h = info.heightPoints ?? 874;
    // Settings: a status-bar tap scrolls to top, a short drag scrolls the list — both harmless.
    await b.touch(Math.round(w / 2), 5);
    await b.touch(Math.round(w / 2), 5, 300);
    await b.swipe(Math.round(w / 2), Math.round(h * 0.6), Math.round(w / 2), Math.round(h * 0.5), 300);
    // Typing needs a focused field. Same as T1's smoke script: from the home
    // screen, a downward swipe in the middle opens Spotlight with its search
    // field focused and the keyboard up.
    await b.pressButton("home");
    await new Promise((r) => setTimeout(r, 1000));
    await b.swipe(Math.round(w / 2), Math.round((h * 35) / 100), Math.round(w / 2), Math.round((h * 65) / 100), 300);
    await new Promise((r) => setTimeout(r, 1500));
    await b.inputText("a");
    await new Promise((r) => setTimeout(r, 500));
    // Check the raw tree like the smoke script does: RawElement.text prefers
    // the label, so the typed value is only visible on the XCUIElement node.
    const values: unknown[] = [];
    (function walk(e: any) {
      if (!e) return;
      values.push(e.value);
      (e.children ?? []).forEach(walk);
    })(((await b.hierarchy()) as any).axElement);
    expect(values).toContain("a");
    await b.eraseText(1);
    await b.pressKey("return");
    await b.pressButton("home");
    await sh("xcrun", ["simctl", "launch", U, SETTINGS]);
  });

  it("shoots screenshots at the same pixel size as simctl", async () => {
    const runnerShot = pngSize(await new IosRunnerBackend(first.port).screenshot());
    const { stdoutBuffer } = await sh("xcrun", ["simctl", "io", U, "screenshot", "--type=png", "-"], 30_000);
    expect(runnerShot).toEqual(pngSize(stdoutBuffer));
  });

  it("reinstalls when the installed version differs, and back", async () => {
    const root = driversRoot()!;
    const art = iosArtifact()!;
    tmp = mkdtempSync(join(tmpdir(), "rne-drivers-"));
    cpSync(root, tmp, { recursive: true });
    const changed = `${art.version}-inttest`;
    const app = join(tmp, "ios", "RNERunnerUITests-Runner.app");
    await sh("plutil", ["-replace", "RNEDriverVersion", "-string", changed, join(app, "Info.plist")]);
    // Editing Info.plist breaks the bundle's seal; re-sign ad hoc with the
    // exact flags T1's build script uses (scripts/build-drivers.sh).
    await sh(
      "codesign",
      ["--force", "--sign", "-", "--timestamp=none", "--preserve-metadata=identifier,entitlements,flags", app],
      120_000,
    );
    await sh("codesign", ["--verify", "--deep", "--strict", app], 60_000);
    const manifestPath = join(tmp, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: changed }, null, 2));

    const bumped = await startIosRunner(U, { artifact: () => iosArtifact({ root: tmp }) });
    expect(bumped.via).toBe("simctl");
    expect(await installedVersion()).toBe(changed);
    expect((await new IosRunnerBackend(bumped.port).status()).version).toBe(changed);

    first = await startIosRunner(U);
    expect(first.via).toBe("simctl");
    expect(await installedVersion()).toBe(art.version);
  });

  it("falls back when the runner is killed mid-session, then re-warms", async () => {
    const pool = new NativePool();
    pools.push(pool);
    expect((await pool.warm("ios", U)).state).toBe("ready");
    const driver = new IosDriver(undefined, undefined, undefined, pool);
    await sh("xcrun", ["simctl", "launch", U, SETTINGS]);
    expect((await driver.rawLayout(U)).os).toEqual({ path: "runner" });

    // A read after the kill: refused → dead → axe, and the pool starts over.
    await killRunner();
    const read = await driver.rawLayout(U);
    expect(read.os.path).toBe("axe");
    expect(read.os.reason).toMatch(/^runner dead: /);
    expect(read.els.length).toBeGreaterThan(0);
    await until("the pool to re-warm", async () => (pool.view("ios", U)?.state === "ready" ? true : undefined), 45_000);
    expect((await driver.rawLayout(U)).os).toEqual({ path: "runner" });

    // A gesture after the kill: nothing was delivered, so axe may run it.
    // Fresh pool + driver: a second death on `pool` within 60 s of the first
    // would trip T7's flap rule (RF-2) and leave that entry `failed`, not
    // re-warming — correct behaviour, but not what this half checks.
    const pool2 = new NativePool();
    pools.push(pool2);
    expect((await pool2.warm("ios", U)).state).toBe("ready");
    const driver2 = new IosDriver(undefined, undefined, undefined, pool2);
    await killRunner();
    const size = (await driver2.screenSize(U)) ?? { w: 402, h: 874 };
    const tap = await driver2.tapXY(U, Math.round(size.w / 2), 5);
    expect(tap.path).toBe("axe");
    expect(tap.reason).toMatch(/^runner dead: /);
    await until("the pool to re-warm again", async () => (pool2.view("ios", U)?.state === "ready" ? true : undefined), 45_000);
    expect(await driver2.tapXY(U, Math.round(size.w / 2), 5)).toEqual({ path: "runner" });
  });
});
