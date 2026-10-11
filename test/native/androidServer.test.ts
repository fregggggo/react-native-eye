import { describe, it, expect, vi } from "vitest";
import {
  startAndroidServer, findLiveAndroidServer, instrumentCommand, defaultLogPath, releaseAndroidServer, readInstrumentLog, instrumentationSummary, SOCKET_PREFIX,
  type AndroidServerDeps, type InstrumentProcess,
} from "../../src/native/androidServer.js";
import type { AndroidArtifact } from "../../src/native/artifacts.js";
import { DriverError } from "../../src/core/errors.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const S = "emulator-5554";
const VERSION = "0.0.1-ab12cd34";
const ART: AndroidArtifact = {
  appApk: "/pkg/build/drivers/android/rne-server.apk",
  testApk: "/pkg/build/drivers/android/rne-server-test.apk",
  appPackage: "dev.rneye.server",
  testPackage: "dev.rneye.server.test",
  testRunner: "dev.rneye.server.test/androidx.test.runner.AndroidJUnitRunner",
  testClass: "dev.rneye.server.DriverService#server",
  version: VERSION,
};
const INSTALLED = `Packages:\n  Package [dev.rneye.server] (abc):\n    versionCode=1 minSdk=24 targetSdk=36\n    versionName=${VERSION}\n`;
const OLD = INSTALLED.replace(VERSION, "0.0.1-00000000");
const INSTALLED_TEST = INSTALLED.replace("Package [dev.rneye.server]", "Package [dev.rneye.server.test]");
const MISSING = "Unable to find package: dev.rneye.server.test\n";

type Call = { cmd: string; args: string[] };
type Answer = { stdout?: string } | Error;

