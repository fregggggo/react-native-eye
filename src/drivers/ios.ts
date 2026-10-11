import { join } from "node:path";
import { run as defaultRun, spawnLongRunning, TIMEOUTS, type LongRunningHandle } from "../core/exec.js";
import { DriverError } from "../core/errors.js";
import { parseAxe } from "../layout/parseAxe.js";
import { parseXcRunner, xcRunnerViewport } from "../layout/parseXcRunner.js";
import { sharedPool } from "../native/pool.js";
import { activeKeyboardLayout, isAsciiSafeLayout } from "./hostKeyboard.js";
import { NativePath, type RunnerPool } from "./nativePath.js";
import { parseSample, parseAppPid } from "../perf/parseSample.js";
import type { CpuSample, DeviceDriver, DeviceId, OsPath, RawElement, RecordingHandle, Viewport } from "./types.js";

type Runner = typeof defaultRun;
type Spawner = (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => LongRunningHandle;
type KeyboardLayoutReader = (run?: Runner) => Promise<string | undefined>;

type SimProfile = { scale: number; w: number; h: number }; // w/h in pixels

// `sample` spends most of its wall time symbolicating the call graph *after*
// the sampling window closes — a 1s sample of a 700MB RN app took 4.3s end to
// end — so the budget is the window plus a flat allowance, not a multiple of it.
const SAMPLE_SYMBOLICATION_MS = 60_000;

// A simulator's screen scale is not in any simctl output; it lives in the
// device-type profile plist. Three cheap commands, memoised per udid because
// activeDriver builds a fresh driver per tool call. Failures are not cached.
const profileCache = new Map<string, Promise<SimProfile | undefined>>();

export { fallbackReason, type RunnerPool } from "./nativePath.js";

/**
 * iOS has no hardware back: an edge swipe placed relative to the screen — a
 * hard-coded y=400 lands in the wrong place on anything but a mid-size phone.
 */
function backSwipe(vp?: Viewport): { x1: number; y1: number; x2: number; y2: number; durationMs: number } {
  const midY = Math.round(vp ? vp.y + vp.h / 2 : 400);
  return {
    x1: vp ? Math.round(vp.x) : 0,
    y1: midY,
    x2: Math.round(vp ? vp.x + vp.w * 0.45 : 200),
    y2: midY,
    durationMs: 200,
  };
}

const EMPTY_HIERARCHY_RETRY_MS = 400;

export class IosDriver implements DeviceDriver {
  readonly platform = "ios" as const;
  private native: NativePath;

  constructor(
    private runner: Runner = defaultRun,
    private spawner: Spawner = spawnLongRunning,
    // Injected like runner/spawner so tests never read the real machine's
    // layout. It is handed `this.runner`, so a driver built with a fake runner
    // keeps the probe hermetic without having to stub this parameter too.
    private keyboardLayout: KeyboardLayoutReader = activeKeyboardLayout,
    // The on-device runner. activeDriver builds a fresh IosDriver per tool
    // call; the pool is what lives for the whole session.
    pool: RunnerPool = sharedPool(),
  ) {
    this.native = new NativePath(pool, "ios", "iOS runner", "axe");
  }

  async listDevices(): Promise<DeviceId[]> {
    const { stdout } = await this.runner("xcrun", ["simctl", "list", "devices", "--json"], {
      timeoutMs: TIMEOUTS.list,
    });
    const data = JSON.parse(stdout) as { devices: Record<string, any[]> };
    const out: DeviceId[] = [];
    for (const list of Object.values(data.devices)) {
      for (const d of list) {
        if (d.isAvailable === false) continue;
        out.push({ platform: "ios", udid: d.udid, name: d.name, booted: d.state === "Booted" });
      }
    }
    return out;
  }

  async screenshotPng(udid: string): Promise<Buffer> {
    // Which path produced a screenshot is not reported anywhere, so a runner
    // failure falls back silently; the pool still learns about it.
    const { backend } = this.native.backendFor(udid);
    if (backend) {
      try {
        return await backend.screenshot();
      } catch (err) {
        this.native.readFailure(udid, backend, err);
      }
    }
    const { stdoutBuffer } = await this.runner(
      "xcrun",
      ["simctl", "io", udid, "screenshot", "--type=png", "-"],
      { timeoutMs: TIMEOUTS.screenshot },
    );
    return stdoutBuffer;
  }

  async screenshotFile(
    udid: string,
    path: string,
    opts: { format: "png" | "jpeg"; mask?: "ignored" | "alpha" | "black" },
  ): Promise<void> {
    const args = ["simctl", "io", udid, "screenshot", `--type=${opts.format}`];
    if (opts.mask) args.push(`--mask=${opts.mask}`);
    args.push(path);
    await this.runner("xcrun", args, { timeoutMs: TIMEOUTS.screenshot });
  }

  async rawLayout(udid: string): Promise<{ els: RawElement[]; os: OsPath }> {
    const { backend, reason } = this.native.backendFor(udid);
    let why = reason;
    if (backend) {
      try {
        // Right after a system alert is dismissed the runner briefly returns an
        // empty tree; one short retry beats a multi-second axe describe-ui.
        for (let attempt = 0; attempt < 2; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, EMPTY_HIERARCHY_RETRY_MS));
          const json = await backend.hierarchy();
          // The runner's recovery shape can lack both an Application and a
          // Window; only then is the simulator's screen size worth looking up.
          const size = xcRunnerViewport(json) ? undefined : await this.screenSize(udid);
          const els = parseXcRunner(json, size);
          if (els.length > 0) return { els, os: { path: "runner" } };
        }
        why = "runner hierarchy empty";
      } catch (err) {
        why = this.native.readFailure(udid, backend, err);
      }
    }
    const els = await this.axeLayout(udid);
    return { els, os: this.native.osPath(why) };
  }

  private async axeLayout(udid: string): Promise<RawElement[]> {
    // describe-ui walks the whole accessibility tree and can return megabytes;
    // measured at ~5s on a busy screen and considerably worse mid-animation.
    const { stdout } = await this.runner("axe", ["describe-ui", "--udid", udid], {
      timeoutMs: TIMEOUTS.layout,
      hint: "axe describe-ui is slow on complex screens and while animations are running.",
    });
    return parseAxe(stdout);
  }

  async tapXY(udid: string, x: number, y: number, durationMs?: number): Promise<OsPath> {
    const hold = durationMs && durationMs > 0 ? durationMs : undefined;
    return this.native.gesture(
      udid,
      hold ? "long press" : "tap",
      (b) => b.touch(x, y, hold),
      async () => {
        if (hold) {
          // `-x`/`-y`, not `--x`/`--y`: axe's --help examples show the long form,
          // but `axe touch` declares short options only and refuses the long one
          // with "Missing expected argument '-x <x>'". `axe swipe` is the opposite
          // (--start-x et al), so the spelling is per subcommand, not global.
          await this.runner("axe", [
            "touch", "-x", String(x), "-y", String(y),
            "--down", "--up", "--delay", String(hold / 1000), "--udid", udid,
          ], { timeoutMs: TIMEOUTS.touch });
        } else {
          await this.runner("axe", ["tap", "-x", String(x), "-y", String(y), "--udid", udid], {
            timeoutMs: TIMEOUTS.touch,
          });
        }
      },
    );
  }

  async swipe(udid: string, x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<OsPath> {
    return this.native.gesture(
      udid,
      "swipe",
      (b) => b.swipe(x1, y1, x2, y2, durationMs),
      async () => {
        await this.runner("axe", [
          "swipe", "--start-x", String(x1), "--start-y", String(y1),
          "--end-x", String(x2), "--end-y", String(y2), "--duration", String(durationMs / 1000), "--udid", udid,
        ], { timeoutMs: TIMEOUTS.touch });
      },
    );
  }

  async typeText(udid: string, text: string): Promise<OsPath> {
    // The runner types through testmanagerd inside the simulator: any text,
    // whatever the Mac's layout. The guards below describe limits of `axe type`
    // alone, so they run only when the call is about to take that path.
    return this.native.gesture(udid, "type_text", (b) => b.inputText(text), () => this.axeType(udid, text));
  }

  private async axeType(udid: string, text: string): Promise<void> {
    // Two different corruptions, both of which axe today reports as success.
    // First: axe has no keycode for a non-ASCII character and drops it — the
    // same restriction AndroidDriver.typeText already refuses, for the same
    // reason and in the same shape.
    const bad = [...text].filter((c) => c.codePointAt(0)! < 0x20 || c.codePointAt(0)! > 0x7e);
    if (bad.length > 0) {
      throw new DriverError(
        `iOS \`axe type\` cannot type non-ASCII characters (${JSON.stringify(bad.slice(0, 5).join(""))}). ` +
          `Use via: "js" to set the value through the app's own input handler.`,
      );
    }
    // Second: `axe type` sends key POSITIONS, which the simulator resolves
    // through the host Mac's layout. Plain ASCII that axe sends perfectly well
    // still arrives transliterated. Read every time — see hostKeyboard.ts on
    // why this is not cached.
    const layout = await this.keyboardLayout(this.runner);
    if (!isAsciiSafeLayout(layout)) {
      throw new DriverError(
        `The Mac's active keyboard layout is ${layout}. \`axe type\` sends key positions, so the ` +
          `simulator would receive transliterated text (typing "cat" under RussianWin produces "сф"). ` +
          `Switch the host layout to ABC/U.S., or use via: "js" to bypass the keyboard entirely.`,
      );
    }
    await this.runner("axe", ["type", text, "--udid", udid], { timeoutMs: TIMEOUTS.key });
  }

  // axe works in points, which is exactly what RN measures in.
  async pointScale(): Promise<number> {
    return 1;
  }

  private profile(udid: string): Promise<SimProfile | undefined> {
    let p = profileCache.get(udid);
    if (!p) {
      p = this.readProfile(udid).then(
        (v) => {
          if (!v) profileCache.delete(udid);
          return v;
        },
        () => {
          profileCache.delete(udid);
          return undefined;
        },
      );
      profileCache.set(udid, p);
    }
    return p;
  }

  private async readProfile(udid: string): Promise<SimProfile | undefined> {
    const { stdout: devs } = await this.runner("xcrun", ["simctl", "list", "devices", "--json"], {
      timeoutMs: TIMEOUTS.list,
    });
    const dev = Object.values((JSON.parse(devs) as { devices: Record<string, any[]> }).devices)
      .flat()
      .find((d) => d.udid === udid);
    const typeId: string | undefined = dev?.deviceTypeIdentifier;
    if (!typeId) return undefined;
    const { stdout: types } = await this.runner("xcrun", ["simctl", "list", "devicetypes", "--json"], {
      timeoutMs: TIMEOUTS.list,
    });
    const type = (JSON.parse(types) as { devicetypes: any[] }).devicetypes.find((t) => t.identifier === typeId);
    if (!type?.bundlePath) return undefined;
    const plist = join(type.bundlePath, "Contents", "Resources", "profile.plist");
    const { stdout } = await this.runner("plutil", ["-convert", "json", "-o", "-", plist], {
      timeoutMs: TIMEOUTS.list,
    });
    const p = JSON.parse(stdout);
    if (typeof p.mainScreenScale !== "number" || !(p.mainScreenScale > 0)) return undefined;
    return { scale: p.mainScreenScale, w: Number(p.mainScreenWidth) || 0, h: Number(p.mainScreenHeight) || 0 };
  }

  /** simctl screenshots are at the device scale; axe taps in points. */
  async screenScale(udid: string): Promise<number | undefined> {
    return (await this.profile(udid))?.scale;
  }

  async screenSize(udid: string): Promise<{ w: number; h: number } | undefined> {
    const p = await this.profile(udid);
    return p && p.w > 0 && p.h > 0 ? { w: Math.round(p.w / p.scale), h: Math.round(p.h / p.scale) } : undefined;
  }

  async pressKey(udid: string, key: "back" | "home", opts?: { viewport?: Viewport }): Promise<OsPath> {
    if (key === "home") {
      return this.native.gesture(
        udid,
        "home button",
        (b) => b.pressButton("home"),
        async () => {
          await this.runner("axe", ["button", "home", "--udid", udid], { timeoutMs: TIMEOUTS.key });
        },
      );
    }
    const g = backSwipe(opts?.viewport);
    return this.native.gesture(
      udid,
      "back gesture",
      (b) => b.swipe(g.x1, g.y1, g.x2, g.y2, g.durationMs),
      async () => {
        await this.runner("axe", [
          "swipe", "--start-x", String(g.x1), "--start-y", String(g.y1),
          "--end-x", String(g.x2), "--end-y", String(g.y2), "--duration", String(g.durationMs / 1000), "--udid", udid,
        ], { timeoutMs: TIMEOUTS.touch });
      },
    );
  }

  async launchApp(
    udid: string,
    appId: string,
    opts?: { env?: Record<string, string>; terminateRunning?: boolean },
  ): Promise<void> {
    if (opts?.terminateRunning) {
      await this.runner("xcrun", ["simctl", "terminate", udid, appId], { timeoutMs: TIMEOUTS.launch }).catch(
        () => {},
      );
    }
    const env = opts?.env
      ? Object.fromEntries(Object.entries(opts.env).map(([k, v]) => [`SIMCTL_CHILD_${k}`, v]))
      : undefined;
    await this.runner("xcrun", ["simctl", "launch", udid, appId], {
      env,
      timeoutMs: TIMEOUTS.launch,
      hint: "A cold simulator can take a minute to launch an app.",
    });
  }

  async installApp(udid: string, appPath: string): Promise<void> {
    await this.runner("xcrun", ["simctl", "install", udid, appPath], {
      timeoutMs: TIMEOUTS.install,
      hint: "Large app bundles can take minutes to install.",
    });
  }

  /**
   * Touch-free: LaunchServices in the simulator opens the URL, no touch event is
   * delivered, so this is unaffected by the 17-25s hot-state touch cost.
   *
   * The URL goes straight into the argv array of `execFile` (src/core/exec.ts —
   * `run` uses execFile, never a shell), so it must NOT be quoted or escaped.
   * Adding quotes here would send the quote characters to LaunchServices as part
   * of the URL and the open would fail.
   */
  async openUrl(udid: string, url: string): Promise<void> {
    await this.runner("xcrun", ["simctl", "openurl", udid, url], { timeoutMs: TIMEOUTS.key });
  }

  /**
   * `simctl privacy` takes the *action* first, then the service, then the bundle
   * id: `simctl privacy <device> grant camera com.x.app`. Swapping the two middle
   * arguments fails with an unhelpful usage dump, so the order is asserted in the
   * tests. Given the launch budget rather than the key budget: this rewrites the
   * simulator's TCC database and is not a keystroke-class operation.
   */
  async setPermission(
    udid: string,
    appId: string,
    service: string,
    status: "grant" | "revoke" | "reset",
  ): Promise<void> {
    await this.runner("xcrun", ["simctl", "privacy", udid, status, service, appId], {
      timeoutMs: TIMEOUTS.launch,
      hint: "simctl privacy rewrites the simulator's TCC database and can be slow on a cold device.",
    });
  }

  /**
   * A simulator app is an ordinary process on the host, so the macOS `sample`
   * tool profiles it with nothing installed into the app. Its pid is not in any
   * simctl output: launchctl inside the simulator lists it under the label
   * `UIKitApplication:<bundleId>[hash]`.
   */
  async cpuSample(udid: string, appId: string, durationS: number): Promise<CpuSample> {
    const { stdout: services } = await this.runner("xcrun", ["simctl", "spawn", udid, "launchctl", "list"], {
      timeoutMs: TIMEOUTS.list,
    });
    const pid = parseAppPid(services, appId);
    if (pid === undefined) {
      throw new DriverError(
        `${appId} is not running on ${udid} — the simulator's launchctl lists no UIKitApplication:${appId}.`,
        "Launch it with launch_app, bring it to the foreground, then retry.",
      );
    }
    const { stdout } = await this.runner("sample", [String(pid), String(durationS)], {
      timeoutMs: durationS * 1000 + SAMPLE_SYMBOLICATION_MS,
      hint: "`sample` symbolicates the whole call graph after the sampling window, which takes several seconds more.",
    });
    return { pid, durationS, ...parseSample(stdout) };
  }

  async recordStart(udid: string, localPath: string, opts?: { codec?: "hevc" | "h264" }): Promise<RecordingHandle> {
    const h = this.spawner("xcrun", [
      "simctl", "io", udid, "recordVideo", "--codec", opts?.codec ?? "hevc", "--force", localPath,
    ]);
    await h.assertAlive();
    return {
      finalize: async () => {
        await h.stop("SIGINT");
      },
    };
  }
}
