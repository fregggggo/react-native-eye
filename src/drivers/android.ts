import { writeFile, rm } from "node:fs/promises";
import { run as defaultRun, spawnLongRunning, TIMEOUTS, type LongRunningHandle } from "../core/exec.js";
import { parseUiautomator } from "../layout/parseUiautomator.js";
import { DriverError, UserInputError } from "../core/errors.js";
import { AdbShell } from "./adbShell.js";
import { sharedPool } from "../native/pool.js";
import { AndroidServerBackend } from "../native/androidBackend.js";
import { NativeCallError } from "../native/httpClient.js";
import type { NativeBackend } from "../native/nativeBackend.js";
import { NativePath, type RunnerPool } from "./nativePath.js";
import { parseTopThreads } from "../perf/parseTop.js";
import { parseGfxinfo } from "../perf/parseGfxinfo.js";
import { appWindowState, WINDOW_DUMP_CMD } from "./androidWindow.js";
import type { CpuSample, DeviceDriver, DeviceId, FrameStats, OsPath, RawElement, RecordingHandle } from "./types.js";

type Runner = typeof defaultRun;
type Spawner = (cmd: string, args: string[], opts?: { env?: Record<string, string> }) => LongRunningHandle;
type ShellLike = { exec(cmd: string, opts?: { timeoutMs?: number }): Promise<string> };
const KEYEVENT: Record<"back" | "home", string> = { back: "4", home: "3" };
const EMPTY_HIERARCHY_RETRY_MS = 400;
/**
 * How long an OS layout waits for a server start in flight rather than race
 * `uiautomator dump` against it (D22): one start attempt's 30 s /status
 * window plus its force-stop, forward and version checks.
 */
export const ANDROID_START_WAIT_MS = 45_000;

// Exported so test/drivers/android.test.ts and test/tools/layout.test.ts build
// their fixtures from the same string `rawLayout` actually throws below,
// instead of a hand-typed copy that can silently drift from production wording.
export const UIAUTOMATOR_JS_RECOMMENDATION =
  'Use source:"js": the app-runtime layout does not need an idle screen.';

/**
 * What `uiautomator dump` prints while another process holds UiAutomation —
 * in practice our own server (native/android-server): `Killed` on API 36 (T9),
 * "UiAutomationService … already registered" on others (T1). `: Killed` is
 * the same output inside exec's "adb failed: …" when adb does report the exit.
 */
const UIAUTOMATION_HELD_RE = /(?:^|: )Killed\b|already registered/m;
const SERVER_PACKAGE = "dev.rneye.server";

// Everything sent to `adb shell` is interpreted by the device's sh, whether it
// goes through the persistent shell or through `adb -s X shell ...` (which also
// concatenates its arguments and runs them through sh). Single-quoting the whole
// argument is the only thing that keeps `;`, `&&`, backticks and `$(...)` in
// user-supplied text from executing on the device.
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// `pm grant` takes an Android permission string, not the platform-neutral service
// name the tool exposes. Only the runtime permissions an RN app actually asks for
// are listed; an unlisted name is refused by name rather than passed through to
// `pm`, which reports "Unknown permission" on stderr while still exiting 0 on some
// devices — i.e. it would look like success.
const ANDROID_PERMISSIONS: Record<string, string> = {
  camera: "android.permission.CAMERA",
  microphone: "android.permission.RECORD_AUDIO",
  photos: "android.permission.READ_MEDIA_IMAGES",
  location: "android.permission.ACCESS_FINE_LOCATION",
  contacts: "android.permission.READ_CONTACTS",
  notifications: "android.permission.POST_NOTIFICATIONS",
};

// Android has no zero-install way to read native stacks out of a running app
// (simpleperf needs the NDK on the host and a debuggable build), so a CPU
// sample here is thread-level only. Saying so is part of the answer: an agent
// that sees "js 70%" with no frames must not go looking for a missing section.
export const ANDROID_CPU_NOTE =
  "Android reports per-thread %CPU only — no native stack frames. For JS-level frames, profile Hermes from the debugger.";

const densityCache = new Map<string, number>();
const sharedShells = new Map<string, AdbShell>();
function defaultShellFor(serial: string): ShellLike {
  let s = sharedShells.get(serial);
  if (!s) {
    s = new AdbShell(serial);
    sharedShells.set(serial, s);
  }
  return s;
}

export class AndroidDriver implements DeviceDriver {
  readonly platform = "android" as const;
  private native: NativePath;

