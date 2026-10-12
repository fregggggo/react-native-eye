import { describe, it, expect, vi } from "vitest";
import { startIosRunner, findLiveIosRunner, type IosRunnerDeps, type RunnerHandle } from "../../src/native/iosRunner.js";
import type { IosArtifact } from "../../src/native/artifacts.js";
import { DriverError } from "../../src/core/errors.js";
import { TIMEOUTS, type LongRunningHandle } from "../../src/core/exec.js";

const UDID = "SIM-1";
const BUNDLE = "dev.rneye.runnerUITests.xctrunner";
const VERSION = "0.0.1-ab12cd34";
const ART: IosArtifact = {
  runnerApp: "/pkg/build/drivers/ios/RNERunnerUITests-Runner.app",
  hostApp: "/pkg/build/drivers/ios/RNERunner.app",
  xctestrun: "/pkg/build/drivers/ios/RNERunner.xctestrun",
  runnerBundleId: BUNDLE,
  version: VERSION,
};

// Verbatim shape of `xcrun simctl spawn <udid> launchctl list` (tab-separated).
const LAUNCHCTL_WITH_RUNNER = [
  "PID\tStatus\tLabel",
  "-\t0\tcom.apple.progressd",
  `812\t0\tUIKitApplication:${BUNDLE}[a1b2][rb-legacy]`,
].join("\n");
const LAUNCHCTL_WITHOUT_RUNNER = ["PID\tStatus\tLabel", "-\t0\tcom.apple.progressd"].join("\n");
const LSOF_812 = [
  "COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
  "RNERunner 812 george    9u  IPv4 0x1b2c3d4e5f6a7b8c      0t0  TCP 127.0.0.1:22087 (LISTEN)",
].join("\n");

type Call = { cmd: string; args: string[]; opts?: { timeoutMs?: number; env?: Record<string, string> } };
type Answer = { stdout?: string } | Error;

/** Matches like test/drivers/ios.test.ts: the first key contained in "cmd args". */
function fakeRun(answers: Record<string, Answer | (() => Answer)>) {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[], opts?: Call["opts"]) => {
    calls.push({ cmd, args, opts });
    const key = `${cmd} ${args.join(" ")}`;
    const match = Object.keys(answers).find((k) => key.includes(k));
    const raw = match ? answers[match] : {};
    const a = typeof raw === "function" ? raw() : raw;
    if (a instanceof Error) throw a;
    const stdout = a.stdout ?? "";
    return { stdout, stdoutBuffer: Buffer.from(stdout), stderr: "" };
  };
  return { run, calls };
}

function fakeHandle(opts: { stderr?: string; exited?: () => boolean } = {}): LongRunningHandle & { stop: ReturnType<typeof vi.fn> } {
  return {
    exited: opts.exited ?? (() => false),
    stderr: () => opts.stderr ?? "",
    assertAlive: async () => {},
    stop: vi.fn(async () => {}),
  };
}

