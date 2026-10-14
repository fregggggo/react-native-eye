import { describe, it, expect } from "vitest";
import { IosDriver } from "../../src/drivers/ios.js";
import { TIMEOUTS } from "../../src/core/exec.js";

function fakeRunner(responses: Record<string, { stdout?: string; stdoutBuffer?: Buffer }>) {
  const calls: string[] = [];
  const runner = async (cmd: string, args: string[]) => {
    const keyStr = `${cmd} ${args.join(" ")}`;
    calls.push(keyStr);
    const match = Object.keys(responses).find((k) => keyStr.includes(k));
    const r = match ? responses[match] : {};
    return { stdout: r.stdout ?? "", stdoutBuffer: r.stdoutBuffer ?? Buffer.from(r.stdout ?? ""), stderr: "" };
  };
  return { runner, calls };
}

describe("IosDriver", () => {
  it("lists booted simulators", async () => {
    const listJson = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-0": [
          { udid: "ABC", name: "iPhone 15", state: "Booted" },
          { udid: "DEF", name: "iPhone 14", state: "Shutdown" },
        ],
      },
    });
    const { runner } = fakeRunner({ "simctl list devices": { stdout: listJson } });
    const driver = new IosDriver(runner as any);
    const devices = await driver.listDevices();
    expect(devices).toContainEqual({ platform: "ios", udid: "ABC", name: "iPhone 15", booted: true });
    expect(devices.find((d) => d.udid === "DEF")?.booted).toBe(false);
  });

  it("parses layout via axe describe-ui", async () => {
    const axeJson = JSON.stringify([{ AXLabel: "Hi", frame: { x: 1, y: 2, width: 3, height: 4 }, children: [] }]);
    const { runner } = fakeRunner({ "describe-ui": { stdout: axeJson } });
    const driver = new IosDriver(runner as any);
    const { els, os } = await driver.rawLayout("ABC");
    expect(els[0].text).toBe("Hi");
    expect(os).toEqual({ path: "axe" });
  });

  it("issues a tap through axe", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new IosDriver(runner as any);
    await driver.tapXY("ABC", 50, 60);
    expect(calls.some((c) => c.includes("tap") && c.includes("50") && c.includes("60"))).toBe(true);
  });

  it("long-presses via axe touch with --delay in seconds", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new IosDriver(runner as any);
    await driver.tapXY("ABC", 50, 60, 1500);
    const call = calls.find((c) => c.includes("touch"));
    expect(call).toBeDefined();
    expect(call).toContain("--down");
    expect(call).toContain("--up");
    expect(call).toContain("--delay 1.5");
  });

  it("passes touch coordinates as -x/-y, the only spelling axe touch parses", async () => {
    // Field report: every long press died with `axe failed: Missing expected
    // argument '-x <x>'`. axe's own --help *examples* show `--x`, but its USAGE
    // line declares short options only, and swift-argument-parser rejects the
    // long form — so `tap` with duration_ms never reached the device.
    const { runner, calls } = fakeRunner({});
    const driver = new IosDriver(runner as any);
    await driver.tapXY("ABC", 50, 60, 1500);
    const call = calls.find((c) => c.includes("touch"))!;
    expect(call).toContain("-x 50");
    expect(call).toContain("-y 60");
    expect(call).not.toContain("--x");
    expect(call).not.toContain("--y");
  });

  it("saves a screenshot to a file via simctl with type and mask", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new IosDriver(runner as any);
    await driver.screenshotFile("ABC", "/tmp/shot.jpeg", { format: "jpeg", mask: "black" });
    const call = calls.find((c) => c.includes("screenshot") && !c.includes("--type=png"));
    expect(call).toContain("--type=jpeg");
    expect(call).toContain("--mask=black");
    expect(call).toContain("/tmp/shot.jpeg");
  });

  it("terminates before launch when requested and prefixes env with SIMCTL_CHILD_", async () => {
    const envs: any[] = [];
    const { runner, calls } = fakeRunner({});
    const capturing = async (cmd: string, args: string[], o?: any) => {
      envs.push(o?.env);
      return runner(cmd, args);
    };
    const driver = new IosDriver(capturing as any);
    await driver.launchApp("ABC", "com.x.app", { terminateRunning: true, env: { FOO: "1" } });
    expect(calls.some((c) => c.includes("terminate ABC com.x.app"))).toBe(true);
    const launchIdx = calls.findIndex((c) => c.includes("launch ABC com.x.app"));
    expect(launchIdx).toBeGreaterThan(-1);
    expect(envs[launchIdx]).toEqual({ SIMCTL_CHILD_FOO: "1" });
  });

  it("installs an app bundle via simctl", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new IosDriver(runner as any);
    await driver.installApp("ABC", "/tmp/My.app");
    expect(calls.some((c) => c.includes("simctl install ABC /tmp/My.app"))).toBe(true);
  });

  it("records video via simctl recordVideo and stops with SIGINT", async () => {
    const { runner } = fakeRunner({});
    const { spawner, spawned, wasStopped } = fakeSpawner();
    const driver = new IosDriver(runner as any, spawner as any);
    const h = await driver.recordStart("ABC", "/tmp/out.mp4", { codec: "h264" });
    expect(spawned[0]).toContain("simctl io ABC recordVideo");
    expect(spawned[0]).toContain("--codec h264");
    expect(spawned[0]).toContain("/tmp/out.mp4");
    await h.finalize();
    expect(wasStopped()).toBe(true);
  });
});

