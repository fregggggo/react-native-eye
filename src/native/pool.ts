import { IosRunnerBackend } from "./iosBackend.js";
import { startIosRunner, type RunnerHandle, type StartOptions } from "./iosRunner.js";
import { AndroidServerBackend } from "./androidBackend.js";
import { releaseAndroidServer, startAndroidServer, type AndroidServerHandle, type AndroidStartOptions } from "./androidServer.js";
import type { NativeBackend } from "./nativeBackend.js";

export type PoolState = "starting" | "ready" | "dead" | "failed";

type AnyHandle = RunnerHandle | AndroidServerHandle;

/** `startedMs`: how long the start that made the entry ready took. */
export type PoolEntryView = { state: PoolState; reason?: string; via?: AnyHandle["via"]; startedMs?: number };

type Platform = "ios" | "android";

type Entry = {
  state: PoolState;
  reason?: string;
  via?: AnyHandle["via"];
  startedMs?: number;
  /** When the entry last became `failed` — the retry window counts from here. */
  failedAt?: number;
  /**
   * The runner generation the entry currently hands out. A new object per
   * start, so a failure report carrying an older backend (a call that began
   * on a runner since replaced or already declared dead) is recognisably
   * stale: markDead / markFailed compare identities and ignore it.
   */
  backend?: NativeBackend;
  handle?: AnyHandle;
  /** The one start in flight; every concurrent warm() shares it. */
  inflight?: Promise<PoolEntryView>;
};

type PoolDeps = {
  startIos?: (udid: string, opts: StartOptions) => Promise<RunnerHandle>;
  makeIosBackend?: (port: number) => NativeBackend;
  startAndroid?: (serial: string, opts: AndroidStartOptions) => Promise<AndroidServerHandle>;
  makeAndroidBackend?: (port: number, serial: string) => NativeBackend;
  /** Force-stops a server this session holds no handle to (RNE_NATIVE_DRIVER=off). */
  releaseAndroid?: (serial: string) => Promise<void>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  retryAfterMs?: number;
};

const DISABLED = "disabled (RNE_NATIVE_DRIVER=off)";

/** A runner that dies this often is hung, not restarting — stop paying its timeouts. */
const FLAP_WINDOW_MS = 60_000;
const FLAP_LIMIT = 2;

/** Default SIGINT→SIGKILL window for xcodebuild children at shutdown. */
const SHUTDOWN_KILL_AFTER_MS = 2000;
const SHUT_DOWN = "native pool shut down";

/**
 * Children that must not outlive the session: an xcodebuild-launched iOS
 * runner (ready or not). A ready Android server is deliberately left running
 * (spec "Session shutdown"); only its start while in flight is a session child.
 */
const diesWithSession = (h: AnyHandle) => h.via === "xcodebuild";

function toView(e: Entry): PoolEntryView {
  const v: PoolEntryView = { state: e.state };
  if (e.reason !== undefined) v.reason = e.reason;
  if (e.via !== undefined) v.via = e.via;
  if (e.startedMs !== undefined) v.startedMs = e.startedMs;
  return v;
}

/**
 * The marker reason for a device whose runner is not usable right now
 * (OsPath.reason): `runner starting` or `runner <state>: <reason>`.
 */
export function notReadyReason(view: PoolEntryView | undefined): string {
  if (!view || view.state === "starting") return "runner starting";
  return `runner ${view.state}: ${view.reason ?? "no reason recorded"}`;
}

/**
 * One on-device runner per (platform, device) for the life of the MCP server
 * process — the iOS XCTest runner or the Android instrumentation server, keyed
 * `ios:<udid>` / `android:<serial>`. Nothing here blocks a tool call: get()
 * hands out a backend only when the entry is ready and otherwise kicks off a
 * start in the background, so the caller takes the axe/adb path meanwhile.
 * The pool stops an xcodebuild-launched iOS runner; a ready Android server
 * survives a first markDead and shutdown (a later re-warm's `am force-stop`
 * replaces it) but is stopped when its entry goes `failed` (markFailed, flap)
 * and released under RNE_NATIVE_DRIVER=off, so it never holds UiAutomation
 * while nothing uses it.
 */