function fakeRun(answers: Record<string, Answer | (() => Answer)>) {
  const calls: Call[] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args.join(" ")}`;
    const match = Object.keys(answers).find((k) => key.includes(k));
    const raw = match ? answers[match] : {};
    const a = typeof raw === "function" ? raw() : raw;
    if (a instanceof Error) throw a;
    const stdout = a.stdout ?? "";
    return { stdout, stdoutBuffer: Buffer.from(stdout), stderr: "" };
  };
  return { run, calls, lines: () => calls.map((c) => [c.cmd, ...c.args].join(" ")) };
}

function fakeProc(opts: { output?: () => string; exited?: () => boolean } = {}) {
  const p: InstrumentProcess & { stop: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } = {
    output: opts.output ?? (() => ""),
    exited: opts.exited ?? (() => false),
    release: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  return p;
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const SOCK = "rneye-0123456789abcdef";
const HAPPY: Record<string, Answer> = {
  "forward --list": { stdout: "" },
  "dumpsys package dev.rneye.server.test": { stdout: INSTALLED_TEST },
  "dumpsys package dev.rneye.server": { stdout: INSTALLED },
  "getprop ro.build.version.sdk": { stdout: "36\n" },
  "forward tcp:0 localabstract:": { stdout: "49424\n" },
};

function deps(over: Partial<AndroidServerDeps> & { run: AndroidServerDeps["run"] }): Partial<AndroidServerDeps> {
  const c = clock();
  return {
    artifact: () => ART,
    probe: async () => undefined,
    spawnInstrument: vi.fn(() => fakeProc()),
    freePort: async () => 50123,
    logPath: () => "/tmp/rne-android-server-test.log",
    socketName: () => SOCK,
    sleep: c.sleep,
    now: c.now,
    ...over,
  };
}

describe("instrumentCommand", () => {
  it("adds -m from API 26, quotes the class and passes the socket name", () => {
    expect(instrumentCommand(ART, 36, SOCK)).toBe(
      `am instrument -w -m -e debug false -e class 'dev.rneye.server.DriverService#server' -e socket ${SOCK} ` +
        "dev.rneye.server.test/androidx.test.runner.AndroidJUnitRunner",
    );
    expect(instrumentCommand(ART, 25, SOCK)).not.toContain(" -m ");
  });
});

describe("defaultLogPath", () => {
  it("puts one log per serial in the temp dir, with the serial made file-safe", () => {
    expect(defaultLogPath("192.168.1.5:5555")).toMatch(/[/\\]rne-android-server-192\.168\.1\.5_5555\.log$/);
    expect(defaultLogPath(S)).toMatch(/[/\\]rne-android-server-emulator-5554\.log$/);
  });
});

describe("readInstrumentLog", () => {
  it("D22: keeps the cause even when the -m logcat dump after it is far longer than 8 KB", () => {
    const dir = mkdtempSync(join(tmpdir(), "rne-log-"));
    const path = join(dir, "log");
    const cause = "E TestRunner: java.lang.IllegalStateException: UiAutomationService x already registered!";
    writeFileSync(path, `${cause}\n${"09-30 17:12:28.675  1041   454  4948 E android.hardware.audio: pcmWrite failure\n".repeat(2000)}`);
    try {
      expect(readInstrumentLog(path)).toContain(cause);
      expect(readInstrumentLog(join(dir, "absent"))).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("instrumentationSummary", () => {
  // The shape seen live on API 36 (verification 2026-10-01, §1.3): the protobuf
  // carries the test's stack under a `stack` key AND the same line in its logcat.
  const EXC = "java.lang.IllegalStateException: UiAutomationService android.accessibilityservice.IAccessibilityServiceClient$Stub$Proxy@10e89baalready registered!";
  const LIVE = [
    `\u0012\u0005stack\u001a\u0080${EXC}`,
    "\tat android.app.UiAutomationConnection.registerUiTestAutomationServiceLocked(UiAutomationConnection.java:524)",
    "10-01 16:50:20.190 10247 11020 11040 E TestRunner: failed: server(dev.rneye.server.DriverService)",
    "10-01 16:50:20.191 10247 11020 11040 E TestRunner: ----- begin exception -----",
    `10-01 16:50:20.192 10247 11020 11040 E TestRunner: ${EXC}`,
    "10-01 16:50:20.193 10247 11020 11040 E TestRunner: \tat android.app.UiAutomationConnection.registerUiTestAutomationServiceLocked(UiAutomationConnection.java:524)",
    "10-01 16:50:20.200 10247 11020 11040 I TestRunner: finished: server(dev.rneye.server.DriverService)",
  ].join("\n");

  it("quotes the exception once, without the protobuf `stack` key in front", () => {
    const out = instrumentationSummary(LIVE);
    expect(out.split("already registered!")).toHaveLength(2);
    expect(out).not.toMatch(/\bstack\b/);
    expect(out.startsWith(EXC)).toBe(true);
    expect(out).toContain("TestRunner: failed: server(dev.rneye.server.DriverService)");
    expect(out).toContain("TestRunner: finished: server(dev.rneye.server.DriverService)");
  });

  it("the text form (`INSTRUMENTATION_STATUS: stack=…`, no -m) is deduplicated against logcat too", () => {
    const out = instrumentationSummary(`INSTRUMENTATION_STATUS: stack=${EXC}\n10-01 16:50:20.192 11020 11040 E TestRunner: ${EXC}\nINSTRUMENTATION_CODE: -1`);
    expect(out.split("already registered!")).toHaveLength(2);
  });
});

describe("findLiveAndroidServer", () => {
  it("reuses this serial's forward to an rneye socket that answers our version and drops stale ones", async () => {
    const f = fakeRun({
      "forward --list": {
        stdout: [
          "emulator-5556 tcp:40001 localabstract:rneye-aaaa",
          `${S} tcp:40002 tcp:7001`,
          `${S} tcp:40005 localabstract:chrome_devtools_remote`,
          `${S} tcp:40003 localabstract:rneye-bbbb`,
          `${S} tcp:40004 localabstract:rneye-cccc`,
        ].join("\n"),
      },
    });
    const probe = vi.fn(async (port: number) => (port === 40004 ? VERSION : port === 40003 ? "0.0.1-old" : undefined));
    const h = await findLiveAndroidServer(S, ART, deps({ run: f.run as any, probe }) as AndroidServerDeps);
    expect(h).toMatchObject({ port: 40004, serial: S, socket: "rneye-cccc", via: "reused" });
    expect(probe.mock.calls.map((c) => c[0])).toEqual([40003, 40004]);
    expect(f.lines()).toContain(`adb -s ${S} forward --remove tcp:40003`);
    expect(f.lines().some((l) => /tcp:4000[125]/.test(l))).toBe(false);
  });

  it("ignores a legacy forward to device TCP 7311 (the pre-socket transport)", async () => {
    const f = fakeRun({ "forward --list": { stdout: `${S} tcp:40004 tcp:7311` } });
    const probe = vi.fn(async () => VERSION);
    expect(await findLiveAndroidServer(S, ART, deps({ run: f.run as any, probe }) as AndroidServerDeps)).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it("returns undefined when adb forward --list fails", async () => {
    const f = fakeRun({ "forward --list": new Error("adb: no devices") });
    expect(await findLiveAndroidServer(S, ART, deps({ run: f.run as any }) as AndroidServerDeps)).toBeUndefined();
  });
});

describe("startAndroidServer", () => {
  it("fails fast with a build hint when nothing is built", async () => {
    const f = fakeRun({});
    const e = await startAndroidServer(S, deps({ run: f.run as any, artifact: () => undefined })).catch((x) => x);
    expect(e).toBeInstanceOf(DriverError);
    expect(e.message).toMatch(/Android server not built/);
    expect(e.message).toContain("scripts/build-drivers.sh android");
    expect(f.calls).toHaveLength(0);
  });

  it("reuses a live server without installing or spawning", async () => {
    const f = fakeRun({ ...HAPPY, "forward --list": { stdout: `${S} tcp:40004 localabstract:rneye-cccc` } });
    const spawnInstrument = vi.fn(() => fakeProc());
    const h = await startAndroidServer(S, deps({ run: f.run as any, spawnInstrument, probe: async (p) => (p === 40004 ? VERSION : undefined) }));
    expect(h.via).toBe("reused");
    expect(spawnInstrument).not.toHaveBeenCalled();
    expect(f.lines().some((l) => l.includes("install"))).toBe(false);
  });

  it("installs what is missing or outdated (app first), force-stops, forwards, spawns, then releases the child", async () => {
    const f = fakeRun({
      ...HAPPY,
      "dumpsys package dev.rneye.server.test": { stdout: MISSING },
      "dumpsys package dev.rneye.server": { stdout: OLD },
      "install -r -t -d": { stdout: "Performing Streamed Install\nSuccess\n" },
    });
    const proc = fakeProc();
    const onSpawn = vi.fn();
    let spawned = false;
    const h = await startAndroidServer(
      S,
      deps({
        run: f.run as any,
        spawnInstrument: vi.fn(() => ((spawned = true), proc)),
        probe: async (p) => (spawned && p === 49424 ? VERSION : undefined),
      }),
      { onSpawn },
    );
    expect(h).toMatchObject({ port: 49424, serial: S, socket: SOCK, via: "instrument" });
    const l = f.lines();
    const at = (s: string) => l.findIndex((x) => x.includes(s));
    expect(at(`install -r -t -d ${ART.appApk}`)).toBeGreaterThan(-1);
    expect(at(`install -r -t -d ${ART.appApk}`)).toBeLessThan(at(`install -r -t -d ${ART.testApk}`));
    expect(at("am force-stop dev.rneye.server")).toBeLessThan(at(`forward tcp:0 localabstract:${SOCK}`));
    expect(spawned).toBe(true);
    expect(l.every((x) => x.startsWith(`adb -s ${S} `))).toBe(true);
    expect(onSpawn).toHaveBeenCalledWith(h);
    expect(proc.release).toHaveBeenCalled();
    expect(proc.stop).not.toHaveBeenCalled();
  });

  it("uninstalls and reinstalls once on a signature mismatch", async () => {
    let first = true;
    const f = fakeRun({
      ...HAPPY,
      "dumpsys package dev.rneye.server": { stdout: OLD },
      [`install -r -t -d ${ART.appApk}`]: () =>
        first ? ((first = false), new Error("adb failed: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]")) : { stdout: "Success\n" },
      "install -r -t -d": { stdout: "Success\n" },
    });
    let spawned = false;
    await startAndroidServer(S, deps({
      run: f.run as any,
      spawnInstrument: vi.fn(() => ((spawned = true), fakeProc())),
      probe: async () => (spawned ? VERSION : undefined),
    }));
    expect(f.lines()).toContain(`adb -s ${S} uninstall dev.rneye.server`);
    expect(f.lines().filter((l) => l.includes(`install -r -t -d ${ART.appApk}`))).toHaveLength(2);
  });

  it("I5: installs with -d, and a downgrade refusal anyway is replaced by uninstall + install", async () => {
    let first = true;
    const f = fakeRun({
      ...HAPPY,
      "dumpsys package dev.rneye.server": { stdout: OLD },
      [`install -r -t -d ${ART.appApk}`]: () =>
        first ? ((first = false), new Error("adb failed: Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected]")) : { stdout: "Success\n" },
      "install -r -t -d": { stdout: "Success\n" },
    });
    let spawned = false;
    const h = await startAndroidServer(S, deps({
      run: f.run as any,
      spawnInstrument: vi.fn(() => ((spawned = true), fakeProc())),
      probe: async () => (spawned ? VERSION : undefined),
    }));
    expect(h.via).toBe("instrument");
    expect(f.lines()).toContain(`adb -s ${S} uninstall dev.rneye.server`);
    expect(f.lines().filter((l) => l.includes("install -r -t ") && !l.includes(" -d "))).toEqual([]);
  });

  it("reports an install failure with the physical-device hint", async () => {
    const f = fakeRun({ ...HAPPY, "dumpsys package dev.rneye.server": { stdout: MISSING }, "install -r -t -d": new Error("adb failed: INSTALL_FAILED_USER_RESTRICTED") });
    const e = await startAndroidServer(S, deps({ run: f.run as any })).catch((x) => x);
    expect(e).toBeInstanceOf(DriverError);
    expect(e.message).toMatch(/INSTALL_FAILED_USER_RESTRICTED/);
    expect(e.message).toMatch(/Install via USB/);
  });

  it("fails early on INSTRUMENTATION_FAILED, cleans up, and names the next steps that ship with the package", async () => {
    const f = fakeRun(HAPPY);
    const proc = fakeProc({ output: () => "INSTRUMENTATION_STATUS: Error=Permission Denial: starting instrumentation\nINSTRUMENTATION_FAILED: dev.rneye.server.test\n" });
    const c = clock();
    const e = await startAndroidServer(S, deps({ run: f.run as any, spawnInstrument: vi.fn(() => proc), sleep: c.sleep, now: c.now })).catch((x) => x);
    expect(e).toBeInstanceOf(DriverError);
    expect(e.message).toMatch(/INSTRUMENTATION_FAILED/);
    expect(e.message).not.toContain("smoke-android-server");
    expect(e.message).toContain(`adb -s ${S} logcat -s RNEye:V AndroidRuntime:E`);
    expect(e.message).toContain("RNE_NATIVE_DRIVER=off");
    expect(e.message).toMatch(/retried in 5 minutes/);
    expect(c.now()).toBeLessThan(1000);
    expect(proc.stop).toHaveBeenCalled();
    expect(f.lines()).toContain(`adb -s ${S} forward --remove tcp:49424`);
  });

  it("retries while UiAutomation is held by someone else, then succeeds", async () => {
    const f = fakeRun(HAPPY);
    const busy = fakeProc({ output: () => "java.lang.IllegalStateException: UiAutomationService ... already registered!", exited: () => true });
    const good = fakeProc();
    const procs = [busy, good];
    const h = await startAndroidServer(S, deps({
      run: f.run as any,
      spawnInstrument: vi.fn(() => procs.shift()!),
      probe: async () => (procs.length === 0 ? VERSION : undefined),
    }));
    expect(h.via).toBe("instrument");
    expect(busy.stop).toHaveBeenCalled();
    // attempt 1, the cleanup of attempt 1 (stopServer), attempt 2
    expect(f.lines().filter((l) => l.includes("am force-stop"))).toHaveLength(3);
    expect(f.lines().filter((l) => l.includes(`forward --remove tcp:49424`))).toHaveLength(1);
  });

  it("gives up after 4 busy attempts", async () => {
    const f = fakeRun(HAPPY);
    const spawnInstrument = vi.fn(() => fakeProc({ output: () => "UiAutomationService already registered", exited: () => true }));
    const e = await startAndroidServer(S, deps({ run: f.run as any, spawnInstrument })).catch((x) => x);
    expect(spawnInstrument).toHaveBeenCalledTimes(4);
    expect(e.message).toMatch(/another tool holds UiAutomation \(uiautomator dump, Maestro, Appium\)/);
  });

  it("times out after 30 s of silence", async () => {
    const f = fakeRun(HAPPY);
    const c = clock();
    const e = await startAndroidServer(S, deps({ run: f.run as any, sleep: c.sleep, now: c.now })).catch((x) => x);
    expect(e.message).toMatch(/no answer on port 49424 within 30s/);
    expect(c.now()).toBeGreaterThanOrEqual(30_000);
  });

  it("spawns nothing once aborted", async () => {
    const f = fakeRun(HAPPY);
    const ctl = new AbortController();
    ctl.abort();
    const spawnInstrument = vi.fn(() => fakeProc());
    const e = await startAndroidServer(S, deps({ run: f.run as any, spawnInstrument }), { signal: ctl.signal }).catch((x) => x);
    expect(e.message).toMatch(/aborted/);
    expect(spawnInstrument).not.toHaveBeenCalled();
  });

  it("falls back to a free port when adb forward tcp:0 prints no port (old adb)", async () => {
    const f = fakeRun({ ...HAPPY, "forward tcp:0 localabstract:": { stdout: "" } });
    let spawned = false;
    const h = await startAndroidServer(S, deps({
      run: f.run as any,
      spawnInstrument: vi.fn(() => ((spawned = true), fakeProc())),
      probe: async (p) => (spawned && p === 50123 ? VERSION : undefined),
    }));
    expect(h.port).toBe(50123);
    expect(f.lines()).toContain(`adb -s ${S} forward tcp:50123 localabstract:${SOCK}`);
  });

  it("a failing adb forward keeps the lifecycle's hint and spawns nothing", async () => {
    const f = fakeRun({ ...HAPPY, "forward tcp:0 localabstract:": new DriverError("adb failed: error: cannot bind listener") });
    const spawnInstrument = vi.fn(() => fakeProc());
    const e = await startAndroidServer(S, deps({ run: f.run as any, spawnInstrument })).catch((x) => x);
    expect(e).toBeInstanceOf(DriverError);
    expect(e.message).toContain(`adb forward to localabstract:${SOCK} failed (adb failed: error: cannot bind listener)`);
    expect(e.message).not.toContain("smoke-android-server");
    expect(e.message).toMatch(/retried in 5 minutes/);
    expect(spawnInstrument).not.toHaveBeenCalled();
  });

  describe("D22/D28: what a failed start says", () => {
    // What `am instrument -m` leaves in the log when the test dies on UiAutomation
    // (field test 3, A1): the protobuf stream carries a logcat dump of the whole
    // device, most of it other processes; the cause sits in the middle.
    const NOISE = [
      "09-30 17:12:28.675  1041   454  4948 E android.hardware.audio@7.1-impl.ranchu: pcmWrite:260 failure: -1",
      '09-30 17:12:28.710  1000   669   692 I DisplayDeviceRepository: Display device changed render timings: "Built-in Screen"',
      "09-30 17:12:28.727  1041   493   614 D AudioFlinger: mixer(0xb400007a71224770) throttle end: throttle time(14)",
    ];
    const CRASH = [
      "INSTRUMENTATION_STATUS: class=dev.rneye.server.DriverService",
      "09-30 17:12:27.330 10247  5157  5202 I TestRunner: started: server(dev.rneye.server.DriverService)",
      "09-30 17:12:27.400  1041   454  4948 E android.hardware.audio@7.1-impl.ranchu: pcmWrite:260 failure: -1",
      "09-30 17:12:27.437 10247  5157  5202 E TestRunner: failed: server(dev.rneye.server.DriverService)",
      "09-30 17:12:27.437 10247  5157  5202 E TestRunner: ----- begin exception -----",
      "09-30 17:12:27.438 10247  5157  5202 E TestRunner: java.lang.IllegalStateException: UiAutomationService android.accessibilityservice.IAccessibilityServiceClient$Stub$Proxy@5768f9aalready registered!",
      "09-30 17:12:27.438 10247  5157  5202 E TestRunner: \tat android.app.UiAutomationConnection.registerUiTestAutomationServiceLocked(UiAutomationConnection.java:524)",
      "09-30 17:12:27.439  1000   669   692 E ActivityManager: some other process's Error: unrelated",
      ...NOISE,
      '"\u0001\u0002 shortMsg\u0012\u0010Process crashed.',
    ].join("\n");

    it("quotes the instrumentation's own lines (exception first), never other processes' logcat", async () => {
      const f = fakeRun(HAPPY);
      const proc = fakeProc({ output: () => CRASH.replace(/already registered/, "boom"), exited: () => true });
      const e = await startAndroidServer(S, deps({ run: f.run as any, spawnInstrument: vi.fn(() => proc) })).catch((x) => x);
      expect(e).toBeInstanceOf(DriverError);
      expect(e.message).toMatch(/Instrumentation output: TestRunner: java\.lang\.IllegalStateException: UiAutomationService .*boom!/);
      expect(e.message).toContain("shortMsg Process crashed.");
      expect(e.message).toContain("TestRunner: failed: server(dev.rneye.server.DriverService)");
      for (const bad of ["android.hardware.audio", "DisplayDeviceRepository", "AudioFlinger", "ActivityManager", "\tat ", "begin exception"]) {
        expect(e.message).not.toContain(bad);
      }
      expect(e.message).not.toContain("smoke-android-server");
      expect(e.message).toContain(`adb -s ${S} logcat -s RNEye:V AndroidRuntime:E`);
    });

    it("'already registered' anywhere in the instrumentation's output is another tool holding UiAutomation: retried promptly, then named", async () => {
      const f = fakeRun(HAPPY);
      const c = clock();
      const sleeps: number[] = [];
      const spawnInstrument = vi.fn(() => fakeProc({ output: () => CRASH, exited: () => true }));
      const e = await startAndroidServer(
        S,
        deps({ run: f.run as any, spawnInstrument, now: c.now, sleep: async (ms) => (sleeps.push(ms), c.sleep(ms)) }),
      ).catch((x) => x);
      expect(spawnInstrument.mock.calls.length).toBeGreaterThan(1);
      // Prompt: the retries wait 1–2 s, not the 5-minute window.
      for (const ms of sleeps.filter((ms) => ms > 250)) expect(ms).toBeLessThanOrEqual(2000);
      expect(e.message).toMatch(/another tool holds UiAutomation \(uiautomator dump, Maestro, Appium\)/);
      expect(e.message).not.toContain("exited before answering");
      expect(e.message).not.toContain("android.hardware.audio");
    });

    it("a busy attempt followed by a good one starts the server", async () => {
      const f = fakeRun(HAPPY);
      const procs = [fakeProc({ output: () => CRASH, exited: () => true }), fakeProc()];
      const h = await startAndroidServer(S, deps({
        run: f.run as any,
        spawnInstrument: vi.fn(() => procs.shift()!),
        probe: async () => (procs.length === 0 ? VERSION : undefined),
      }));
      expect(h.via).toBe("instrument");
    });
  });

  describe("D27: what a restart reinstalls", () => {
    const started = () => {
      let spawned = false;
      return {
        spawnInstrument: vi.fn(() => ((spawned = true), fakeProc())),
        probe: async () => (spawned ? VERSION : undefined),
      };
    };

    it("packages of our version: force-stop + forward + am instrument, no install", async () => {
      const f = fakeRun(HAPPY);
      const h = await startAndroidServer(S, deps({ run: f.run as any, ...started() }));
      expect(h.via).toBe("instrument");
      expect(f.lines().some((l) => / (un)?install /.test(l))).toBe(false);
    });

    it("a version check that times out under load is not a reason to reinstall", async () => {
      const f = fakeRun({
        ...HAPPY,
        "dumpsys package dev.rneye.server.test": new DriverError("adb -s timed out after 20000ms (killed)."),
        "dumpsys package dev.rneye.server": new DriverError("adb -s timed out after 20000ms (killed)."),
      });
      const h = await startAndroidServer(S, deps({ run: f.run as any, ...started() }));
      expect(h.via).toBe("instrument");
      expect(f.lines().some((l) => / (un)?install /.test(l))).toBe(false);
    });

    it("a dumpsys that ran out of its own time (no package section) is not a reason to reinstall either", async () => {
      const timedOut = { stdout: "*** SERVICE 'package' DUMP TIMEOUT (10000ms) EXPIRED ***\n" };
      const f = fakeRun({ ...HAPPY, "dumpsys package dev.rneye.server.test": timedOut, "dumpsys package dev.rneye.server": timedOut });
      await startAndroidServer(S, deps({ run: f.run as any, ...started() }));
      expect(f.lines().some((l) => / (un)?install /.test(l))).toBe(false);
    });

    it("an unverified install that turns out missing (instrumentation not found) is installed and started once more", async () => {
      const f = fakeRun({
        ...HAPPY,
        "dumpsys package dev.rneye.server.test": new DriverError("adb -s timed out after 20000ms (killed)."),
        "install -r -t -d": { stdout: "Success\n" },
      });
      const missing = fakeProc({
        output: () => "INSTRUMENTATION_STATUS: Error=Unable to find instrumentation info for: ComponentInfo{dev.rneye.server.test/androidx.test.runner.AndroidJUnitRunner}\nINSTRUMENTATION_FAILED: dev.rneye.server.test/androidx.test.runner.AndroidJUnitRunner\n",
        exited: () => true,
      });
      const procs = [missing, fakeProc()];
      const h = await startAndroidServer(S, deps({
        run: f.run as any,
        spawnInstrument: vi.fn(() => procs.shift()!),
        probe: async () => (procs.length === 0 ? VERSION : undefined),
      }));
      expect(h.via).toBe("instrument");
      const l = f.lines();
      expect(l.filter((x) => x.includes(`install -r -t -d ${ART.testApk}`))).toHaveLength(1);
      expect(l.findIndex((x) => x.includes(`install -r -t -d ${ART.testApk}`))).toBeGreaterThan(l.findIndex((x) => x.includes("forward tcp:0")));
    });

    it("an unverified install that answers /status with another version is installed and started once more, without the 30 s wait", async () => {
      const f = fakeRun({
        ...HAPPY,
        "dumpsys package dev.rneye.server.test": new DriverError("adb -s timed out after 20000ms (killed)."),
        "dumpsys package dev.rneye.server": new DriverError("adb -s timed out after 20000ms (killed)."),
        "install -r -t -d": { stdout: "Success\n" },
      });
      const c = clock();
      let spawns = 0;
      const h = await startAndroidServer(S, deps({
        run: f.run as any,
        now: c.now,
        sleep: c.sleep,
        spawnInstrument: vi.fn(() => (spawns++, fakeProc())),
        probe: async () => (spawns === 1 ? "0.0.1-00000000" : spawns === 2 ? VERSION : undefined),
      }));
      expect(h.via).toBe("instrument");
      expect(spawns).toBe(2);
      expect(f.lines().filter((x) => x.includes("install -r -t -d"))).toHaveLength(2);
      expect(c.now()).toBeLessThan(5000);
    });

    it("the test package reported missing although dumpsys said it was there: reinstalled once, not in a loop", async () => {
      const f = fakeRun({ ...HAPPY, "install -r -t -d": { stdout: "Success\n" } });
      const spawnInstrument = vi.fn(() =>
        fakeProc({ output: () => "INSTRUMENTATION_FAILED: dev.rneye.server.test/androidx.test.runner.AndroidJUnitRunner\nUnable to find instrumentation info\n", exited: () => true }),
      );
      const e = await startAndroidServer(S, deps({ run: f.run as any, spawnInstrument })).catch((x) => x);
      expect(e).toBeInstanceOf(DriverError);
      expect(spawnInstrument).toHaveBeenCalledTimes(2);
      expect(f.lines().filter((x) => x.includes("install -r -t -d")).length).toBe(2); // app + test, once
    });
  });

  it("stop() removes the forward, force-stops the package and kills the child", async () => {
    const f = fakeRun(HAPPY);
    const proc = fakeProc();
    let spawned = false;
    const h = await startAndroidServer(S, deps({
      run: f.run as any,
      spawnInstrument: vi.fn(() => ((spawned = true), proc)),
      probe: async () => (spawned ? VERSION : undefined),
    }));
    await h.stop(500);
    expect(proc.stop).toHaveBeenCalledWith(500);
    expect(f.lines().slice(-2)).toEqual([`adb -s ${S} forward --remove tcp:49424`, `adb -s ${S} shell am force-stop dev.rneye.server`]);
  });
});

describe("socket names", () => {
  it("I1: a fresh random rneye-<16 hex> name per start, forwarded and passed to the instrumentation", async () => {
    const f = fakeRun({ ...HAPPY, "getprop ro.build.version.sdk": { stdout: "36\n" } });
    const busy = fakeProc({ output: () => "UiAutomationService already registered", exited: () => true });
    const good = fakeProc();
    const procs = [busy, good];
    const spawnInstrument = vi.fn((_s: string, _cmd: string, _log: string) => procs.shift()!);
    const d = deps({ run: f.run as any, spawnInstrument, probe: async () => (procs.length === 0 ? VERSION : undefined) });
    delete d.socketName; // the default generator
    const h = await startAndroidServer(S, d);
    const names = spawnInstrument.mock.calls.map((c) => / -e socket (\S+) /.exec(c[1])?.[1]);
    expect(names).toHaveLength(2);
    for (const n of names) expect(n).toMatch(new RegExp(`^${SOCKET_PREFIX}[0-9a-f]{16}$`));
    expect(names[0]).not.toBe(names[1]);
    expect(h.socket).toBe(names[1]);
    expect(f.lines()).toContain(`adb -s ${S} forward tcp:0 localabstract:${names[1]}`);
  });
});

describe("releaseAndroidServer", () => {
  it("I3: force-stops our package and removes this serial's server forwards only", async () => {
    const f = fakeRun({
      "forward --list": {
        stdout: [`${S} tcp:40003 localabstract:rneye-bbbb`, `emulator-5556 tcp:40001 localabstract:rneye-aaaa`, `${S} tcp:40005 tcp:8081`].join("\n"),
      },
    });
    await releaseAndroidServer(S, { run: f.run as any, artifact: () => ART });
    expect(f.lines()).toEqual([
      `adb -s ${S} shell am force-stop dev.rneye.server`,
      `adb -s ${S} forward --list`,
      `adb -s ${S} forward --remove tcp:40003`,
    ]);
  });

  it("works without a build and never throws", async () => {
    const f = fakeRun({ "am force-stop": new Error("adb: device offline"), "forward --list": new Error("adb: device offline") });
    await expect(releaseAndroidServer(S, { run: f.run as any, artifact: () => undefined })).resolves.toBeUndefined();
    expect(f.lines()[0]).toBe(`adb -s ${S} shell am force-stop dev.rneye.server`);
  });
});