function fakeSpawner() {
  const spawned: string[] = [];
  let stopped = false;
  const spawner = (cmd: string, args: string[]) => {
    spawned.push(`${cmd} ${args.join(" ")}`);
    return {
      exited: () => stopped,
      stderr: () => "",
      assertAlive: async () => {},
      stop: async () => {
        stopped = true;
      },
    };
  };
  return { spawner, spawned, wasStopped: () => stopped };
}

describe("IosDriver back gesture", () => {
  it("scales the edge swipe to the screen instead of a hard-coded y=400", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new IosDriver(runner as any);
    await driver.pressKey("U", "back", { viewport: { x: 0, y: 0, w: 440, h: 956 } });
    const swipe = calls.find((c) => c.includes("swipe"))!;
    expect(swipe).toContain("--start-y 478");
    expect(swipe).toContain("--end-x 198");
  });

  it("still works with no viewport known", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new IosDriver(runner as any);
    await driver.pressKey("U", "back");
    expect(calls.find((c) => c.includes("swipe"))).toContain("--start-y 400");
  });
});

describe("IosDriver screen scale", () => {
  const typeId = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
  const bundlePath = "/Library/Developer/CoreSimulator/Profiles/DeviceTypes/iPhone 17 Pro.simdevicetype";
  const devicesJson = (udid: string) =>
    JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-26-2": [
          { udid, name: "iPhone 17 Pro", state: "Booted", deviceTypeIdentifier: typeId },
        ],
      },
    });
  const typesJson = JSON.stringify({ devicetypes: [{ identifier: typeId, name: "iPhone 17 Pro", bundlePath }] });
  const profileJson = JSON.stringify({ mainScreenScale: 3, mainScreenWidth: 1206, mainScreenHeight: 2622 });
  const responses = (udid: string) => ({
    "simctl list devices --json": { stdout: devicesJson(udid) },
    "simctl list devicetypes --json": { stdout: typesJson },
    "plutil -convert json": { stdout: profileJson },
  });

  it("resolves pixels-per-point from the simulator's device-type profile", async () => {
    const { runner, calls } = fakeRunner(responses("SCALE-1"));
    const driver = new IosDriver(runner as any);
    expect(await driver.screenScale("SCALE-1")).toBe(3);
    expect(calls.find((c) => c.startsWith("plutil"))).toContain(
      "iPhone 17 Pro.simdevicetype/Contents/Resources/profile.plist",
    );
  });

  it("reports the screen size in points", async () => {
    const { runner } = fakeRunner(responses("SCALE-2"));
    const driver = new IosDriver(runner as any);
    expect(await driver.screenSize("SCALE-2")).toEqual({ w: 402, h: 874 });
  });

  it("probes the profile once per udid", async () => {
    const { runner, calls } = fakeRunner(responses("SCALE-3"));
    const driver = new IosDriver(runner as any);
    await driver.screenScale("SCALE-3");
    await driver.screenScale("SCALE-3");
    await driver.screenSize("SCALE-3");
    expect(calls.filter((c) => c.startsWith("plutil")).length).toBe(1);
  });

  it("returns undefined instead of throwing when the probe fails", async () => {
    const { runner } = fakeRunner({});
    const driver = new IosDriver(runner as any);
    expect(await driver.screenScale("SCALE-4")).toBeUndefined();
    expect(await driver.screenSize("SCALE-4")).toBeUndefined();
  });

  it("does not consult devicetypes for a udid simctl does not list", async () => {
    const { runner, calls } = fakeRunner(responses("SOMEONE-ELSE"));
    const driver = new IosDriver(runner as any);
    expect(await driver.screenScale("SCALE-5")).toBeUndefined();
    expect(calls.some((c) => c.includes("devicetypes"))).toBe(false);
  });

  it("does not pin a failed probe", async () => {
    const broken = fakeRunner({});
    expect(await new IosDriver(broken.runner as any).screenScale("SCALE-6")).toBeUndefined();
    const fixed = fakeRunner(responses("SCALE-6"));
    expect(await new IosDriver(fixed.runner as any).screenScale("SCALE-6")).toBe(3);
  });
});