export class NativePool {
  private entries = new Map<string, Entry>();
  /** Children to stop at shutdown: xcodebuild runners, and any handle a start in flight has spawned. */
  private sessionChildren = new Set<AnyHandle>();
  /** Recent markDead timestamps per key, for the flap rule (RF-2). */
  private deaths = new Map<string, number[]>();
  private closed = false;
  /** Aborted by shutdown(): every start in flight stops before its next step. */
  private abort = new AbortController();
  private startIos: (udid: string, opts: StartOptions) => Promise<RunnerHandle>;
  private makeIosBackend: (port: number) => NativeBackend;
  private startAndroid: (serial: string, opts: AndroidStartOptions) => Promise<AndroidServerHandle>;
  private makeAndroidBackend: (port: number, serial: string) => NativeBackend;
  private releaseAndroid: (serial: string) => Promise<void>;
  /** Keys whose Android server the kill switch has already released (once per process). */
  private released = new Set<string>();
  private now: () => number;
  private env: NodeJS.ProcessEnv;
  private retryAfterMs: number;

  constructor(deps: PoolDeps = {}) {
    this.startIos = deps.startIos ?? ((udid, opts) => startIosRunner(udid, undefined, opts));
    this.makeIosBackend = deps.makeIosBackend ?? ((port) => new IosRunnerBackend(port));
    this.startAndroid = deps.startAndroid ?? ((serial, opts) => startAndroidServer(serial, undefined, opts));
    this.makeAndroidBackend = deps.makeAndroidBackend ?? ((port, serial) => new AndroidServerBackend(port, serial));
    this.releaseAndroid = deps.releaseAndroid ?? ((serial) => releaseAndroidServer(serial));
    this.now = deps.now ?? (() => Date.now());
    this.env = deps.env ?? process.env;
    this.retryAfterMs = deps.retryAfterMs ?? 300_000;
  }

