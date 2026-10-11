import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as defaultRun, TIMEOUTS } from "../core/exec.js";
import { DriverError } from "../core/errors.js";
import { androidArtifact, type AndroidArtifact } from "./artifacts.js";
import { freePort, probeStatus } from "./iosRunner.js";

export type AndroidServerHandle = {
  /** Host port of the adb forward to the server's socket. */
  port: number;
  serial: string;
  /** The server's abstract Unix socket on the device (`rneye-<hex>`, new per start). */
  socket: string;
  via: "reused" | "instrument";
  /**
   * Explicit stop (tests, session shutdown while still starting): remove the
   * forward, force-stop the package (kills the instrumentation), kill the local
   * adb child. A ready server is never stopped at shutdown: it survives the session.
   */
  stop(killAfterMs?: number): Promise<void>;
};

export type AndroidStartOptions = {
  signal?: AbortSignal;
  /** Called right after the instrumentation is spawned, before its 30 s status poll. */
  onSpawn?: (h: AndroidServerHandle) => void;
};

/** The local `adb shell am instrument -w …` child. */
export type InstrumentProcess = {
  /** Tail of everything am/adb printed so far (stdout + stderr). */
  output(): string;
  exited(): boolean;
  /** Detach: our exit no longer waits for, or takes down, the child. */
  release(): void;
  /** SIGTERM to the child's process group, SIGKILL after `killAfterMs` (default 2000). */
  stop(killAfterMs?: number): Promise<void>;
};

export type AndroidServerDeps = {
  run: typeof import("../core/exec.js").run;
  spawnInstrument: (serial: string, shellCommand: string, logPath: string) => InstrumentProcess;
  artifact: () => AndroidArtifact | undefined;
  freePort: () => Promise<number>;
  /** GET /status → version, undefined if nothing (or a 503) answers. */
  probe: (port: number) => Promise<string | undefined>;
  logPath: (serial: string) => string;
  /** A fresh abstract socket name per start (SOCKET_PREFIX + random hex). */
  socketName: () => string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

/**
 * The server listens on an abstract Unix socket, never TCP (review I1): device
 * loopback is shared by every app, a Unix socket is reachable only by name, the
 * server accepts only adbd's uid, and a random name per start cannot be squatted.
 */
export const SOCKET_PREFIX = "rneye-";
/** The app package when no build is at hand (RNE_NATIVE_DRIVER=off still releases it). */
const DEFAULT_APP_PACKAGE = "dev.rneye.server";

const POLL_INTERVAL_MS = 250;
/** Maestro's SERVER_LAUNCH_TIMEOUT_MS. */
const STATUS_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 4;
/** Prompt (D22): the holder is usually a dump that is about to exit, not a broken install. */
const BUSY_RETRY_MS = 1_500;
const SUMMARY_LINES = 4;
const SUMMARY_LINE_CHARS = 300;
/**
 * How much of the instrumentation's log is read. `am instrument -m` ends with
 * a logcat dump of the whole device, often far over 8 KB, and the cause sits
 * before it: an 8 KB tail lost the "already registered" line (field test 3, D22).
 */
const LOG_READ_BYTES = 512 * 1024;
/** What `am instrument` prints when the test could not start (spec "Lifecycle — Android"). */
const START_FAILURE_RE = /FAILED|UNABLE|Error/;
/**
 * UiAutomation is single-tenant: uiautomator dump, Maestro or Appium holds it
 * (`IllegalStateException: UiAutomationService … already registered!`).
 */
const UIAUTOMATION_BUSY_RE = /UiAutomation\w*[^\n]*already registered/;
/** The instrumentation (test package) or its target (app package) is not installed. */
const PACKAGE_MISSING_RE = /Unable to find instrumentation (?:info|target package)/;
/**
 * Replace-by-uninstall cases: another signing key, or (belt and braces next to
 * `install -d`) a newer versionCode left by a newer react-native-eye.
 */
const REINSTALL_RE = /INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match|INSTALL_FAILED_VERSION_DOWNGRADE/i;

/**
 * Spawns `adb -s <serial> shell <shellCommand>` detached (deviation (a) from
 * the spec: not spawnLongRunning, which discards stdout — where `am instrument`
 * reports FAILED/UNABLE — and keeps the child in our process group, while the
 * server must survive the session). stdout and stderr go to `logPath`.
 */
export function spawnInstrument(serial: string, shellCommand: string, logPath: string): InstrumentProcess {
  const fd = openSync(logPath, "w");
  let child: ChildProcess;
  try {
    // detached: its own process group, so a Ctrl-C to the MCP host does not reach it.
    child = spawn("adb", ["-s", serial, "shell", shellCommand], { detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.on("exit", () => ((exited = true), resolve()));
    child.on("error", () => ((exited = true), resolve()));
  });
  const signalGroup = (sig: NodeJS.Signals) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, sig);
    } catch {
      /* already gone */
    }
  };
  return {
    output: () => readInstrumentLog(logPath),
    exited: () => exited,
    release: () => child.unref(),
    stop: async (killAfterMs = 2000) => {
      if (exited) return;
      signalGroup("SIGTERM");
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), killAfterMs).unref());
      if ((await Promise.race([exit, timeout])) === "timeout") signalGroup("SIGKILL");
    },
  };
}

