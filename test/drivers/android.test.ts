import { describe, it, expect } from "vitest";
import { AndroidDriver } from "../../src/drivers/android.js";
import { TIMEOUTS } from "../../src/core/exec.js";

function fakeRunner(responses: Record<string, string>) {
  const calls: string[] = [];
  const runner = async (cmd: string, args: string[]) => {
    const keyStr = `${cmd} ${args.join(" ")}`;
    calls.push(keyStr);
    const match = Object.keys(responses).find((k) => keyStr.includes(k));
    const stdout = match ? responses[match] : "";
    return { stdout, stdoutBuffer: Buffer.from(stdout), stderr: "" };
  };
  return { runner, calls };
}

const noShell = () => ({
  exec: async (): Promise<string> => {
    throw new Error("adb shell died");
  },
});

describe("AndroidDriver", () => {
  it("lists booted devices", async () => {
    const out = "List of devices attached\nemulator-5554\tdevice\n";
    const { runner } = fakeRunner({ "devices -l": out });
    const driver = new AndroidDriver(runner as any);
    const devices = await driver.listDevices();
    expect(devices[0]).toMatchObject({ platform: "android", udid: "emulator-5554", booted: true });
  });

  it("parses uiautomator layout", async () => {
    const xml = `<hierarchy><node text="Go" resource-id="a:id/go" bounds="[0,0][10,10]"/></hierarchy>`;
    const { runner } = fakeRunner({ "uiautomator dump": xml });
    const driver = new AndroidDriver(runner as any);
    const { els, os } = await driver.rawLayout("emulator-5554");
    expect(els[0].testID).toBe("go");
    expect(os).toEqual({ path: "adb" });
  });

  it("reports a uiautomator failure instead of an empty screen", async () => {
    const { runner } = fakeRunner({ "uiautomator dump": "ERROR: could not get idle state.\n" });
    const driver = new AndroidDriver(runner as any);
    // Field test D19: exit code 0, the complaint on stdout, zero nodes — the
    // agent was told the screen was empty.
    await expect(driver.rawLayout("emulator-5554")).rejects.toThrow(/could not get idle state/);
    await expect(driver.rawLayout("emulator-5554")).rejects.toThrow(/source:"js"/);
  });

  it("retries once before giving up on a non-idle screen", async () => {
    const xml = `<hierarchy><node text="Go" resource-id="a:id/go" bounds="[0,0][10,10]"/></hierarchy>`;
    let n = 0;
    const runner = async () => {
      const stdout = n++ === 0 ? "ERROR: could not get idle state.\n" : xml;
      return { stdout, stdoutBuffer: Buffer.from(stdout), stderr: "" };
    };
    const driver = new AndroidDriver(runner as any);
    const { els } = await driver.rawLayout("emulator-5554");
    expect(els[0].testID).toBe("go");
    expect(n).toBe(2);
  });

  it("accepts an genuinely empty hierarchy without calling it a failure", async () => {
    const { runner } = fakeRunner({ "uiautomator dump": `<?xml version="1.0"?><hierarchy rotation="0" />` });
    const driver = new AndroidDriver(runner as any);
    await expect(driver.rawLayout("emulator-5554")).resolves.toEqual({ els: [], os: { path: "adb" } });
  });

  it("maps back key to keyevent 4 (one-shot fallback)", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new AndroidDriver(runner as any, undefined, noShell);
    await driver.pressKey("emulator-5554", "back");
    expect(calls.some((c) => c.includes("input 'keyevent' '4'"))).toBe(true);
  });

  it("long-presses via input swipe at a single point (one-shot fallback)", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new AndroidDriver(runner as any, undefined, noShell);
    await driver.tapXY("SER", 50, 60, 1500);
    expect(calls.some((c) => c.includes("input 'swipe' '50' '60' '50' '60' '1500'"))).toBe(true);
  });

  it("routes taps through the persistent shell when it works", async () => {
    const { runner, calls } = fakeRunner({});
    const shellCmds: string[] = [];
    const shell = () => ({
      exec: async (c: string) => {
        shellCmds.push(c);
        return "";
      },
    });
    const driver = new AndroidDriver(runner as any, undefined, shell);
    await driver.tapXY("SER", 5, 6);
    expect(shellCmds).toContain("input 'tap' '5' '6'");
    expect(calls.some((c) => c.includes("input tap"))).toBe(false);
  });

  it("force-stops before launch when requested", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    await driver.launchApp("SER", "com.x.app", { terminateRunning: true });
    expect(calls.some((c) => c.includes("am force-stop 'com.x.app'"))).toBe(true);
  });

  it("rejects env vars (unsupported on android)", async () => {
    const { runner } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    await expect(driver.launchApp("SER", "com.x.app", { env: { A: "1" } })).rejects.toThrow(/not supported/i);
  });

  it("launches through the resolved activity instead of monkey", async () => {
    const { runner, calls } = fakeRunner({
      "resolve-activity": "priority=0 preferredOrder=0\n  com.x.app/.MainActivity\n",
      "am start": "Starting: Intent { cmp=com.x.app/.MainActivity }\n",
    });
    const driver = new AndroidDriver(runner as any);
    await driver.launchApp("emulator-5554", "com.x.app");
    // Field test D21: monkey exits 251 on API 36 and starts nothing.
    expect(calls.some((c) => c.includes("am start -n 'com.x.app/.MainActivity'"))).toBe(true);
    expect(calls.some((c) => c.includes("monkey"))).toBe(false);
  });

  it("reports am start's failure, which it prints while exiting 0", async () => {
    const { runner } = fakeRunner({
      "resolve-activity": "com.x.app/.MainActivity\n",
      "am start": "Starting: Intent { cmp=com.x.app/.MainActivity }\nError: Activity class does not exist.\n",
    });
    const driver = new AndroidDriver(runner as any);
    await expect(driver.launchApp("emulator-5554", "com.x.app")).rejects.toThrow(/Activity class does not exist/);
  });

  it("falls back to monkey when no launchable activity resolves", async () => {
    const { runner, calls } = fakeRunner({ "resolve-activity": "No activity found\n" });
    const driver = new AndroidDriver(runner as any);
    await driver.launchApp("emulator-5554", "com.x.app");
    expect(calls.some((c) => c.includes("monkey -p 'com.x.app'"))).toBe(true);
  });

  it("does not swallow the monkey fallback's own failure (API 36 exit 251)", async () => {
    const runner = async (cmd: string, args: string[]) => {
      const keyStr = `${cmd} ${args.join(" ")}`;
      if (keyStr.includes("resolve-activity")) {
        return { stdout: "No activity found\n", stdoutBuffer: Buffer.from(""), stderr: "" };
      }
      // Field test D21: on API 36 monkey itself exits 251 without starting anything.
      throw new Error(
        "adb -s emulator-5554 shell `monkey -p 'com.x.app' -c android.intent.category.LAUNCHER 1` failed " +
          "(exit 251): ** SYS_KEYS has no physical keys but with factor 2.0%.",
      );
    };
    const driver = new AndroidDriver(runner as any);
    await expect(driver.launchApp("emulator-5554", "com.x.app")).rejects.toThrow(/exit 251/);
  });

  it("shell-quotes the resolved activity so characters the shell would interpret cannot execute", async () => {
    const { runner, calls } = fakeRunner({
      "resolve-activity": "com.x.app/.Main;$(reboot)`id`Activity\n",
    });
    const driver = new AndroidDriver(runner as any);
    await driver.launchApp("emulator-5554", "com.x.app");
    expect(calls.some((c) => c.includes("am start -n 'com.x.app/.Main;$(reboot)`id`Activity'"))).toBe(true);
  });

  it("names both causes when resolve-activity throws and the monkey fallback also fails", async () => {
    const runner = async (cmd: string, args: string[]) => {
      const keyStr = `${cmd} ${args.join(" ")}`;
      if (keyStr.includes("resolve-activity")) {
        throw new Error(
          "adb -s emulator-5554 shell `cmd package resolve-activity --brief 'com.x.app'` timed out after 120000ms",
        );
      }
      // Field test D21: on API 36 monkey itself exits 251 without starting anything.
      throw new Error(
        "adb -s emulator-5554 shell `monkey -p 'com.x.app' -c android.intent.category.LAUNCHER 1` failed " +
          "(exit 251): ** SYS_KEYS has no physical keys but with factor 2.0%.",
      );
    };
    const driver = new AndroidDriver(runner as any);
    // Both the resolve-activity failure and the monkey failure must be named —
    // not just whichever one happened last.
    await expect(driver.launchApp("emulator-5554", "com.x.app")).rejects.toThrow(/timed out after 120000ms/);
    await expect(driver.launchApp("emulator-5554", "com.x.app")).rejects.toThrow(/exit 251/);
    await expect(driver.launchApp("emulator-5554", "com.x.app")).rejects.toThrow(/SYS_KEYS/);
  });

  it("reports a plain success when resolve-activity throws but the monkey fallback succeeds", async () => {
    const runner = async (cmd: string, args: string[]) => {
      const keyStr = `${cmd} ${args.join(" ")}`;
      if (keyStr.includes("resolve-activity")) {
        throw new Error(
          "adb -s emulator-5554 shell `cmd package resolve-activity --brief 'com.x.app'` timed out after 120000ms",
        );
      }
      return { stdout: "", stdoutBuffer: Buffer.from(""), stderr: "" };
    };
    const driver = new AndroidDriver(runner as any);
    // A recoverable resolve failure that monkey papers over must stay silent —
    // no warning, no noise, on a device where this fallback works fine.
    await expect(driver.launchApp("emulator-5554", "com.x.app")).resolves.toBeUndefined();
  });

  it("installs an apk", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    await driver.installApp("SER", "/tmp/app.apk");
    expect(calls.some((c) => c.includes("install -r /tmp/app.apk"))).toBe(true);
  });

  it("records via screenrecord, then pkills, pulls, and removes the device file", async () => {
    const { runner, calls } = fakeRunner({});
    const spawned: string[] = [];
    const spawner = (cmd: string, args: string[]) => {
      spawned.push(`${cmd} ${args.join(" ")}`);
      return { exited: () => false, stderr: () => "", assertAlive: async () => {}, stop: async () => {} };
    };
    const driver = new AndroidDriver(runner as any, spawner as any);
    const h = await driver.recordStart("SER", "/tmp/out.mp4");
    expect(spawned[0]).toContain("shell screenrecord");
    await h.finalize();
    expect(calls.some((c) => c.includes("pkill -2 screenrecord"))).toBe(true);
    expect(calls.some((c) => c.includes("pull") && c.includes("/tmp/out.mp4"))).toBe(true);
    expect(calls.some((c) => c.includes("shell rm"))).toBe(true);
  });
});

