// Acceptance measurements for the native drivers (Plan A T11, Plan B T10).
//
//   npx tsx scripts/measure-native-driver.ts ops  --udid <udid> [--platform ios|android] [--n 10] [--tap 201,437]
//   npx tsx scripts/measure-native-driver.ts cold --udid <udid> [--platform ios|android] [--uninstall]
//   npx tsx scripts/measure-native-driver.ts hot  --udid <udid> [--platform ios|android] [--n 40] [--path axe|adb|runner|both]
//   npx tsx scripts/measure-native-driver.ts tool --udid <udid> [--platform ios|android] --name <tool> [--args '<json>' | --args-file <path>] [--connect <metro port> [--connect-device <name>]]
//
// --platform defaults to ios. On Android --udid is the adb serial, and --tap is in
// pixels (tapXY's device unit; points on iOS).
//
// `tool` calls a registered MCP tool in-process, exactly as a client would; set
// RNE_NATIVE_DRIVER=off for the "before" (axe / adb) run.
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { run } from "../src/core/exec.js";
import { IosDriver } from "../src/drivers/ios.js";
import { AndroidDriver } from "../src/drivers/android.js";
import { NativePool, sharedPool } from "../src/native/pool.js";
import { startIosRunner } from "../src/native/iosRunner.js";
import { startAndroidServer } from "../src/native/androidServer.js";
import { androidArtifact } from "../src/native/artifacts.js";
import { buildServer } from "../src/server.js";
import type { OsPath } from "../src/drivers/types.js";

const RUNNER_BUNDLE = "dev.rneye.runnerUITests.xctrunner";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function need(name: string): string {
  const v = arg(name);
  if (!v) {
    console.error(`--${name} is required`);
    process.exit(2);
  }
  return v;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
}