  constructor(
    private runner: Runner = defaultRun,
    private spawner: Spawner = spawnLongRunning,
    private shellFor: (serial: string) => ShellLike = defaultShellFor,
    // The on-device server (native/android-server). activeDriver builds a
    // fresh AndroidDriver per tool call; the pool lives for the whole session.
    pool: RunnerPool = sharedPool(),
  ) {
    // Every hand-out of a server first gives the user their keyboard back if
    // a previous host died mid-type (I4); the backend does that once per
    // server generation, in the background.
    const repairing: RunnerPool = {
      get: (platform, id) => {
        const b = pool.get(platform, id);
        if (b instanceof AndroidServerBackend) void b.repairKeyboard();
        return b;
      },
      view: (platform, id) => pool.view(platform, id),
      markDead: (platform, id, reason, from) => pool.markDead(platform, id, reason, from),
      markFailed: (platform, id, reason, from) => pool.markFailed(platform, id, reason, from),
      settled: (platform, id) => pool.settled?.(platform, id),
    };
    this.native = new NativePath(repairing, "android", "Android server", "adb");
  }

  private async input(udid: string, args: string[], kind: "touch" | "key" = "touch"): Promise<void> {
    const timeoutMs = kind === "touch" ? TIMEOUTS.touch : TIMEOUTS.key;
    const cmd = `input ${args.map(shellQuote).join(" ")}`;
    try {
      await this.shellFor(udid).exec(cmd, { timeoutMs });
    } catch (err) {
      // Retry through a one-shot adb only when the persistent shell itself broke.
      // A non-zero exit from `input` is a real failure and must be reported, not
      // retried into a double tap / double-typed text.
      const msg = err instanceof Error ? err.message : String(err);
      if (!/died|write failed|timed out/i.test(msg)) throw err;
      try {
        await this.runner("adb", ["-s", udid, "shell", cmd], { timeoutMs });
      } catch (fallbackErr) {
        // exec.ts's own message for this call names only `adb -s` (args[0]),
        // which loses which `input` command was in flight — reattach it here.
        const fmsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        throw new DriverError(`adb -s ${udid} shell \`${cmd}\` failed: ${fmsg}`);
      }
    }
  }