describe("timeout classes", () => {
  function recordingRunner() {
    const calls: { cmd: string; args: string[]; timeoutMs?: number }[] = [];
    const runner = async (cmd: string, args: string[], opts?: { timeoutMs?: number }) => {
      calls.push({ cmd, args, timeoutMs: opts?.timeoutMs });
      return { stdout: "", stdoutBuffer: Buffer.from(""), stderr: "" };
    };
    return { calls, runner: runner as any };
  }

  it("gives touch delivery the touch budget", async () => {
    const { calls, runner } = recordingRunner();
    const d = new IosDriver(runner);
    await d.tapXY("U", 10, 20);
    await d.swipe("U", 1, 2, 3, 4, 300);
    expect(calls.map((c) => c.timeoutMs)).toEqual([TIMEOUTS.touch, TIMEOUTS.touch]);
  });

  it("gives keyboard and hardware buttons the key budget", async () => {
    const { calls, runner } = recordingRunner();
    const d = new IosDriver(runner);
    await d.typeText("U", "abc");
    await d.pressKey("U", "home");
    // typeText probes the host keyboard layout first; that call is Task 8's,
    // and this test is about what the axe invocations are budgeted at.
    expect(calls[0].cmd).toBe("defaults");
    expect(calls.filter((c) => c.cmd === "axe").map((c) => c.timeoutMs)).toEqual([TIMEOUTS.key, TIMEOUTS.key]);
  });

  it("treats the iOS back gesture as a touch, because it is an edge swipe", async () => {
    const { calls, runner } = recordingRunner();
    const d = new IosDriver(runner);
    await d.pressKey("U", "back", { viewport: { x: 0, y: 0, w: 400, h: 800 } });
    expect(calls[0].args[0]).toBe("swipe");
    expect(calls[0].timeoutMs).toBe(TIMEOUTS.touch);
  });
});