/** The instrumentation's log as text (its last LOG_READ_BYTES); "" when unreadable. */
export function readInstrumentLog(logPath: string): string {
  try {
    return readFileSync(logPath, "latin1").slice(-LOG_READ_BYTES);
  } catch {
    return "";
  }
}

/** `$TMPDIR/rne-android-server-<serial>.log`, the serial made file-safe (`host:port` → `host_port`). */
export function defaultLogPath(serial: string): string {
  return join(tmpdir(), `rne-android-server-${serial.replace(/[^\w.-]/g, "_")}.log`);
}

const DEFAULT_DEPS: AndroidServerDeps = {
  run: defaultRun,
  spawnInstrument,
  artifact: () => androidArtifact(),
  freePort,
  probe: probeStatus,
  logPath: defaultLogPath,
  socketName: () => SOCKET_PREFIX + randomBytes(8).toString("hex"),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const RETRY_HINT = (serial: string) =>
  `Input falls back to adb and the server is retried in 5 minutes. The server's own log: ` +
  `adb -s ${serial} logcat -s RNEye:V AndroidRuntime:E TestRunner:V; to stop using it, set RNE_NATIVE_DRIVER=off.`;

export function instrumentCommand(art: AndroidArtifact, apiLevel: number, socket: string): string {
  return (
    `am instrument -w${apiLevel >= 26 ? " -m" : ""} -e debug false -e class '${art.testClass}' ` +
    `-e socket ${socket} ${art.testRunner}`
  );
}

function adb(d: AndroidServerDeps, serial: string, args: string[], timeoutMs: number = TIMEOUTS.key) {
  return d.run("adb", ["-s", serial, ...args], { timeoutMs });
}

function stopServer(serial: string, port: number, appPackage: string, d: AndroidServerDeps, proc?: InstrumentProcess) {
  return async (killAfterMs?: number) => {
    await proc?.stop(killAfterMs).catch(() => {});
    await adb(d, serial, ["forward", "--remove", `tcp:${port}`]).catch(() => {});
    await adb(d, serial, ["shell", "am", "force-stop", appPackage]).catch(() => {});
  };
}

// `emulator-5554 tcp:49424 localabstract:rneye-0123456789abcdef`
const FORWARD_RE = /^(\S+)\s+tcp:(\d+)\s+localabstract:(rneye-[\w.-]+)\s*$/;

/** This serial's adb forwards to an RNEye server socket: host port and socket name. */
async function serverForwards(serial: string, d: AndroidServerDeps): Promise<{ port: number; socket: string }[] | undefined> {
  let list: string;
  try {
    list = (await adb(d, serial, ["forward", "--list"], TIMEOUTS.list)).stdout;
  } catch {
    return undefined;
  }
  const out: { port: number; socket: string }[] = [];
  for (const line of list.split(/\r?\n/)) {
    const m = FORWARD_RE.exec(line.trim());
    if (m && m[1] === serial) out.push({ port: Number(m[2]), socket: m[3] });
  }
  return out;
}

/**
 * Lifecycle step 1: a server left alive by an earlier session, found through
 * its adb forward to `localabstract:rneye-…`. Stale forwards (nothing or
 * another version answers) are removed on the way.
 */
export async function findLiveAndroidServer(
  serial: string,
  art: AndroidArtifact,
  d: AndroidServerDeps,
): Promise<AndroidServerHandle | undefined> {
  const forwards = await serverForwards(serial, d);
  if (!forwards) return undefined;
  let found: AndroidServerHandle | undefined;
  for (const { port, socket } of forwards) {
    if (!found && (await d.probe(port)) === art.version) {
      found = { port, serial, socket, via: "reused", stop: stopServer(serial, port, art.appPackage, d) };
    } else {
      await adb(d, serial, ["forward", "--remove", `tcp:${port}`]).catch(() => {});
    }
  }
  return found;
}

/**
 * What is installed under `pkg`. `unknown` when the check itself did not
 * finish — adb timed out, or dumpsys ran out of its own 10 s and printed no
 * package section — which on a loaded device is no evidence of a missing or
 * outdated package: reinstalling on it put a full `adb install` of both APKs
 * into a mere restart (field test 3, D27). Only a dumpsys that completed
 * without our package section means `missing`.
 */
type Installed = { state: "installed"; version?: string } | { state: "missing" } | { state: "unknown" };

async function installedVersion(serial: string, pkg: string, d: AndroidServerDeps): Promise<Installed> {
  let stdout: string;
  try {
    ({ stdout } = await adb(d, serial, ["shell", "dumpsys", "package", pkg], TIMEOUTS.list));
  } catch {
    return { state: "unknown" };
  }
  const at = stdout.indexOf(`Package [${pkg}]`);
  if (at >= 0) {
    const section = stdout.slice(at).split(/\n\s*Package \[/)[0];
    return { state: "installed", version: /versionName=(\S+)/.exec(section)?.[1] };
  }
  if (!stdout.trim() || /DUMP TIMEOUT/.test(stdout)) return { state: "unknown" };
  return { state: "missing" };
}

async function install(serial: string, pkg: string, apk: string, d: AndroidServerDeps): Promise<void> {
  const once = async () => {
    // -d: a newer react-native-eye may have left a higher versionCode; our APKs are
    // debuggable, so a downgrade is allowed (review I5).
    const { stdout } = await adb(d, serial, ["install", "-r", "-t", "-d", apk], TIMEOUTS.install);
    if (!/Success/.test(stdout)) throw new Error(stdout.trim() || "adb install printed no Success");
  };
  try {
    try {
      await once();
    } catch (e) {
      if (!REINSTALL_RE.test(messageOf(e))) throw e;
      // An older build signed with another key (or a downgrade -d did not cover): replace it.
      await adb(d, serial, ["uninstall", pkg], TIMEOUTS.install).catch(() => {});
      await once();
    }
  } catch (e) {
    throw new DriverError(
      `Installing the RNEye Android server (${pkg}) on ${serial} failed: ${messageOf(e)}`,
      "On a physical device allow installs over USB (Developer options → Install via USB on Xiaomi/MIUI and similar) " +
        "and check free space; until then input goes through adb.",
    );
  }
}

const apks = (art: AndroidArtifact) => [[art.appPackage, art.appApk], [art.testPackage, art.testApk]] as const;

/**
 * Lifecycle step 2: install each APK whose versionName is missing or
 * different. A package whose check did not finish is left alone (D27); if it
 * really is missing, the instrumentation says so and the start repairs it.
 */
async function installIfNeeded(serial: string, art: AndroidArtifact, d: AndroidServerDeps): Promise<void> {
  for (const [pkg, apk] of apks(art)) {
    const v = await installedVersion(serial, pkg, d);
    if (v.state === "missing" || (v.state === "installed" && v.version !== art.version)) await install(serial, pkg, apk, d);
  }
}

async function apiLevel(serial: string, d: AndroidServerDeps): Promise<number> {
  try {
    return Number((await adb(d, serial, ["shell", "getprop", "ro.build.version.sdk"])).stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/** `adb forward tcp:0` prints the port adb picked (adb ≥ 1.0.36); older adb prints nothing. */
async function forward(serial: string, socket: string, d: AndroidServerDeps): Promise<number> {
  const { stdout } = await adb(d, serial, ["forward", "tcp:0", `localabstract:${socket}`]);
  const port = Number(stdout.trim());
  if (Number.isInteger(port) && port > 0) return port;
  const p = await d.freePort();
  await adb(d, serial, ["forward", `tcp:${p}`, `localabstract:${socket}`]);
  return p;
}

/** `stale`: our fresh socket answered with another version — the installed APKs are not ours. */
type PollResult = "ok" | "stale" | "timeout" | "exited" | "failed" | "aborted";

async function pollStatus(port: number, version: string, d: AndroidServerDeps, proc: InstrumentProcess, signal?: AbortSignal): Promise<PollResult> {
  const deadline = d.now() + STATUS_WAIT_MS;
  for (;;) {
    if (signal?.aborted) return "aborted";
    const answered = await d.probe(port);
    if (answered === version) return "ok";
    if (answered !== undefined) return "stale";
    if (START_FAILURE_RE.test(proc.output())) return "failed";
    if (proc.exited()) return "exited";
    const left = deadline - d.now();
    if (left <= 0) return "timeout";
    await d.sleep(Math.min(POLL_INTERVAL_MS, left));
  }
}

// threadtime logcat, as `am instrument -m` embeds it: `MM-DD HH:MM:SS.mmm [uid] pid tid L tag: message`
const LOGCAT_RE = /^\d\d-\d\d\s+\d\d:\d\d:\d\d\.\d+\s+((?:\d+\s+){2,3})[VDIWEF]\s+(.+?)\s*:\s(.*)$/;
const OUR_TAGS = new Set(["RNEye", "TestRunner", "AndroidRuntime"]);
const EXCEPTION_RE = /\b(?:[a-z]\w*\.)+[A-Z]\w*(?:Exception|Error)\b/;
/** Lines of am's own protocol that name an outcome. */
const AM_LINE_RE = /INSTRUMENTATION_(?:STATUS: (?:Error|shortMsg|longMsg)|RESULT|FAILED|ABORTED)|\b(?:shortMsg|longMsg)\b|UNABLE|Error[:=]/;

/**
 * The instrumentation's own account of why it did not start (D28): am's
 * INSTRUMENTATION_* / shortMsg / longMsg lines and, from the logcat dump that
 * `-m` appends, only lines of our process tagged RNEye, TestRunner or
 * AndroidRuntime — the exception line first. Other processes' logcat (audio,
 * display) is never quoted. "" when nothing names a cause.
 */
export function instrumentationSummary(output: string, appPackage: string = DEFAULT_APP_PACKAGE): string {
  const lines = output
    .replace(/[^\x20-\x7e\n\t]+/g, " ") // `-m` output is protobuf: keep the readable parts
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  /** `body`: the line without its logcat tag or am's `stack` key — what duplicates are told by. */
  type Line = { text: string; body: string; pid?: string; tag?: string };
  const parsed: Line[] = lines.map((l) => {
    const m = LOGCAT_RE.exec(l);
    if (m) {
      const ids = m[1].trim().split(/\s+/);
      return { text: `${m[2]}: ${m[3]}`, body: m[3].trim(), pid: ids[ids.length - 2], tag: m[2] };
    }
    const raw = l.replace(/^[^\w]+/, ""); // protobuf framing leaves stray quotes
    // The test's stack arrives under a `stack` key (protobuf) or as
    // `INSTRUMENTATION_STATUS: stack=…` (text): the key is not part of the cause.
    const stack = /^(?:INSTRUMENTATION_STATUS:\s*)?stack(?:=|\s+)(.*)$/.exec(raw);
    const text = stack ? stack[1].replace(/^[^\w]+/, "") : raw;
    return { text, body: text };
  });
  const ours = new Set<string>();
  const crashed = new RegExp(`Process: ${appPackage.replace(/\./g, "\\.")}, PID: (\\d+)`);
  for (const l of parsed) {
    if (l.tag === "RNEye" || l.tag === "TestRunner") ours.add(l.pid!);
    const m = l.tag === "AndroidRuntime" ? crashed.exec(l.text) : null;
    if (m) ours.add(m[1]);
  }
  // The same line reaches the log twice (am's stack and the logcat dump): once is enough.
  const seen = new Set<string>();
  const relevant = parsed
    .filter((l) => (l.tag ? OUR_TAGS.has(l.tag) && ours.has(l.pid!) : AM_LINE_RE.test(l.text) || EXCEPTION_RE.test(l.text)))
    .filter((l) => !/^(?:at\s|----- (?:begin|end) exception)/.test(l.body))
    .filter((l) => !seen.has(l.body) && seen.add(l.body))
    .map((l) => l.text);
  const exception = relevant.find((t) => EXCEPTION_RE.test(t));
  const picked = [...new Set([...(exception ? [exception] : []), ...relevant.filter((t) => t !== exception).slice(-(SUMMARY_LINES - 1))])];
  return picked
    .slice(0, SUMMARY_LINES)
    .map((t) => (t.length > SUMMARY_LINE_CHARS ? `${t.slice(0, SUMMARY_LINE_CHARS)}…` : t))
    .join(" | ");
}

/**
 * Brings up the Android server (spec "Lifecycle — Android"): reuse → install →
 * force-stop → forward → detached `am instrument` → /status within 30 s. The
 * instrumentation outlives this process on purpose. While another tool holds
 * UiAutomation the launch is retried, up to MAX_ATTEMPTS in all, BUSY_RETRY_MS apart.
 * A restart of packages already at our version only relaunches the
 * instrumentation; both APKs are installed again (once) only when the version
 * check says so, or the instrumentation reports a package missing or answers
 * with another version (D27).
 */
export async function startAndroidServer(
  serial: string,
  deps?: Partial<AndroidServerDeps>,
  opts: AndroidStartOptions = {},
): Promise<AndroidServerHandle> {
  const d: AndroidServerDeps = { ...DEFAULT_DEPS, ...deps };
  const { signal } = opts;
  const aborted = () => new DriverError(`Android server start on ${serial} aborted: the session is shutting down.`);
  const art = d.artifact();
  if (!art) {
    throw new DriverError(
      "Android server not built — build/drivers/manifest.json has no android section, or an APK it names is missing.",
      "Run scripts/build-drivers.sh android (needs JDK 17+ and the Android SDK), then reconnect; until then input goes through adb.",
    );
  }

  const live = await findLiveAndroidServer(serial, art, d);
  if (live) return live;

  if (signal?.aborted) throw aborted();
  await installIfNeeded(serial, art, d);
  if (signal?.aborted) throw aborted();
  const api = await apiLevel(serial, d);

  let last = "";
  let busyTries = 0;
  let repaired = false;
  for (;;) {
    // Stops any stray instrumentation (ours, a crash leftover): UiAutomation is single-tenant.
    await adb(d, serial, ["shell", "am", "force-stop", art.appPackage]).catch(() => {});
    const socket = d.socketName();
    let port: number;
    try {
      port = await forward(serial, socket, d);
    } catch (e) {
      throw new DriverError(
        `Android server did not start on ${serial}: adb forward to localabstract:${socket} failed (${messageOf(e)}).`,
        RETRY_HINT(serial),
      );
    }
    if (signal?.aborted) {
      await stopServer(serial, port, art.appPackage, d)();
      throw aborted();
    }
    const proc = d.spawnInstrument(serial, instrumentCommand(art, api, socket), d.logPath(serial));
    const handle: AndroidServerHandle = { port, serial, socket, via: "instrument", stop: stopServer(serial, port, art.appPackage, d, proc) };
    opts.onSpawn?.(handle);
    const r = await pollStatus(port, art.version, d, proc, signal);
    if (r === "ok") {
      proc.release();
      return handle;
    }
    const output = proc.output();
    const summary = instrumentationSummary(output, art.appPackage);
    await handle.stop();
    if (r === "aborted") throw aborted();
    const busy = UIAUTOMATION_BUSY_RE.test(output);
    const missing = PACKAGE_MISSING_RE.test(output);
    if (busy) busyTries++;
    last =
      r === "timeout"
        ? `no answer on port ${port} within ${STATUS_WAIT_MS / 1000}s`
        : r === "stale"
          ? `the installed server is not version ${art.version}`
          : busy
            ? `another tool holds UiAutomation (uiautomator dump, Maestro, Appium), so the server could not register it (${busyTries} attempt${busyTries === 1 ? "" : "s"})`
            : missing
              ? "the server's packages are not installed on the device"
              : r === "failed" ? "the instrumentation reported a failure" : "the instrumentation exited before answering";
    if (summary) last += `. Instrumentation output: ${summary}`;
    if (busy && busyTries < MAX_ATTEMPTS) {
      await d.sleep(BUSY_RETRY_MS);
      continue;
    }
    // The version check could not see a package that is missing or outdated
    // (it did not finish, D27), or it went away since: install both once and
    // start again.
    if ((missing || r === "stale") && !repaired) {
      repaired = true;
      for (const [pkg, apk] of apks(art)) await install(serial, pkg, apk, d);
      if (signal?.aborted) throw aborted();
      continue;
    }
    break;
  }
  throw new DriverError(`Android server did not start on ${serial}: ${/[.!?]$/.test(last) ? last : `${last}.`}`, RETRY_HINT(serial));
}

/**
 * Releases UiAutomation on `serial` without a handle (review I3): force-stops
 * our package — the instrumentation runs in its process — and removes this
 * serial's forwards to a server socket. Touches nothing but our own package
 * and forwards. Used when the native driver is off (RNE_NATIVE_DRIVER=off),
 * so a server left by an earlier session does not keep `uiautomator dump`
 * (and Maestro, Appium) out. Never throws.
 */
export async function releaseAndroidServer(serial: string, deps?: Partial<AndroidServerDeps>): Promise<void> {
  const d: AndroidServerDeps = { ...DEFAULT_DEPS, ...deps };
  const pkg = d.artifact()?.appPackage ?? DEFAULT_APP_PACKAGE;
  await adb(d, serial, ["shell", "am", "force-stop", pkg]).catch(() => {});
  for (const { port } of (await serverForwards(serial, d)) ?? []) {
    await adb(d, serial, ["forward", "--remove", `tcp:${port}`]).catch(() => {});
  }
}