  async listDevices(): Promise<DeviceId[]> {
    const { stdout } = await this.runner("adb", ["devices", "-l"], { timeoutMs: TIMEOUTS.list });
    return stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line && line.includes("device"))
      .map((line) => {
        const udid = line.split(/\s+/)[0];
        const modelMatch = line.match(/model:(\S+)/);
        return { platform: "android" as const, udid, name: modelMatch?.[1] ?? udid, booted: true };
      });
  }

  async screenshotPng(udid: string): Promise<Buffer> {
    // Which path produced a screenshot is not reported anywhere, so a server
    // failure falls back silently; the pool still learns about it.
    const { backend } = this.native.backendFor(udid);
    if (backend) {
      try {
        return await backend.screenshot();
      } catch (err) {
        this.native.readFailure(udid, backend, err);
      }
    }
    const { stdoutBuffer } = await this.runner("adb", ["-s", udid, "exec-out", "screencap", "-p"], {
      timeoutMs: TIMEOUTS.screenshot,
    });
    return stdoutBuffer;
  }

  async screenshotFile(udid: string, path: string, opts: { format: "png" | "jpeg" }): Promise<void> {
    const png = await this.screenshotPng(udid);
    if (opts.format === "png") {
      await writeFile(path, png);
      return;
    }
    if (process.platform !== "darwin") {
      throw new DriverError(
        "jpeg output needs `sips`, which only exists on macOS — use format:'png' on this platform.",
      );
    }
    const tmp = `${path}.rne-tmp.png`;
    await writeFile(tmp, png);
    try {
      await this.runner("sips", ["-s", "format", "jpeg", tmp, "--out", path], { timeoutMs: TIMEOUTS.screenshot });
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async rawLayout(udid: string): Promise<{ els: RawElement[]; os: OsPath }> {
    // `uiautomator dump` registers UiAutomation, and so does the server's
    // instrumentation: a dump during the start kills the start (D22). So a
    // start in flight is waited for; gestures (adb `input`) need not wait.
    const stillStarting = () =>
      new DriverError(
        `The Android server is still starting on ${udid} (waited ${ANDROID_START_WAIT_MS / 1000}s), and ` +
          `\`uiautomator dump\` would break that start — only one UiAutomation client can exist at a time.`,
        `Retry in a moment. ${UIAUTOMATOR_JS_RECOMMENDATION}`,
      );
    const first = await this.native.backendAfterStart(udid, ANDROID_START_WAIT_MS);
    if (first.pending) throw stillStarting();
    let why = first.reason;
    let backend = first.backend;
    for (let read = 1; backend; read++) {
      const r = await this.serverLayout(udid, backend);
      if ("els" in r) return r;
      why = r.why;
      // This very call found the server dead, and the pool is already
      // restarting it: the dump would race that start exactly as above (D32).
      // A read is safe to repeat, so wait and read from the fresh server —
      // once; the dump is for a restart that failed or was never begun.
      const next = await this.native.backendAfterStart(udid, ANDROID_START_WAIT_MS);
      if (next.pending) throw stillStarting();
      if (!next.backend) {
        why = next.reason ?? why;
        break;
      }
      // Same backend: the pool did not write it off (a rejected or unknown
      // failure with /status silent) — today's fallback.
      if (next.backend === backend) break;
      if (read >= 2) {
        throw new DriverError(
          `The Android server could not read the view hierarchy twice in a row (${why}) and has been restarted again, so ` +
            `\`uiautomator dump\` cannot run either — only one UiAutomation client can exist at a time.`,
          `Retry in a moment. ${UIAUTOMATOR_JS_RECOMMENDATION}`,
        );
      }
      backend = next.backend;
    }
    const els = await this.dumpLayout(udid, why);
    return { els, os: this.native.osPath(why) };
  }

  /**
   * The server's hierarchy, or why to fall back to `uiautomator dump`. The dump
   * cannot run while the server holds UiAutomation (T1, T9: it is killed), so
   * it is only worth trying once the server is known to be gone: refused, or
   * /status no longer answers. A server that answered with a screen that has
   * nothing labelled (a splash, a video, a bare spinner) is an empty screen,
   * not a failure.
   */
  private async serverLayout(
    udid: string,
    backend: NativeBackend,
  ): Promise<{ els: RawElement[]; os: OsPath } | { why: string }> {
    try {
      let xml = "";
      // Same rule as iOS: a transition can leave the tree momentarily without
      // any node at all; one short retry. Counted on raw nodes, not labelled
      // elements — an unlabelled screen is a real answer.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, EMPTY_HIERARCHY_RETRY_MS));
        const answer = (await backend.hierarchy()) as { hierarchy?: unknown } | undefined;
        if (typeof answer?.hierarchy !== "string") {
          throw new NativeCallError("rejected", "its /viewHierarchy answer carries no hierarchy");
        }
        xml = answer.hierarchy;
        if (/<node\b/.test(xml)) break;
      }
      return { els: parseUiautomator(xml), os: { path: "runner" } };
    } catch (err) {
      const why = this.native.readFailure(udid, backend, err);
      if (err instanceof NativeCallError && err.kind === "refused") return { why };
      const alive = await backend.status().then(
        () => true,
        () => false,
      );
      if (!alive) return { why };
      throw new DriverError(
        `The Android server could not read the view hierarchy (${why}), and it is still running, so ` +
          `\`uiautomator dump\` cannot either — only one UiAutomation client can exist at a time.`,
        `Retry in a moment. ${UIAUTOMATOR_JS_RECOMMENDATION}`,
      );
    }
  }

  /**
   * `uiautomator dump`, the pre-server path (field test D19 handling kept
   * verbatim). `why`: the reason the server was not used, for the error of a
   * dump that cannot take UiAutomation either.
   */
  private async dumpLayout(udid: string, why?: string): Promise<RawElement[]> {
    // uiautomator prints its complaint on stdout and still exits 0, so the exit
    // code says nothing: "ERROR: could not get idle state." reached the parser
    // as zero nodes and was reported as an empty screen (field test D19). RN
    // screens animate almost always, so one retry is worth its cost.
    let last = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      let stdout: string;
      try {
        ({ stdout } = await this.runner("adb", ["-s", udid, "exec-out", "uiautomator", "dump", "/dev/tty"], {
          timeoutMs: TIMEOUTS.layout,
          hint: "uiautomator can be slow while the screen is animating.",
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!UIAUTOMATION_HELD_RE.test(msg)) throw err;
        stdout = msg;
      }
      last = stdout;
      if (/<hierarchy|<node\b/.test(stdout)) return parseUiautomator(stdout);
      // Held by another UiAutomation client: a second try fails the same way.
      if (UIAUTOMATION_HELD_RE.test(stdout)) break;
    }
    const first = last.trim().split("\n")[0] || "(no output)";
    if (UIAUTOMATION_HELD_RE.test(last)) {
      // What happened, plainly: why our server was not used, and what the
      // fallback said. Who holds UiAutomation is not known here — a leftover
      // server of ours or another tool; `why` usually tells.
      const held = `another process holds UiAutomation on ${udid}.`;
      throw new DriverError(
        why
          ? `The RNEye Android server was not available (${why.replace(/[.\s]+$/, "")}), and the fallback \`uiautomator dump\` failed too (${first}): ${held}`
          : `uiautomator dump could not run (${first}): ${held}`,
        `${UIAUTOMATOR_JS_RECOMMENDATION} If another tool is using the device (a running uiautomator dump, Maestro, Appium), ` +
          `stop it; if a leftover RNEye server holds it, \`adb -s ${udid} shell am force-stop ${SERVER_PACKAGE}\` releases ` +
          `UiAutomation (the next call starts the server again unless RNE_NATIVE_DRIVER=off).`,
      );
    }
    throw new DriverError(
      `uiautomator returned no view hierarchy: ${first}. The screen most likely never went idle ` +
        `(an animation, a video, a spinner) — this is the normal state of a React Native screen.`,
      UIAUTOMATOR_JS_RECOMMENDATION,
    );
  }

  async tapXY(udid: string, x: number, y: number, durationMs?: number): Promise<OsPath> {
    const hold = durationMs && durationMs > 0 ? durationMs : undefined;
    return this.native.gesture(udid, hold ? "long press" : "tap", (b) => b.touch(x, y, hold), async () => {
      if (hold) await this.input(udid, ["swipe", String(x), String(y), String(x), String(y), String(hold)]);
      else await this.input(udid, ["tap", String(x), String(y)]);
    });
  }

  async swipe(udid: string, x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<OsPath> {
    return this.native.gesture(udid, "swipe", (b) => b.swipe(x1, y1, x2, y2, durationMs), async () => {
      await this.input(udid, ["swipe", String(x1), String(y1), String(x2), String(y2), String(durationMs)]);
    });
  }

  async typeText(udid: string, text: string): Promise<OsPath> {
    // The server types ASCII with key codes and everything else through its own
    // IME (native/android-server), so the ASCII guard below applies to the adb
    // path only.
    return this.native.gesture(udid, "type_text", (b) => b.inputText(text), (why) => this.adbType(udid, text, why));
  }

  private async adbType(udid: string, text: string, why?: string): Promise<void> {
    // `input text` is ASCII-only: anything else is dropped by the device while
    // the command still reports success, so refuse instead of lying.
    const bad = [...text].filter((c) => c.codePointAt(0)! < 0x20 || c.codePointAt(0)! > 0x7e);
    if (bad.length > 0) {
      throw new DriverError(
        `Android \`input text\` cannot type non-ASCII characters (${JSON.stringify(bad.slice(0, 5).join(""))})` +
          (why ? `, and the on-device server that can is not in use (${why}).` : ".") +
          ` Set the value directly with eval_js${why ? ", or retry once connect reports the native driver ready" : ""}.`,
      );
    }
    await this.input(udid, ["text", text], "key");
  }

  async pressKey(udid: string, key: "back" | "home"): Promise<OsPath> {
    return this.native.gesture(udid, `${key} key`, (b) => b.pressKey(key), async () => {
      await this.input(udid, ["keyevent", KEYEVENT[key]], "key");
    });
  }

  async pointScale(udid: string): Promise<number> {
    const cached = densityCache.get(udid);
    if (cached) return cached;
    try {
      const { stdout } = await this.runner("adb", ["-s", udid, "shell", "wm", "density"], {
        timeoutMs: TIMEOUTS.list,
      });
      // An override (`wm density 420`) is what the app lays out with; the
      // physical density is printed first and would be the wrong scale.
      const m = /Override density:\s*(\d+)/i.exec(stdout) ?? /density:\s*(\d+)/i.exec(stdout);
      const scale = m ? Number(m[1]) / 160 : 1;
      densityCache.set(udid, scale);
      return scale;
    } catch {
      return 1;
    }
  }

  /**
   * RN's measureInWindow is relative to the app window's visible display
   * frame, which on an edge-to-edge window starts below the status bar
   * (field test 3 D23: every JS rect was 144 px too high). Read from
   * `dumpsys window` through the persistent shell, so it works on the adb
   * path and never touches UiAutomation; cached by src/layout/appSpace.ts.
   */
  async appOrigin(udid: string): Promise<{ x: number; y: number; overlayWindow?: boolean } | undefined> {
    try {
      return appWindowState(await this.shellFor(udid).exec(WINDOW_DUMP_CMD, { timeoutMs: TIMEOUTS.list }));
    } catch {
      return undefined;
    }
  }

  /** `input tap` and `screencap` both speak physical pixels. */
  async screenScale(): Promise<number> {
    return 1;
  }

  async screenSize(udid: string): Promise<{ w: number; h: number } | undefined> {
    try {
      const { stdout } = await this.runner("adb", ["-s", udid, "shell", "wm", "size"], {
        timeoutMs: TIMEOUTS.list,
      });
      const m = /(\d+)x(\d+)/.exec(stdout);
      return m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * `cmd package resolve-activity --brief` prints the launchable component as
   * the last line ("pkg/.MainActivity"). When the device answers with
   * anything else — or the command itself throws (ENOENT, timeout, device
   * drop) — the caller falls back to `monkey`. That fallback can *also* fail
   * (field test D21: exit 251 on API 36), and when it does, the caller must
   * not be handed only monkey's complaint: `failureReason` carries why the
   * primary path never got a usable activity, so a compound failure names
   * both causes instead of silently dropping the first one.
   */
  private async launchActivity(
    udid: string,
    appId: string,
  ): Promise<{ activity?: string; failureReason?: string }> {
    try {
      const { stdout } = await this.runner(
        "adb",
        ["-s", udid, "shell", `cmd package resolve-activity --brief ${shellQuote(appId)}`],
        { timeoutMs: TIMEOUTS.launch },
      );
      const last = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      if (last && last.includes("/") && !/\s/.test(last)) return { activity: last };
      return {
        failureReason: `resolve-activity did not return a launchable component: ${last ?? "(no output)"}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { failureReason: `resolve-activity failed: ${msg}` };
    }
  }

  async launchApp(
    udid: string,
    appId: string,
    opts?: { env?: Record<string, string>; terminateRunning?: boolean },
  ): Promise<void> {
    if (opts?.env && Object.keys(opts.env).length > 0) {
      throw new DriverError("Launch env vars are not supported on Android.");
    }
    if (opts?.terminateRunning) {
      await this.runner("adb", ["-s", udid, "shell", "am", "force-stop", shellQuote(appId)], {
        timeoutMs: TIMEOUTS.launch,
      }).catch(() => {});
    }
    // `monkey` exits 251 on API 36 without starting anything (field test D21).
    // The proper launch is the resolved activity; monkey stays only as the
    // fallback for a device whose package service does not answer.
    const { activity, failureReason } = await this.launchActivity(udid, appId);
    if (activity) {
      const { stdout } = await this.runner("adb", ["-s", udid, "shell", `am start -n ${shellQuote(activity)}`], {
        timeoutMs: TIMEOUTS.launch,
        hint: "Launching on a cold emulator can take a while.",
      });
      // `am start` prints its failure and still exits 0.
      const failure = /^Error:.*$/m.exec(stdout);
      if (failure) throw new DriverError(`am start ${activity} failed: ${failure[0]}`);
      return;
    }
    try {
      await this.runner(
        "adb",
        ["-s", udid, "shell", `monkey -p ${shellQuote(appId)} -c android.intent.category.LAUNCHER 1`],
        { timeoutMs: TIMEOUTS.launch, hint: "Launching on a cold emulator can take a while." },
      );
    } catch (err) {
      // A resolve failure that monkey papers over must stay silent (no
      // warning, no noise, on a device where this fallback works fine) — this
      // catch only fires once monkey has also failed, so both causes are
      // named here, never on the success path above.
      const monkeyMsg = err instanceof Error ? err.message : String(err);
      if (failureReason) {
        throw new DriverError(
          `Could not resolve a launchable activity for ${appId} (${failureReason}), and the monkey fallback also failed: ${monkeyMsg}`,
          "Confirm the app is installed (install_app) and the device is reachable (list_devices), then retry.",
        );
      }
      throw err;
    }
  }

  async installApp(udid: string, appPath: string): Promise<void> {
    await this.runner("adb", ["-s", udid, "install", "-r", appPath], {
      timeoutMs: TIMEOUTS.install,
      hint: "Large APKs can take minutes to install.",
    });
  }

  /**
   * Unlike the iOS path, this one IS interpreted by a shell: adb concatenates
   * everything after `shell` and hands the result to the device's sh (see the
   * shellQuote comment at the top of this file). A URL is user-supplied text, so
   * it goes through shellQuote — without it, `myapp://x; reboot` runs `reboot`
   * on the device. Do not "simplify" this by splitting the command into separate
   * adb arguments: adb rejoins them and sh still sees the `;`.
   */
  async openUrl(udid: string, url: string): Promise<void> {
    await this.runner(
      "adb",
      ["-s", udid, "shell", `am start -a android.intent.action.VIEW -d ${shellQuote(url)}`],
      { timeoutMs: TIMEOUTS.key },
    );
  }

  async setPermission(
    udid: string,
    appId: string,
    service: string,
    status: "grant" | "revoke" | "reset",
  ): Promise<void> {
    // `pm reset-permissions` takes no package: it resets runtime permissions for
    // every app on the device. The service name is meaningless here, so it is not
    // validated — the tool layer states what the command actually did.
    if (status === "reset") {
      await this.runner("adb", ["-s", udid, "shell", "pm reset-permissions"], {
        timeoutMs: TIMEOUTS.launch,
      });
      return;
    }
    const permission = ANDROID_PERMISSIONS[service];
    if (!permission) {
      throw new UserInputError(
        `Unknown permission service "${service}" on Android. Known: ${Object.keys(ANDROID_PERMISSIONS).join(", ")}.`,
      );
    }
    await this.runner(
      "adb",
      ["-s", udid, "shell", `pm ${status} ${shellQuote(appId)} ${shellQuote(permission)}`],
      { timeoutMs: TIMEOUTS.launch },
    );
  }

  private async appPid(udid: string, appId: string): Promise<number> {
    const out = await this.shellFor(udid)
      .exec(`pidof ${shellQuote(appId)}`, { timeoutMs: TIMEOUTS.list })
      .catch(() => "");
    // `pidof` prints every matching pid (an app with a :remote process has
    // several); the first is the main one, and an empty answer means the app is
    // simply not running — `pidof` exits non-zero for that, hence the catch.
    const pid = Number(out.trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new DriverError(
        `${appId} is not running on ${udid} — pidof found no process.`,
        "Launch it with launch_app, then retry.",
      );
    }
    return pid;
  }

  async cpuSample(udid: string, appId: string, durationS: number): Promise<CpuSample> {
    const pid = await this.appPid(udid, appId);
    // -n 2 with -d <window>: the first iteration's %CPU is measured over a
    // window `top` chose for itself (near-zero on a fresh process), only the
    // second covers the seconds the caller asked about.
    const out = await this.shellFor(udid).exec(`top -H -p ${pid} -d ${durationS} -n 2 -b`, {
      timeoutMs: durationS * 1000 + TIMEOUTS.list,
    });
    return { pid, durationS, ...parseTopThreads(out, pid), note: ANDROID_CPU_NOTE };
  }

  /**
   * gfxinfo counts frames the app actually produced between `reset` and the
   * read, which is why the window is a real wait rather than a parameter to
   * dumpsys: there is no "collect for N ms" mode, only "since the last reset".
   */
  async frameStats(udid: string, appId: string, durationMs: number): Promise<FrameStats> {
    const shell = this.shellFor(udid);
    await shell.exec(`dumpsys gfxinfo ${shellQuote(appId)} reset`, { timeoutMs: TIMEOUTS.list });
    await new Promise((r) => setTimeout(r, durationMs));
    const out = await shell.exec(`dumpsys gfxinfo ${shellQuote(appId)} framestats`, {
      timeoutMs: TIMEOUTS.list,
    });
    return { durationMs, ...parseGfxinfo(out) };
  }

  async recordStart(udid: string, localPath: string): Promise<RecordingHandle> {
    const devicePath = "/sdcard/rne-recording.mp4";
    const h = this.spawner("adb", ["-s", udid, "shell", "screenrecord", devicePath]);
    await h.assertAlive();
    return {
      finalize: async () => {
        await this.runner("adb", ["-s", udid, "shell", "pkill", "-2", "screenrecord"], {
          timeoutMs: TIMEOUTS.list,
        }).catch(() => {});
        await h.stop("SIGINT").catch(() => {});
        await new Promise((r) => setTimeout(r, 500)); // let the device finalize the mp4
        await this.runner("adb", ["-s", udid, "pull", devicePath, localPath], { timeoutMs: TIMEOUTS.install });
        await this.runner("adb", ["-s", udid, "shell", "rm", devicePath], { timeoutMs: TIMEOUTS.list }).catch(
          () => {},
        );
      },
    };
  }
}