describe("AndroidDriver shell safety", () => {
  it("quotes text so shell metacharacters cannot execute on the device", async () => {
    const shellCmds: string[] = [];
    const shell = () => ({ exec: async (c: string) => { shellCmds.push(c); return ""; } });
    const { runner } = fakeRunner({});
    const driver = new AndroidDriver(runner as any, undefined, shell);
    await driver.typeText("SER", "a; rm -rf /sdcard/DCIM && echo pwned");
    expect(shellCmds[0]).toBe("input 'text' 'a; rm -rf /sdcard/DCIM && echo pwned'");
  });

  it("escapes embedded single quotes", async () => {
    const shellCmds: string[] = [];
    const shell = () => ({ exec: async (c: string) => { shellCmds.push(c); return ""; } });
    const { runner } = fakeRunner({});
    const driver = new AndroidDriver(runner as any, undefined, shell);
    await driver.typeText("SER", "it's fine");
    expect(shellCmds[0]).toBe("input 'text' 'it'\\''s fine'");
  });

  it("refuses non-ASCII text instead of reporting a success that types nothing", async () => {
    const { runner } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    await expect(driver.typeText("SER", "こんにちは")).rejects.toThrow(/non-ASCII/i);
    await expect(driver.typeText("SER", "🎉")).rejects.toThrow(/non-ASCII/i);
  });

  it("does not retry a genuine input failure (no double taps)", async () => {
    const calls: string[] = [];
    const shell = () => ({
      exec: async () => {
        throw new Error("adb shell `input tap 5 6` failed (exit 255): permission denied");
      },
    });
    const runner = async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return { stdout: "", stdoutBuffer: Buffer.from(""), stderr: "" };
    };
    const driver = new AndroidDriver(runner as any, undefined, shell);
    await expect(driver.tapXY("SER", 5, 6)).rejects.toThrow(/exit 255/);
    expect(calls).toHaveLength(0);
  });

  it("falls back to one-shot adb when the persistent shell died", async () => {
    const calls: string[] = [];
    const runner = async (cmd: string, args: string[]) => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return { stdout: "", stdoutBuffer: Buffer.from(""), stderr: "" };
    };
    const driver = new AndroidDriver(runner as any, undefined, noShell);
    await driver.tapXY("SER", 5, 6);
    expect(calls[0]).toContain("input 'tap' '5' '6'");
  });

  it("keeps the input command visible when the one-shot fallback also fails, instead of collapsing to a bare 'adb -s' message", async () => {
    // exec.ts's timeout message names only `${cmd} ${args[0]}` — for the
    // fallback call that is "adb -s", which loses which input command was in
    // flight. The wrapper here must not let that information disappear.
    const shell = () => ({
      exec: async () => {
        throw new Error("adb shell `input tap 5 6` timed out after 90000ms");
      },
    });
    const runner = async () => {
      throw new Error("adb -s timed out after 90000ms (killed).");
    };
    const driver = new AndroidDriver(runner as any, undefined, shell);
    await expect(driver.tapXY("SER", 5, 6)).rejects.toThrow(/input 'tap' '5' '6'/);
  });

  it("derives the JS→pixel scale from wm density", async () => {
    const { runner } = fakeRunner({ "wm density": "Physical density: 420\n" });
    const driver = new AndroidDriver(runner as any);
    expect(await driver.pointScale("SER-density")).toBeCloseTo(2.625);
  });

  it("reads the screen size from wm size", async () => {
    const { runner } = fakeRunner({ "wm size": "Physical size: 1080x2400\n" });
    const driver = new AndroidDriver(runner as any);
    expect(await driver.screenSize("SER")).toEqual({ w: 1080, h: 2400 });
  });
});