describe("typeText guards the OS keyboard path", () => {
  function recordingRunner() {
    const calls: { cmd: string; args: string[] }[] = [];
    const runner = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return { stdout: "", stdoutBuffer: Buffer.from(""), stderr: "" };
    };
    return { calls, runner: runner as any };
  }
  const usLayout = async () => "com.apple.keylayout.US";

  it("refuses non-ASCII text without invoking axe", async () => {
    const { calls, runner } = recordingRunner();
    const d = new IosDriver(runner, undefined, usLayout);
    await expect(d.typeText("U", "こんにちは")).rejects.toThrow(/cannot type non-ASCII characters \("こんにちは/);
    await expect(d.typeText("U", "🎉")).rejects.toThrow(/via: "js"/);
    expect(calls.filter((c) => c.cmd === "axe")).toEqual([]);
  });

  it("refuses under a transliterating layout, naming it, without invoking axe", async () => {
    const { calls, runner } = recordingRunner();
    const d = new IosDriver(runner, undefined, async () => "com.apple.keylayout.Greek");
    await expect(d.typeText("U", "cat")).rejects.toThrow(/layout is com\.apple\.keylayout\.Greek/);
    await expect(d.typeText("U", "cat")).rejects.toThrow(/key positions/);
    expect(calls.filter((c) => c.cmd === "axe")).toEqual([]);
  });

  it("types under an ASCII-safe layout", async () => {
    const { calls, runner } = recordingRunner();
    const d = new IosDriver(runner, undefined, usLayout);
    await d.typeText("U", "cat");
    expect(calls.filter((c) => c.cmd === "axe")).toEqual([
      { cmd: "axe", args: ["type", "cat", "--udid", "U"] },
    ]);
  });

  it("types when the layout cannot be read at all", async () => {
    const { calls, runner } = recordingRunner();
    const d = new IosDriver(runner, undefined, async () => undefined);
    await d.typeText("U", "cat");
    expect(calls.some((c) => c.cmd === "axe" && c.args[0] === "type")).toBe(true);
  });

  it("re-reads the layout on every call, because the user can switch mid-session", async () => {
    const { runner } = recordingRunner();
    let id = "com.apple.keylayout.US";
    const d = new IosDriver(runner, undefined, async () => id);
    await d.typeText("U", "cat");
    id = "com.apple.keylayout.Greek";
    await expect(d.typeText("U", "cat")).rejects.toThrow(/Greek/);
  });
});

describe("touch-free routes", () => {
  function argRunner() {
    const calls: { cmd: string; args: string[]; timeoutMs?: number }[] = [];
    const runner = async (cmd: string, args: string[], o?: { timeoutMs?: number }) => {
      calls.push({ cmd, args, timeoutMs: o?.timeoutMs });
      return { stdout: "", stdoutBuffer: Buffer.from(""), stderr: "" };
    };
    return { calls, runner: runner as any };
  }

  it("opens a url through simctl openurl on the key budget", async () => {
    const { calls, runner } = argRunner();
    await new IosDriver(runner).openUrl("UD1", "demo://v/42");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("xcrun");
    expect(calls[0].args).toEqual(["simctl", "openurl", "UD1", "demo://v/42"]);
    expect(calls[0].timeoutMs).toBe(TIMEOUTS.key);
  });

  it("passes the url through verbatim — execFile takes an argv array, there is no shell", async () => {
    const { calls, runner } = argRunner();
    await new IosDriver(runner).openUrl("UD1", "demo://search?q=a b&c=$(id)");
    expect(calls[0].args[3]).toBe("demo://search?q=a b&c=$(id)");
  });

  it("puts simctl privacy arguments in action, service, bundle order", async () => {
    const { calls, runner } = argRunner();
    await new IosDriver(runner).setPermission("UD1", "com.x.app", "camera", "grant");
    expect(calls[0].cmd).toBe("xcrun");
    expect(calls[0].args).toEqual(["simctl", "privacy", "UD1", "grant", "camera", "com.x.app"]);
  });

  it("keeps that order for revoke and reset", async () => {
    const { calls, runner } = argRunner();
    const d = new IosDriver(runner);
    await d.setPermission("UD1", "com.x.app", "photos", "revoke");
    await d.setPermission("UD1", "com.x.app", "all", "reset");
    expect(calls[0].args.slice(3)).toEqual(["revoke", "photos", "com.x.app"]);
    expect(calls[1].args.slice(3)).toEqual(["reset", "all", "com.x.app"]);
  });
  // The call-graph shape is verbatim from a real `sample` run against an RN app
  // in the simulator; the thread names are the ones RN 0.74+ actually uses.
  const SAMPLE_OUT = [
    "Analysis of sampling quick (pid 50571) every 1 millisecond",
    "",
    "Call graph:",
    "    600 Thread_100   DispatchQueue_1: com.apple.main-thread  (serial)",
    "    + 600 start  (in dyld) + 6992  [0x1]",
    "    +   600 CA::Layer::layout_if_needed(CA::Transaction*)  (in QuartzCore) + 20  [0x2]",
    "    600 Thread_200: com.facebook.react.runtime.JavaScript",
    "    + 600 _pthread_start  (in libsystem_pthread.dylib) + 136  [0x3]",
    "    +   600 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x4]",
    "",
    "Binary Images:",
  ].join("\n");

  const LAUNCHCTL_OUT = [
    "PID\tStatus\tLabel",
    "-\t0\tcom.apple.progressd",
    "50571\t0\tUIKitApplication:com.x.app[760b][rb-legacy]",
  ].join("\n");

  it("samples the app's own pid, found through launchctl in the simulator", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const runner = (async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const key = `${cmd} ${args.join(" ")}`;
      const stdout = key.includes("launchctl list") ? LAUNCHCTL_OUT : key.startsWith("sample ") ? SAMPLE_OUT : "";
      return { stdout, stdoutBuffer: Buffer.from(stdout), stderr: "" };
    }) as any;
    const sample = await new IosDriver(runner).cpuSample!("UD1", "com.x.app", 3);
    expect(calls[0].args).toEqual(["simctl", "spawn", "UD1", "launchctl", "list"]);
    expect(calls[1]).toEqual({ cmd: "sample", args: ["50571", "3"] });
    expect(sample.pid).toBe(50571);
    expect(sample.durationS).toBe(3);
    // The JS thread sat in __psynch_cvwait the whole time: idle, not 50% hot.
    expect(sample.threads.find((t) => t.role === "js")?.busyFraction).toBe(0);
    expect(sample.threads.find((t) => t.role === "main")?.share).toBe(1);
  });

  it("says the app is not running rather than sampling nothing", async () => {
    const runner = (async () => ({
      stdout: LAUNCHCTL_OUT,
      stdoutBuffer: Buffer.from(LAUNCHCTL_OUT),
      stderr: "",
    })) as any;
    await expect(new IosDriver(runner).cpuSample!("UD1", "com.other.app", 3)).rejects.toThrow(
      /com\.other\.app is not running/,
    );
  });

  it("returns the raw head when `sample` prints something it cannot parse", async () => {
    const runner = (async (cmd: string, args: string[]) => {
      const key = `${cmd} ${args.join(" ")}`;
      const stdout = key.includes("launchctl list") ? LAUNCHCTL_OUT : "sample: could not attach to process";
      return { stdout, stdoutBuffer: Buffer.from(stdout), stderr: "" };
    }) as any;
    const sample = await new IosDriver(runner).cpuSample!("UD1", "com.x.app", 3);
    expect(sample.threads).toHaveLength(0);
    expect(sample.unparsed).toContain("could not attach");
  });

  it("gives `sample` far more time than the sampling window, for symbolication", async () => {
    // Measured: a 1s sample of a 700MB RN app took 4.3s wall — nearly all of it
    // symbolicating the call graph after the window closed.
    const calls: { args: string[]; timeoutMs?: number }[] = [];
    const runner = (async (cmd: string, args: string[], o?: { timeoutMs?: number }) => {
      calls.push({ args, timeoutMs: o?.timeoutMs });
      const stdout = args.includes("launchctl") ? LAUNCHCTL_OUT : SAMPLE_OUT;
      return { stdout, stdoutBuffer: Buffer.from(stdout), stderr: "" };
    }) as any;
    await new IosDriver(runner).cpuSample!("UD1", "com.x.app", 3);
    expect(calls[1].timeoutMs!).toBeGreaterThan(3_000 + 20_000);
  });
});

describe("IosDriver reports the OS path it used", () => {
  it("returns {path:'axe'} from every input method and from rawLayout", async () => {
    const { runner } = fakeRunner({ "describe-ui": { stdout: "[]" } });
    const d = new IosDriver(runner as any, undefined, async () => "com.apple.keylayout.US");
    await expect(d.tapXY("U", 1, 2)).resolves.toEqual({ path: "axe" });
    await expect(d.tapXY("U", 1, 2, 800)).resolves.toEqual({ path: "axe" });
    await expect(d.swipe("U", 1, 2, 3, 4, 300)).resolves.toEqual({ path: "axe" });
    await expect(d.typeText("U", "cat")).resolves.toEqual({ path: "axe" });
    await expect(d.pressKey("U", "home")).resolves.toEqual({ path: "axe" });
    await expect(d.pressKey("U", "back", { viewport: { x: 0, y: 0, w: 400, h: 800 } })).resolves.toEqual({
      path: "axe",
    });
    expect((await d.rawLayout("U")).os).toEqual({ path: "axe" });
  });
});