/** Fake clock: sleep advances now, so a 30s poll takes no real time. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms), advance: (ms: number) => void (t += ms) };
}

function deps(over: Partial<IosRunnerDeps> & { run: IosRunnerDeps["run"] }): Partial<IosRunnerDeps> {
  const c = clock();
  const ports = [50123, 50124, 50125];
  return {
    artifact: () => ART,
    freePort: async () => ports.shift()!,
    probe: async () => undefined,
    spawn: vi.fn(() => fakeHandle()),
    sleep: c.sleep,
    now: c.now,
    ...over,
  };
}

const argv = (calls: Call[]) => calls.map((c) => [c.cmd, ...c.args]);

describe("findLiveIosRunner", () => {
  it("finds the runner pid in launchctl, its port in lsof, and accepts it when /status has our version", async () => {
    const { run, calls } = fakeRun({ "launchctl list": { stdout: LAUNCHCTL_WITH_RUNNER }, lsof: { stdout: LSOF_812 } });
    const probe = vi.fn(async (port: number) => (port === 22087 ? VERSION : undefined));
    const h = await findLiveIosRunner(UDID, BUNDLE, VERSION, deps({ run: run as any, probe }) as IosRunnerDeps);
    expect(h).toMatchObject({ port: 22087, pid: 812, via: "reused" });
    expect(argv(calls)).toEqual([
      ["xcrun", "simctl", "spawn", UDID, "launchctl", "list"],
      ["lsof", "-nP", "-a", "-p", "812", "-iTCP", "-sTCP:LISTEN"],
    ]);
    expect(probe).toHaveBeenCalledWith(22087);
  });

  it("returns undefined when the runner is not in launchctl, without calling lsof", async () => {
    const { run, calls } = fakeRun({ "launchctl list": { stdout: LAUNCHCTL_WITHOUT_RUNNER } });
    expect(await findLiveIosRunner(UDID, BUNDLE, VERSION, deps({ run: run as any }) as IosRunnerDeps)).toBeUndefined();
    expect(calls.some((c) => c.cmd === "lsof")).toBe(false);
  });

  it("returns undefined when lsof finds no listening socket (lsof exits 1)", async () => {
    const { run } = fakeRun({ "launchctl list": { stdout: LAUNCHCTL_WITH_RUNNER }, lsof: new DriverError("lsof failed: ") });
    expect(await findLiveIosRunner(UDID, BUNDLE, VERSION, deps({ run: run as any }) as IosRunnerDeps)).toBeUndefined();
  });

  it("returns undefined when the live runner answers a different version", async () => {
    const { run } = fakeRun({ "launchctl list": { stdout: LAUNCHCTL_WITH_RUNNER }, lsof: { stdout: LSOF_812 } });
    const probe = async () => "0.0.1-00000000";
    expect(await findLiveIosRunner(UDID, BUNDLE, VERSION, deps({ run: run as any, probe }) as IosRunnerDeps)).toBeUndefined();
  });
});

describe("startIosRunner", () => {
  it("reuses a live runner with our version: no install, no launch", async () => {
    const { run, calls } = fakeRun({ "launchctl list": { stdout: LAUNCHCTL_WITH_RUNNER }, lsof: { stdout: LSOF_812 } });
    const h = await startIosRunner(UDID, deps({ run: run as any, probe: async (p) => (p === 22087 ? VERSION : undefined) }));
    expect(h).toMatchObject({ port: 22087, pid: 812, via: "reused" });
    expect(calls.map((c) => c.args.join(" "))).not.toContainEqual(expect.stringContaining("simctl install"));
    expect(calls.some((c) => c.args.includes("launch"))).toBe(false);
  });

  it("version mismatch: reads RNEDriverVersion, installs, launches with SIMCTL_CHILD_PORT, polls /status", async () => {
    let launched = false;
    const { run, calls } = fakeRun({
      "launchctl list": { stdout: LAUNCHCTL_WITH_RUNNER },
      lsof: { stdout: LSOF_812 },
      get_app_container: { stdout: "/Users/x/Library/Developer/CoreSimulator/Devices/SIM-1/data/Containers/Bundle/Application/AB/RNERunnerUITests-Runner.app\n" },
      "plutil -extract": { stdout: "0.0.1-00000000\n" },
      "simctl launch": () => {
        launched = true;
        return { stdout: `${BUNDLE}: 4242\n` };
      },
    });
    let polls = 0;
    const probe = vi.fn(async (port: number) => {
      if (port === 22087) return "0.0.1-00000000";
      if (port === 50123 && launched && ++polls >= 3) return VERSION;
      return undefined;
    });
    const h = await startIosRunner(UDID, deps({ run: run as any, probe }));
    expect(h).toMatchObject({ port: 50123, pid: 4242, via: "simctl" });
    expect(argv(calls)).toEqual([
      ["xcrun", "simctl", "spawn", UDID, "launchctl", "list"],
      ["lsof", "-nP", "-a", "-p", "812", "-iTCP", "-sTCP:LISTEN"],
      ["xcrun", "simctl", "get_app_container", UDID, BUNDLE],
      [
        "plutil", "-extract", "RNEDriverVersion", "raw",
        "/Users/x/Library/Developer/CoreSimulator/Devices/SIM-1/data/Containers/Bundle/Application/AB/RNERunnerUITests-Runner.app/Info.plist",
      ],
      ["xcrun", "simctl", "install", UDID, ART.runnerApp],
      ["xcrun", "simctl", "launch", "--terminate-running-process", UDID, BUNDLE],
    ]);
    const install = calls.find((c) => c.args[1] === "install")!;
    expect(install.opts?.timeoutMs).toBe(TIMEOUTS.install);
    const launch = calls.find((c) => c.args[1] === "launch")!;
    expect(launch.opts?.env).toEqual({ SIMCTL_CHILD_PORT: "50123" });
  });

  it("not installed (get_app_container fails): installs, then launches", async () => {
    const { run, calls } = fakeRun({
      "launchctl list": { stdout: LAUNCHCTL_WITHOUT_RUNNER },
      get_app_container: new DriverError("xcrun failed: No such file or directory"),
      "simctl launch": { stdout: `${BUNDLE}: 4242\n` },
    });
    const h = await startIosRunner(UDID, deps({ run: run as any, probe: async (p) => (p === 50123 ? VERSION : undefined) }));
    expect(h.via).toBe("simctl");
    expect(calls.some((c) => c.cmd === "plutil")).toBe(false);
    expect(argv(calls)).toContainEqual(["xcrun", "simctl", "install", UDID, ART.runnerApp]);
  });

  it("installed version matches: no install, straight to launch", async () => {
    const { run, calls } = fakeRun({
      "launchctl list": { stdout: LAUNCHCTL_WITHOUT_RUNNER },
      get_app_container: { stdout: "/c/Runner.app\n" },
      "plutil -extract": { stdout: `${VERSION}\n` },
      "simctl launch": { stdout: `${BUNDLE}: 4242\n` },
    });
    const h = await startIosRunner(UDID, deps({ run: run as any, probe: async (p) => (p === 50123 ? VERSION : undefined) }));
    expect(h.via).toBe("simctl");
    expect(calls.some((c) => c.args[1] === "install")).toBe(false);
  });

  // Launching the runner puts it in front; the app under test goes to the
  // background, iOS suspends it and its Metro connection drops.
  it("a fresh start brings `foreground` back to the front, without restarting it", async () => {
    const { run, calls } = fakeRun({
      "launchctl list": { stdout: LAUNCHCTL_WITHOUT_RUNNER },
      get_app_container: { stdout: "/c/Runner.app\n" },
      "plutil -extract": { stdout: `${VERSION}\n` },
      "simctl launch": { stdout: `${BUNDLE}: 4242\n` },
    });
    const h = await startIosRunner(UDID, deps({ run: run as any, probe: async (p) => (p === 50123 ? VERSION : undefined) }), {
      foreground: "com.example.app",
    });
    expect(h.via).toBe("simctl");
    expect(argv(calls).at(-1)).toEqual(["xcrun", "simctl", "launch", UDID, "com.example.app"]);
  });

  it("a reused runner leaves the foreground alone", async () => {
    const { run, calls } = fakeRun({ "launchctl list": { stdout: LAUNCHCTL_WITH_RUNNER }, lsof: { stdout: LSOF_812 } });
    await startIosRunner(UDID, deps({ run: run as any, probe: async (p) => (p === 22087 ? VERSION : undefined) }), {
      foreground: "com.example.app",
    });
    expect(calls.some((c) => c.args.includes("launch"))).toBe(false);
  });

  it("a failed foreground hand-back does not fail the start", async () => {
    const { run } = fakeRun({
      "launchctl list": { stdout: LAUNCHCTL_WITHOUT_RUNNER },
      get_app_container: { stdout: "/c/Runner.app\n" },
      "plutil -extract": { stdout: `${VERSION}\n` },
      [`simctl launch ${UDID} com.example.app`]: new DriverError("xcrun failed: app not installed"),
      "simctl launch": { stdout: `${BUNDLE}: 4242\n` },
    });
    const h = await startIosRunner(UDID, deps({ run: run as any, probe: async (p) => (p === 50123 ? VERSION : undefined) }), {
      foreground: "com.example.app",
    });
    expect(h.via).toBe("simctl");
  });

  it("simctl launch silent for 30s: terminates it and falls back to xcodebuild test-without-building", async () => {
    const c = clock();
    const { run, calls } = fakeRun({
      "launchctl list": { stdout: LAUNCHCTL_WITHOUT_RUNNER },
      get_app_container: { stdout: "/c/Runner.app\n" },
      "plutil -extract": { stdout: `${VERSION}\n` },
      "simctl launch": { stdout: `${BUNDLE}: 4242\n` },
    });
    let spawnedAt: number | undefined;
    const handle = fakeHandle();
    const spawn = vi.fn((_cmd: string, _args: string[], _opts?: { env?: Record<string, string> }) => {
      spawnedAt = c.now();
      return handle;
    });
    const probe = vi.fn(async (port: number) => (port === 50124 && spawnedAt !== undefined ? VERSION : undefined));
    const h = await startIosRunner(UDID, deps({ run: run as any, probe, spawn, sleep: c.sleep, now: c.now }));

    expect(h).toMatchObject({ port: 50124, via: "xcodebuild" });
    expect(spawnedAt).toBeGreaterThanOrEqual(30_000);
    expect(spawnedAt).toBeLessThan(31_000);
    expect(argv(calls)).toContainEqual(["xcrun", "simctl", "terminate", UDID, BUNDLE]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]).toEqual([
      "xcodebuild",
      ["test-without-building", "-xctestrun", ART.xctestrun, "-destination", `id=${UDID}`],
      { env: { TEST_RUNNER_PORT: "50124" } },
    ]);
    await h.stop();
    expect(handle.stop).toHaveBeenCalledTimes(1);
  });

  it("simctl launch itself failing also falls back to xcodebuild", async () => {
    const { run } = fakeRun({
      "launchctl list": { stdout: LAUNCHCTL_WITHOUT_RUNNER },
      get_app_container: { stdout: "/c/Runner.app\n" },
      "plutil -extract": { stdout: `${VERSION}\n` },
      "simctl launch": new DriverError("xcrun failed: The request to open \"dev.rneye.runnerUITests.xctrunner\" failed."),
    });
    let spawned = false;
    const spawn = vi.fn(() => {
      spawned = true;
      return fakeHandle();
    });
    const h = await startIosRunner(UDID, deps({ run: run as any, spawn, probe: async (p) => (spawned && p === 50124 ? VERSION : undefined) }));
    expect(h.via).toBe("xcodebuild");
  });

  it("both silent: DriverError naming both attempts and xcodebuild's last stderr lines; the child is stopped", async () => {
    const c = clock();
    const { run } = fakeRun({
      "launchctl list": { stdout: LAUNCHCTL_WITHOUT_RUNNER },
      get_app_container: { stdout: "/c/Runner.app\n" },
      "plutil -extract": { stdout: `${VERSION}\n` },
      "simctl launch": { stdout: `${BUNDLE}: 4242\n` },
    });
    const handle = fakeHandle({
      stderr: "2026-09-24 noise\nTesting failed:\n\tRNERunnerUITests-Runner encountered an error (Early unexpected exit)\n",
    });
    const err = await startIosRunner(UDID, deps({ run: run as any, spawn: vi.fn(() => handle), sleep: c.sleep, now: c.now })).catch((e) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err.message).toContain(`iOS runner did not start on ${UDID}`);
    expect(err.message).toContain("simctl launch: no answer on port 50123 within 30s");
    expect(err.message).toContain("xcodebuild test-without-building: no answer on port 50124 within 60s");
    expect(err.message).toContain("Early unexpected exit");
    // scripts/ is not in the npm package: the advice must be runnable from an install.
    expect(err.recommendation).not.toContain("smoke-ios-runner");
    expect(err.recommendation).toContain(`xcrun simctl spawn ${UDID} log show`);
    expect(err.recommendation).toContain("RNE_NATIVE_DRIVER=off");
    expect(handle.stop).toHaveBeenCalledTimes(1);
    expect(c.now()).toBeGreaterThanOrEqual(90_000);
    expect(c.now()).toBeLessThan(92_000);
  });

  it("I-2: reports the xcodebuild handle through onSpawn before polling, and resolves with that same handle", async () => {
    const { run } = fakeRun({
      "launchctl list": { stdout: LAUNCHCTL_WITHOUT_RUNNER },
      get_app_container: { stdout: "/c/Runner.app\n" },
      "plutil -extract": { stdout: `${VERSION}\n` },
      "simctl launch": new DriverError("xcrun failed: launch refused"),
    });
    const child = fakeHandle();
    let reported: RunnerHandle | undefined;
    let probedAfterSpawn = false;
    const h = await startIosRunner(
      UDID,
      deps({
        run: run as any,
        spawn: vi.fn(() => child),
        probe: async (p) => {
          if (p !== 50124) return undefined;
          probedAfterSpawn = reported !== undefined;
          return VERSION;
        },
      }),
      { onSpawn: (x) => void (reported = x) },
    );
    expect(probedAfterSpawn).toBe(true);
    expect(h).toBe(reported);
    // M-1: the SIGKILL deadline goes through to the child.
    await h.stop(1500);
    expect(child.stop).toHaveBeenCalledWith("SIGINT", 1500);
  });

  it("I-2: an aborted start spawns no xcodebuild", async () => {
    const ac = new AbortController();
    const { run } = fakeRun({
      "launchctl list": { stdout: LAUNCHCTL_WITHOUT_RUNNER },
      get_app_container: { stdout: "/c/Runner.app\n" },
      "plutil -extract": { stdout: `${VERSION}\n` },
      "simctl launch": () => {
        ac.abort(); // shutdown lands while simctl launch is running
        return { stdout: `${BUNDLE}: 4242\n` };
      },
    });
    const spawn = vi.fn(() => fakeHandle());
    const err = await startIosRunner(UDID, deps({ run: run as any, spawn }), { signal: ac.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err.message).toContain("aborted");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("I-2: aborting while xcodebuild is being polled stops the child and gives up", async () => {
    const ac = new AbortController();
    const c = clock();
    const { run } = fakeRun({
      "launchctl list": { stdout: LAUNCHCTL_WITHOUT_RUNNER },
      get_app_container: { stdout: "/c/Runner.app\n" },
      "plutil -extract": { stdout: `${VERSION}\n` },
      "simctl launch": new DriverError("xcrun failed: launch refused"),
    });
    const child = fakeHandle();
    const sleep = async (ms: number) => {
      await c.sleep(ms);
      if (c.now() > 1_000) ac.abort();
    };
    const err = await startIosRunner(
      UDID,
      deps({ run: run as any, spawn: vi.fn(() => child), sleep, now: c.now }),
      { signal: ac.signal },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err.message).toContain("aborted");
    expect(child.stop).toHaveBeenCalledTimes(1);
    expect(c.now()).toBeLessThan(5_000);
  });

  it("stops polling as soon as the xcodebuild child exits", async () => {
    const c = clock();
    const { run } = fakeRun({
      "launchctl list": { stdout: LAUNCHCTL_WITHOUT_RUNNER },
      get_app_container: { stdout: "/c/Runner.app\n" },
      "plutil -extract": { stdout: `${VERSION}\n` },
      "simctl launch": { stdout: `${BUNDLE}: 4242\n` },
    });
    const handle = fakeHandle({ exited: () => true, stderr: "xcodebuild: error: Unable to find a destination matching { id:SIM-1 }\n" });
    const err = await startIosRunner(UDID, deps({ run: run as any, spawn: vi.fn(() => handle), sleep: c.sleep, now: c.now })).catch((e) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err.message).toContain("xcodebuild test-without-building: exited before answering");
    expect(err.message).toContain("Unable to find a destination");
    expect(c.now()).toBeLessThan(31_000);
  });

  it("artifact missing: DriverError pointing at scripts/build-drivers.sh, and no device commands", async () => {
    const { run, calls } = fakeRun({});
    const err = await startIosRunner(UDID, deps({ run: run as any, artifact: () => undefined })).catch((e) => e);
    expect(err).toBeInstanceOf(DriverError);
    expect(err.message).toMatch(/runner not built/);
    expect(err.message).toContain("scripts/build-drivers.sh");
    expect(calls).toEqual([]);
  });

  it("stop() on a simctl/reused runner kills the pid launchctl reports now", async () => {
    let afterLaunch = false;
    const { run, calls } = fakeRun({
      "launchctl list": () => ({ stdout: afterLaunch ? LAUNCHCTL_WITH_RUNNER : LAUNCHCTL_WITHOUT_RUNNER }),
      get_app_container: { stdout: "/c/Runner.app\n" },
      "plutil -extract": { stdout: `${VERSION}\n` },
      "simctl launch": () => {
        afterLaunch = true;
        return { stdout: `${BUNDLE}: 812\n` };
      },
    });
    const h = await startIosRunner(UDID, deps({ run: run as any, probe: async (p) => (p === 50123 ? VERSION : undefined) }));
    calls.length = 0;
    await h.stop();
    expect(argv(calls)).toEqual([
      ["xcrun", "simctl", "spawn", UDID, "launchctl", "list"],
      ["kill", "812"],
    ]);
  });

  it("stop() is quiet when the runner is already gone", async () => {
    let alive = true;
    const { run, calls } = fakeRun({
      "launchctl list": () => ({ stdout: alive ? LAUNCHCTL_WITH_RUNNER : LAUNCHCTL_WITHOUT_RUNNER }),
      lsof: { stdout: LSOF_812 },
      kill: new DriverError("kill failed: kill: 812: No such process"),
    });
    const h = await startIosRunner(UDID, deps({ run: run as any, probe: async () => VERSION }));
    expect(h.via).toBe("reused");
    // pid still listed but already exiting: kill fails, stop() still resolves
    await expect(h.stop()).resolves.toBeUndefined();
    expect(calls.filter((c) => c.cmd === "kill")).toHaveLength(1);
    // no longer listed: nothing to kill
    alive = false;
    await expect(h.stop()).resolves.toBeUndefined();
    expect(calls.filter((c) => c.cmd === "kill")).toHaveLength(1);
  });
});