describe("AndroidDriver screen scale", () => {
  it("is 1 — input tap and screencap share the physical pixel space", async () => {
    const { runner } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    expect(await driver.screenScale("SER-scale")).toBe(1);
  });
});

describe("timeout classes", () => {
  function capturingShell() {
    const calls: { cmd: string; timeoutMs?: number }[] = [];
    const shell = () => ({
      exec: async (cmd: string, opts?: { timeoutMs?: number }) => {
        calls.push({ cmd, timeoutMs: opts?.timeoutMs });
        return "";
      },
    });
    return { calls, shell };
  }

  it("gives touch delivery the touch budget", async () => {
    const { calls, shell } = capturingShell();
    const { runner } = fakeRunner({});
    const driver = new AndroidDriver(runner as any, undefined, shell);
    await driver.tapXY("SER", 5, 6);
    await driver.swipe("SER", 1, 2, 3, 4, 300);
    expect(calls.map((c) => c.timeoutMs)).toEqual([TIMEOUTS.touch, TIMEOUTS.touch]);
  });

  it("gives keyboard and hardware buttons the key budget", async () => {
    const { calls, shell } = capturingShell();
    const { runner } = fakeRunner({});
    const driver = new AndroidDriver(runner as any, undefined, shell);
    await driver.typeText("SER", "abc");
    await driver.pressKey("SER", "home");
    expect(calls.map((c) => c.timeoutMs)).toEqual([TIMEOUTS.key, TIMEOUTS.key]);
  });
});