  private key(platform: Platform, udid: string): string {
    return `${platform}:${udid}`;
  }

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { state: "starting" };
      this.entries.set(key, e);
    }
    return e;
  }

  private retryDue(e: Entry): boolean {
    return e.failedAt === undefined || this.now() - e.failedAt >= this.retryAfterMs;
  }

  /**
   * Stops a handle that must not outlive the session and forgets it; others
   * are left running unless `stop` — an Android server on its way to `failed`,
   * which would otherwise hold UiAutomation (and break `uiautomator dump`, the
   * layout fallback) for the whole retry window (review I3).
   */
  private dropHandle(e: Entry, stop = false): void {
    if (e.handle && (stop || diesWithSession(e.handle))) {
      this.sessionChildren.delete(e.handle);
      void e.handle.stop().catch(() => {});
    }
    e.handle = undefined;
  }

  private setFailed(e: Entry, reason: string): PoolEntryView {
    e.state = "failed";
    e.reason = reason;
    e.failedAt = this.now();
    e.backend = undefined;
    e.via = undefined;
    e.startedMs = undefined;
    return toView(e);
  }

  get(platform: Platform, udid: string): NativeBackend | undefined {
    const e = this.entries.get(this.key(platform, udid));
    if (e?.state === "ready") return e.backend;
    if (!e || (!e.inflight && (e.state !== "failed" || this.retryDue(e)))) void this.warm(platform, udid);
    return undefined;
  }

  /**
   * Start (or reuse) the runner; concurrent callers share one start. Not
   * `async` on purpose: the entry is updated and startIos is called before
   * this returns, so a get() right after sees `starting`.
   */
  warm(platform: Platform, udid: string): Promise<PoolEntryView> {
    const key = this.key(platform, udid);
    // A tool call during the shutdown grace window must not launch anything.
    if (this.closed) return Promise.resolve(this.setFailed(this.entry(key), SHUT_DOWN));
    if (this.env.RNE_NATIVE_DRIVER === "off") return this.disabled(key, platform, udid);
    const e = this.entries.get(key);
    if (e?.inflight) return e.inflight;
    if (e?.state === "ready") return Promise.resolve(toView(e));
    if (e?.state === "failed" && !this.retryDue(e)) return Promise.resolve(toView(e));
    return this.start(key, platform, udid);
  }

  /**
   * The kill switch. On Android it also force-stops a server an earlier session
   * left running (once per device per process): the switch promises today's
   * behaviour, and today's layout path, `uiautomator dump`, cannot run while
   * our server holds UiAutomation (review I3). This is the one device action
   * the switch takes, and it touches only our own package.
   */
  private disabled(key: string, platform: Platform, udid: string): Promise<PoolEntryView> {
    const view = this.setFailed(this.entry(key), DISABLED);
    if (platform !== "android" || this.released.has(key)) return Promise.resolve(view);
    this.released.add(key);
    return this.releaseAndroid(udid).then(
      () => view,
      () => view,
    );
  }

  private start(key: string, platform: Platform, udid: string): Promise<PoolEntryView> {
    const e = this.entry(key);
    // A dead entry keeps its state and reason while it re-warms, so the
    // fallback marker says why the runner went away rather than "starting".
    if (e.state !== "dead") {
      e.state = "starting";
      e.reason = undefined;
    }
    e.backend = undefined;
    e.via = undefined;
    e.startedMs = undefined;
    const t0 = this.now();
    // Every handle this start spawned, registered the moment it exists so
    // shutdown() can stop it while the start is still polling. Android spawns
    // up to one per attempt; startAndroidServer stops the failed ones itself.
    const spawned: AnyHandle[] = [];
    const onSpawn = (h: AnyHandle) => {
      spawned.push(h);
      this.sessionChildren.add(h);
      if (this.closed) {
        this.sessionChildren.delete(h);
        void h.stop(SHUTDOWN_KILL_AFTER_MS).catch(() => {});
      }
    };
    const forget = () => spawned.forEach((h) => this.sessionChildren.delete(h));
    let started: Promise<AnyHandle>;
    try {
      started =
        platform === "ios"
          ? this.startIos(udid, { signal: this.abort.signal, onSpawn })
          : this.startAndroid(udid, { signal: this.abort.signal, onSpawn });
    } catch (err) {
      started = Promise.reject(err);
    }
    const done = started
      .then(
        (h) => {
          // A ready start owns no in-flight children any more: an xcodebuild
          // runner is re-registered below; an Android server survives the session.
          forget();
          if (diesWithSession(h) && this.closed) {
            // Normally already stopped through onSpawn; this covers a start
            // that resolved with an xcodebuild handle it never reported.
            void h.stop(SHUTDOWN_KILL_AFTER_MS).catch(() => {});
            this.setFailed(e, SHUT_DOWN);
            return;
          }
          // Defensive: markDead / markFailed only act on a ready entry, and
          // start() never leaves an entry `failed`, so nothing should have set
          // `failed` while this start was in flight — but if something did,
          // that verdict wins over a late start.
          if (e.state === "failed") {
            if (diesWithSession(h)) void h.stop().catch(() => {});
            return;
          }
          if (diesWithSession(h)) this.sessionChildren.add(h);
          e.state = "ready";
          e.reason = undefined;
          e.failedAt = undefined;
          e.via = h.via;
          e.startedMs = this.now() - t0;
          e.handle = h;
          e.backend = platform === "ios" ? this.makeIosBackend(h.port) : this.makeAndroidBackend(h.port, udid);
        },
        (err: unknown) => {
          // The lifecycle already stopped whatever it spawned for a failed start.
          forget();
          this.setFailed(e, err instanceof Error ? err.message : String(err));
          // A server it did not spawn may still hold UiAutomation for the whole
          // retry window: one of another version whose forward findLive dropped,
          // left running because the install then failed (review I3).
          if (platform === "android" && !this.closed) void this.releaseAndroid(udid).catch(() => {});
        },
      )
      .then(() => {
        e.inflight = undefined;
        return toView(e);
      });
    e.inflight = done;
    return done;
  }

  view(platform: Platform, udid: string): PoolEntryView | undefined {
    const e = this.entries.get(this.key(platform, udid));
    return e ? toView(e) : undefined;
  }

  /**
   * The start in flight for this device (a first start or a re-warm after a
   * death), settling with the entry's view once it is ready or failed;
   * undefined when nothing is starting. Starts nothing itself. For a caller
   * whose fallback would break the start: `uiautomator dump` registers
   * UiAutomation too, and the instrumentation that loses that race dies
   * (field test 3, D22).
   */
  settled(platform: Platform, udid: string): Promise<PoolEntryView> | undefined {
    return this.entries.get(this.key(platform, udid))?.inflight;
  }

  /**
   * The runner stopped answering (refused / lost): withdraw the backend and
   * re-warm in the background. An xcodebuild-launched runner is stopped first
   * — its child would otherwise be orphaned when the re-warm launches anew.
   * An Android server is not stopped for a first death: the re-warm's
   * `am force-stop` replaces it.
   * A runner that dies FLAP_LIMIT times within FLAP_WINDOW_MS is hung rather
   * than transiently down: mark it `failed` instead of re-warming again, so
   * calls stop paying its timeouts until the retry window passes (RF-2). An
   * Android server is stopped then, so it releases UiAutomation (review I3).
   *
   * `from` is the backend the failing call used. Unless it is the one the
   * entry hands out right now the report is stale and ignored — no stop, no
   * death counted, no re-warm: a second concurrent call failing on the same
   * dead runner, a call that began on a runner since replaced, or any report
   * while the entry is starting, dead or failed (none of those hands out a
   * backend).
   */
  markDead(platform: Platform, udid: string, reason: string, from: NativeBackend): void {
    const key = this.key(platform, udid);
    const e = this.entries.get(key);
    if (!e || e.backend !== from) return;
    const now = this.now();
    const recent = (this.deaths.get(key) ?? []).filter((t) => now - t < FLAP_WINDOW_MS);
    recent.push(now);
    this.deaths.set(key, recent);
    const flapping = recent.length >= FLAP_LIMIT;
    this.dropHandle(e, flapping && platform === "android");
    e.backend = undefined;
    e.via = undefined;
    e.startedMs = undefined;
    if (flapping) {
      this.deaths.delete(key);
      this.setFailed(e, `runner unstable — ${reason} (died twice within 60s)`);
      return;
    }
    e.state = "dead";
    e.reason = reason;
    if (!e.inflight) void this.warm(platform, udid);
  }

  /**
   * The runner cannot do this here (e.g. 501 unsupported): no retry for
   * retryAfterMs. An xcodebuild-launched runner is stopped rather than left
   * idling for the whole window, and so is an Android server, which would
   * otherwise hold UiAutomation and break the `uiautomator dump` fallback for
   * that window (review I3). Stale reports are ignored as in markDead.
   */
  markFailed(platform: Platform, udid: string, reason: string, from: NativeBackend): void {
    const e = this.entries.get(this.key(platform, udid));
    if (!e || e.backend !== from) return;
    this.dropHandle(e, platform === "android");
    this.setFailed(e, reason);
  }

  /**
   * Session end. xcodebuild-launched iOS runners and Android starts still in
   * flight are stopped — including a child a start in flight has spawned
   * (registered through onSpawn); simctl/reused iOS runners and ready Android
   * servers stay alive for the next session. Starts in flight are aborted, so
   * none spawns anything afterwards, and warm() starts nothing new.
   * `killAfterMs`: SIGINT→SIGKILL window per child; the caller keeps it
   * inside its own grace period so no child outlives the process.
   */
  async shutdown(opts: { killAfterMs?: number } = {}): Promise<void> {
    this.closed = true;
    this.abort.abort();
    const killAfterMs = opts.killAfterMs ?? SHUTDOWN_KILL_AFTER_MS;
    const handles = [...this.sessionChildren];
    this.sessionChildren.clear();
    await Promise.allSettled(handles.map((h) => h.stop(killAfterMs)));
  }
}

let shared: NativePool | undefined;

/** The process-wide pool (same pattern as sharedShells in android.ts). */
export function sharedPool(): NativePool {
  shared ??= new NativePool();
  return shared;
}