function stats(ms: number[]): { n: number; median: number; p90: number; max: number } {
  const s = [...ms].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
  return { n: s.length, median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
}

const sec = (ms: number) => (ms / 1000).toFixed(2);
const load = () => `load average ${loadavg().map((l) => l.toFixed(2)).join(" ")}`;

type Platform = "ios" | "android";
const platform = (arg("platform") ?? "ios") as Platform;
if (platform !== "ios" && platform !== "android") {
  console.error("--platform must be ios or android");
  process.exit(2);
}
const FALLBACK: OsPath["path"] = platform === "ios" ? "axe" : "adb";
const DEFAULT_SIZE = platform === "ios" ? { w: 402, h: 874 } : { w: 1440, h: 3120 };

function makeDriver(pool: NativePool): IosDriver | AndroidDriver {
  return platform === "ios"
    ? new IosDriver(undefined, undefined, undefined, pool)
    : new AndroidDriver(undefined, undefined, undefined, pool);
}
const offPool = () => new NativePool({ env: { RNE_NATIVE_DRIVER: "off" } });

async function readyPool(udid: string): Promise<NativePool> {
  const pool = new NativePool();
  const v = await pool.warm(platform, udid);
  if (v.state !== "ready") throw new Error(`runner not ready: ${v.state} — ${v.reason ?? "no reason"}`);
  console.log(`runner ready via ${v.via}`);
  return pool;
}

async function ops(udid: string): Promise<void> {
  const n = Number(arg("n") ?? 10);
  const [tx, ty] = (arg("tap") ?? (platform === "ios" ? "201,437" : "720,1560")).split(",").map(Number);
  const pool = await readyPool(udid);
  const drivers: [OsPath["path"], IosDriver | AndroidDriver][] = [
    ["runner", makeDriver(pool)],
    [FALLBACK, makeDriver(offPool())],
  ];
  const size = (await drivers[0][1].screenSize(udid)) ?? DEFAULT_SIZE;
  const x = Math.round(size.w / 2);
  const rows: string[] = [];
  const failures: string[] = [];
  for (const [label, d] of drivers) {
    if (platform === "android" && label === FALLBACK) {
      // UiAutomation is single-tenant: while the server lives, `uiautomator dump`
      // is killed. The adb path only runs when the server is gone, so measure it that way.
      await run("adb", ["-s", udid, "shell", "am", "force-stop", "dev.rneye.server"], { timeoutMs: 20_000 }).catch(() => {});
    }
    console.log(`${label}: start, ${load()}`);
    const times: Record<string, number[]> = { tap: [], swipe: [], hierarchy: [] };
    const wrong: Record<string, string[]> = { tap: [], swipe: [], hierarchy: [] };
    const failed: Record<string, number> = { tap: 0, swipe: 0, hierarchy: 0 };
    // A failed call is a data point too (its duration counts), not a reason to abort.
    const measure = async (op: string, i: number, fn: () => Promise<OsPath>) => {
      const t0 = performance.now();
      try {
        const os = await fn();
        if (os.path !== label) wrong[op].push(`${os.path}${os.reason ? ` (${os.reason})` : ""}`);
      } catch (err) {
        failed[op]++;
        failures.push(`${label} ${op} #${i + 1} after ${sec(performance.now() - t0)} s: ${err instanceof Error ? err.message : String(err)}`);
      }
      times[op].push(performance.now() - t0);
    };
    for (let i = 0; i < n; i++) {
      await measure("tap", i, () => d.tapXY(udid, tx, ty));
      await measure("swipe", i, () => d.swipe(udid, x, Math.round(size.h * 0.7), x, Math.round(size.h * 0.3), 300));
      await measure("hierarchy", i, async () => (await d.rawLayout(udid)).os);
      process.stderr.write(".");
    }
    process.stderr.write("\n");
    console.log(`${label}: end, ${load()}`);
    for (const op of ["tap", "swipe", "hierarchy"]) {
      const st = stats(times[op]);
      const w = wrong[op].length ? `${wrong[op].length}: ${[...new Set(wrong[op])].join("; ")}` : "0";
      rows.push(`| ${op} | ${label} | ${st.n} | ${sec(st.median)} | ${sec(st.p90)} | ${sec(st.max)} | ${w} | ${failed[op]} |`);
    }
  }
  console.log("| Operation | Path | n | median, s | p90, s | max, s | calls on another path | failed |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(r);
  for (const f of failures) console.log(`  failed ${f}`);
  await pool.shutdown();
}

async function cold(udid: string): Promise<void> {
  const uninstall = process.argv.includes("--uninstall");
  if (platform === "android") {
    // force-stop kills the instrumentation; the stale forward is found dead and removed by findLiveAndroidServer.
    await run("adb", ["-s", udid, "shell", "am", "force-stop", "dev.rneye.server"], { timeoutMs: 20_000 }).catch(() => {});
    let installMs = 0;
    if (uninstall) {
      for (const p of ["dev.rneye.server.test", "dev.rneye.server"]) {
        await run("adb", ["-s", udid, "uninstall", p], { timeoutMs: 60_000 }).catch(() => {});
      }
      // Install here, the way startAndroidServer would (install -r -t, app then test APK),
      // so install and launch are timed separately; the start then finds both installed.
      const art = androidArtifact();
      if (!art) throw new Error("no android section in build/drivers/manifest.json");
      for (const apk of [art.appApk, art.testApk]) {
        const t = await timed(() => run("adb", ["-s", udid, "install", "-r", "-t", apk], { timeoutMs: 120_000 }));
        if (!/Success/.test(t.value.stdout)) throw new Error(`adb install ${apk}: ${t.value.stdout.trim()}`);
        console.log(`install ${apk.split("/").pop()}: ${sec(t.ms)} s`);
        installMs += t.ms;
      }
    }
    const t = await timed(() => startAndroidServer(udid));
    console.log(`cold start (launch only): ${sec(t.ms)} s via ${t.value.via}, port ${t.value.port}`);
    if (uninstall) console.log(`cold start with install: ${sec(installMs + t.ms)} s (install ${sec(installMs)} s + launch ${sec(t.ms)} s)`);
    const again = await timed(() => startAndroidServer(udid));
    console.log(`reattach: ${sec(again.ms)} s via ${again.value.via}`);
    return;
  }
  await run("xcrun", ["simctl", "terminate", udid, RUNNER_BUNDLE], { timeoutMs: 20_000 }).catch(() => {});
  if (uninstall) await run("xcrun", ["simctl", "uninstall", udid, RUNNER_BUNDLE], { timeoutMs: 60_000 }).catch(() => {});
  const t = await timed(() => startIosRunner(udid));
  console.log(`cold start${uninstall ? " (with install)" : ""}: ${sec(t.ms)} s via ${t.value.via}, port ${t.value.port}`);
}

async function hot(udid: string): Promise<void> {
  const n = Number(arg("n") ?? 40);
  const which = (arg("path") ?? "both").replace(/^(axe|adb)$/, "fallback"); // fallback | runner | both
  const size = (await makeDriver(offPool()).screenSize(udid)) ?? DEFAULT_SIZE;
  const plan: [string, IosDriver | AndroidDriver][] = [];
  if (which !== "runner") plan.push([FALLBACK, makeDriver(offPool())]);
  let pool: NativePool | undefined;
  if (which !== "fallback") {
    pool = await readyPool(udid);
    plan.push(["runner", makeDriver(pool)]);
  }
  for (const [label, d] of plan) {
    console.log(`${label}: start, ${load()}`);
    const ms: number[] = [];
    const failed: string[] = [];
    for (let i = 0; i < n; i++) {
      const up = i % 4 !== 3; // three forward, one back: stays on the feed
      const [y1, y2] = up ? [size.h * 0.7, size.h * 0.3] : [size.h * 0.3, size.h * 0.7];
      // A failed call (e.g. axe killed at its timeout) is itself a hot-state
      // data point: record its duration and keep going instead of aborting.
      const t0 = performance.now();
      try {
        await d.swipe(udid, size.w / 2, Math.round(y1), size.w / 2, Math.round(y2), 300);
      } catch (err) {
        failed.push(`#${i + 1} after ${sec(performance.now() - t0)} s: ${err instanceof Error ? err.message : String(err)}`);
      }
      ms.push(performance.now() - t0);
      process.stderr.write(".");
    }
    process.stderr.write("\n");
    const st = stats(ms);
    const slow = ms.filter((m) => m > 5000).length;
    console.log(`${label}: ${n} feed swipes, median ${sec(st.median)} s, p90 ${sec(st.p90)} s, max ${sec(st.max)} s, >5 s: ${slow}, failed: ${failed.length}`);
    console.log(`  per call, s: ${ms.map(sec).join(" ")}`);
    console.log(`  end, ${load()}`);
    for (const f of failed) console.log(`  failed ${f}`);
  }
  await pool?.shutdown();
}

const textOf = (r: any): string =>
  (r?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");

async function tool(udid: string): Promise<void> {
  const name = need("name");
  const file = arg("args-file");
  const args = JSON.parse(file ? readFileSync(file, "utf8") : (arg("args") ?? "{}"));
  if (process.env.RNE_NATIVE_DRIVER !== "off") {
    const v = await sharedPool().warm(platform, udid);
    console.log(`[warm] ${v.state}${v.via ? ` via ${v.via}` : ""}${v.reason ? ` — ${v.reason}` : ""}`);
  } else {
    console.log("[warm] skipped: RNE_NATIVE_DRIVER=off");
  }
  const server = buildServer();
  const call = (tool: string, a: unknown): Promise<any> => (server as any)._registeredTools[tool].handler(a, {});
  const port = arg("connect");
  // --connect-device picks the app when several share one Metro (matched like connect's `device`).
  const connectDevice = arg("connect-device");
  if (port) console.log(textOf(await call("connect", { port: Number(port), ...(connectDevice ? { device: connectDevice } : {}) })));
  const t = await timed(() => call(name, { device: udid, ...args }));
  console.log(`--- ${name} (${sec(t.ms)} s)${t.value?.isError ? " ERROR" : ""}`);
  console.log(textOf(t.value));
  await sharedPool().shutdown();
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const udid = need("udid");
  if (mode === "ops") return ops(udid);
  if (mode === "cold") return cold(udid);
  if (mode === "hot") return hot(udid);
  if (mode === "tool") return tool(udid);
  console.error("mode must be one of: ops, cold, hot, tool");
  process.exit(2);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