describe("AndroidDriver touch-free routes", () => {
  it("opens a url with a VIEW intent through adb shell", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    await driver.openUrl("SER", "demo://profile");
    expect(calls).toContain("adb -s SER shell am start -a android.intent.action.VIEW -d 'demo://profile'");
  });

  it("shell-quotes a url so a ';' cannot become a second command on the device", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    await driver.openUrl("SER", "demo://x; reboot #");
    // adb concatenates everything after `shell` and runs it through the device's
    // sh. Unquoted, the `;` starts a second command there.
    expect(calls[0]).toContain("-d 'demo://x; reboot #'");
    expect(calls[0]).not.toMatch(/-d demo/);
  });

  it("shell-quotes command substitution in a url", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    await driver.openUrl("SER", "demo://x?u=$(id)`whoami`");
    expect(calls[0]).toContain("-d 'demo://x?u=$(id)`whoami`'");
  });

  it("escapes a single quote inside a url instead of letting it close the quoting", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    await driver.openUrl("SER", "demo://x?q='; reboot; '");
    expect(calls[0]).toContain(`-d 'demo://x?q='\\''; reboot; '\\'''`);
  });

  it("maps camera to android.permission.CAMERA and calls pm grant", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    await driver.setPermission("SER", "com.x.app", "camera", "grant");
    expect(calls).toContain("adb -s SER shell pm grant 'com.x.app' 'android.permission.CAMERA'");
  });

  it("maps the rest of the known services", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    for (const s of ["microphone", "photos", "location", "contacts", "notifications"]) {
      await driver.setPermission("SER", "com.x.app", s, "revoke");
    }
    const joined = calls.join("\n");
    expect(joined).toContain("pm revoke 'com.x.app' 'android.permission.RECORD_AUDIO'");
    expect(joined).toContain("pm revoke 'com.x.app' 'android.permission.READ_MEDIA_IMAGES'");
    expect(joined).toContain("pm revoke 'com.x.app' 'android.permission.ACCESS_FINE_LOCATION'");
    expect(joined).toContain("pm revoke 'com.x.app' 'android.permission.READ_CONTACTS'");
    expect(joined).toContain("pm revoke 'com.x.app' 'android.permission.POST_NOTIFICATIONS'");
  });

  it("resets with pm reset-permissions, which takes no package", async () => {
    const { runner, calls } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    await driver.setPermission("SER", "com.x.app", "camera", "reset");
    expect(calls).toContain("adb -s SER shell pm reset-permissions");
  });

  it("refuses an unknown service, naming the ones it knows", async () => {
    const { runner } = fakeRunner({});
    const driver = new AndroidDriver(runner as any);
    await expect(driver.setPermission("SER", "com.x.app", "bluetooth", "grant")).rejects.toThrow(
      /Unknown permission service "bluetooth".*camera.*microphone.*photos.*location.*contacts.*notifications/s,
    );
  });
  // Column layout verbatim from `top -H -b` on a real device (toybox).
  const TOP_OUT = [
    "  TID USER         PR  NI VIRT  RES  SHR S[%CPU] %MEM     TIME+ THREAD          PROCESS",
    " 4242 u0_a207      20   0  18G 215M 163M R 60.0   5.6   0:08.49 ndroid.x.app    com.x.app",
    " 4250 u0_a207      20   0  18G 215M 163M R 40.0   5.6   0:02.10 mqt_js          com.x.app",
  ].join("\n");

  function fakeShell(replies: Record<string, string>) {
    const cmds: string[] = [];
    const shell = {
      exec: async (cmd: string) => {
        cmds.push(cmd);
        const hit = Object.keys(replies).find((k) => cmd.includes(k));
        return hit ? replies[hit] : "";
      },
    };
    return { cmds, shellFor: () => shell };
  }

  it("samples threads through the persistent shell, pid first", async () => {
    const { runner } = fakeRunner({});
    const { cmds, shellFor } = fakeShell({ pidof: "4242", top: TOP_OUT });
    const driver = new AndroidDriver(runner as any, undefined, shellFor as any);
    const sample = await driver.cpuSample!("SER", "com.x.app", 2);
    expect(cmds[0]).toBe("pidof 'com.x.app'");
    // -n 2: the first iteration's %CPU covers a window top picked, not ours.
    expect(cmds[1]).toBe("top -H -p 4242 -d 2 -n 2 -b");
    expect(sample.pid).toBe(4242);
    expect(sample.threads.find((t) => t.role === "main")?.cpuPercent).toBe(60);
    expect(sample.threads.find((t) => t.role === "js")?.share).toBeCloseTo(0.4, 4);
    // Android gives %CPU per thread but no stacks, and the output must say so.
    expect(sample.note).toMatch(/native frames|stack/i);
  });

  it("refuses to sample an app that is not running", async () => {
    const { runner } = fakeRunner({});
    const { shellFor } = fakeShell({ top: TOP_OUT });
    const driver = new AndroidDriver(runner as any, undefined, shellFor as any);
    await expect(driver.cpuSample!("SER", "com.x.app", 2)).rejects.toThrow(/com\.x\.app is not running/);
  });

  it("resets gfxinfo, waits out the window, then reads framestats", async () => {
    const header = "Flags,IntendedVsync,FrameCompleted,";
    const gfx = [
      "Total frames rendered: 2",
      "Janky frames: 1 (50.00%)",
      "---PROFILEDATA---",
      header,
      "0,1000000000,1016000000,",
      "0,2000000000,2050000000,",
      "---PROFILEDATA---",
    ].join("\n");
    const { runner } = fakeRunner({});
    const { cmds, shellFor } = fakeShell({ framestats: gfx });
    const driver = new AndroidDriver(runner as any, undefined, shellFor as any);
    const started = Date.now();
    const stats = await driver.frameStats!("SER", "com.x.app", 60);
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);
    expect(cmds[0]).toBe("dumpsys gfxinfo 'com.x.app' reset");
    expect(cmds[1]).toBe("dumpsys gfxinfo 'com.x.app' framestats");
    expect(stats.durationMs).toBe(60);
    expect(stats.frameDurationsMs).toEqual([16, 50]);
    expect(stats.jankyFrames).toBe(1);
  });
});

describe("AndroidDriver reports the OS path it used", () => {
  it("returns {path:'adb'} from every input method and from rawLayout", async () => {
    const { runner } = fakeRunner({ "uiautomator dump": `<hierarchy rotation="0" />` });
    const shell = () => ({ exec: async () => "" });
    const d = new AndroidDriver(runner as any, undefined, shell);
    await expect(d.tapXY("SER", 1, 2)).resolves.toEqual({ path: "adb" });
    await expect(d.tapXY("SER", 1, 2, 800)).resolves.toEqual({ path: "adb" });
    await expect(d.swipe("SER", 1, 2, 3, 4, 300)).resolves.toEqual({ path: "adb" });
    await expect(d.typeText("SER", "abc")).resolves.toEqual({ path: "adb" });
    await expect(d.pressKey("SER", "back")).resolves.toEqual({ path: "adb" });
    await expect(d.pressKey("SER", "home")).resolves.toEqual({ path: "adb" });
    expect((await d.rawLayout("SER")).os).toEqual({ path: "adb" });
  });
});
