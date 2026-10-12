import { CdpClient } from "./cdp.js";
import { RingBuffer } from "./buffers.js";
import { ConnectionError, RuntimeError } from "./errors.js";
import {
  discoverMetro,
  fetchTargets,
  pickHermesTarget,
  probeMetroPorts,
  type CDPTarget,
  type MetroTarget,
} from "./metro.js";
import {
  NETWORK_INTERCEPTOR_SOURCE,
  drainNetworkExpression,
  ERROR_INTERCEPTOR_SOURCE,
  drainErrorsExpression,
} from "./inject.js";
import { evalWrapper, evalPoll, evalDiscard, parseEnvelope, isPolyfilledPromiseShape } from "./evaluate.js";

export type LogEntry = {
  seq: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  timestamp: number;
};
export type NetworkEntry = {
  seq: number;
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  requestBody?: string;
  responseBody?: string;
  bodyPending?: boolean;
  error?: string;
  timestamp: number;
};
export type ErrorEntry = {
  seq: number;
  kind: "exception" | "redbox" | "bundle";
  text: string;
  stack?: string;
  timestamp: number;
  /** Connection.runtimeGeneration when it was captured — see errorIsFromEarlierRuntime. */
  runtime?: number;
};

export type ConnectionMeta = {
  port: number;
  targetId: string;
  title: string;
  deviceName?: string;
  appId?: string;
  nativePageReloads?: boolean;
  /** The device id connect was given (adb serial / simulator UDID), if any. */
  deviceId?: string;
};

const DEFAULT_EVAL_TIMEOUT_MS = 10000;

/**
 * How long the background (re)install waits for React to register a renderer
 * in a runtime that replaced the one we were attached to. Generous on purpose:
 * nobody waits on it except reload_app (which caps its own wait), and a slow
 * emulator can take many seconds from "context created" to first render
 * (field test D26).
 */
export const NEW_RUNTIME_READY_TIMEOUT_MS = 10000;

/**
 * How long an evaluate waits for the new execution context when the app is
 * between JS runtimes. Measured on RN 0.83 bridgeless / Android emulator: the
 * old context is destroyed ~0.8 s after Page.reload and the new one is created
 * 6.7 s later idle, 9.6 s with the host loaded (field test D33). 15 s covers
 * that with headroom and stays well under an MCP client's tool timeout.
 */
export const CONTEXT_WAIT_MS = 15000;
/** After a wait ran out, later evaluates of the same tool call fail at once. */
const CONTEXT_WAIT_COOLDOWN_MS = 3000;
/** A runtime gone this long is not "reloading" any more; stop waiting on it. */
const CONTEXT_GONE_GIVE_UP_MS = 60000;

export const RUNTIME_RELOADING_MESSAGE =
  "the app's JS runtime is reloading (no execution context yet) — retry in a few seconds";
/** Same condition, on a target that did not announce it: say what is known. */
const RUNTIME_UNAVAILABLE_MESSAGE =
  "the app has no execution context right now — its JS runtime is probably reloading; retry in a few seconds";

/** Internal marker: the target had no JS runtime to evaluate in. */
class NoContextError extends Error {}

/**
 * What a target answers to Runtime.evaluate when it has no JS runtime to run
 * it in: RN answers -32601 with the bare method name as the message; Chrome-
 * style targets say "Cannot find context with specified id" / "Execution
 * context was destroyed".
 */
function isNoContextError(err: unknown): boolean {
  if (!(err instanceof Error) || err instanceof ConnectionError) return false;
  if ((err as { code?: number }).code === -32601) return true;
  return /cannot find (default )?(execution )?context|execution context was destroyed|no execution context/i.test(
    err.message,
  );
}

const APP_READY_PROBE =
  `(function () { var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;` +
  ` return !!(h && h.renderers && h.renderers.size > 0); })()`;

export type RuntimeSetupOutcome = {
  /** React confirmed a renderer before the budget ran out. */
  ready: boolean;
  readyTimeoutMs: number;
};

function stringifyArg(a: any): string {
  if (a == null) return String(a);
  if (a.type === "string") return a.value;
  if ("value" in a) return typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value);
  if (a.description) return a.description;
  return a.type ?? "";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Connection {
  readonly logs = new RingBuffer<LogEntry>(500);
  readonly errors = new RingBuffer<ErrorEntry>(100);
  readonly network = new RingBuffer<NetworkEntry>(200);
  private logSeq = 0;
  private errSeq = 0;
  private lastNetSeq = 0;
  /**
   * Added to every seq the app reports. The in-app counter restarts at 1 in
   * each new JS runtime, so without an offset its first requests either hid
   * behind the old runtime's watermark or merged into old entries by seq.
   */
  private netSeqBase = 0;
  private netIndex = new Map<number, NetworkEntry>();
  /** The execution context the target last announced, if it announces any. */
  private contextId: unknown = undefined;
  private contextCleared = false;
  private seenContext = false;
  /** Bumped each time a JS runtime replaced the one this connection was in. */
  runtimeGeneration = 0;
  /** Host time the latest replacement runtime was noticed. */
  runtimeRestartedAt?: number;
  /** Host time network capture was first back in place in that runtime. */
  captureReinstalledAt?: number;
  /** The (re)install running for the latest runtime. Resolves, never rejects. */
  runtimeSetup?: Promise<RuntimeSetupOutcome>;
  private setupsRunning = 0;
  /** Host time the target said its execution context was destroyed/cleared. */
  private contextGoneAt = 0;
  private contextWaiters: (() => void)[] = [];
  private contextWaitRanOutAt = 0;
  /** Per-evaluate wait for a new context; a field so a test can shorten it. */
  contextWaitMs = CONTEXT_WAIT_MS;
  /** "ok" | "stale" (an older build's hooks are still installed) | "failed". */
  interceptorStatus: unknown = "ok";
  /** "ok" | "unavailable" (no ErrorUtils) | "stale" | "failed". */
  errorInterceptorStatus: unknown = "ok";

  constructor(
    private client: CdpClient,
    readonly meta: ConnectionMeta,
  ) {
    client.on("Runtime.consoleAPICalled", (p) => this.onConsole(p));
    client.on("Runtime.exceptionThrown", (p) => this.onException(p));
    client.on("Runtime.executionContextCreated", (p) => this.onContextCreated(p));
    client.on("Runtime.executionContextsCleared", () => this.onContextGone());
    client.on("Runtime.executionContextDestroyed", (p) => {
      if (p?.executionContextId === this.contextId) this.onContextGone();
    });
    client.onClose(() => {
      this.logs.markGap();
      this.network.markGap();
      // Whoever waits on a new context gets the ordinary "not connected" now.
      this.wakeContextWaiters();
    });
  }

  get connected(): boolean {
    return this.client.connected;
  }

  /**
   * Whether the target announces its JS runtimes (Runtime.executionContextCreated).
   * When it does, a reload is recognised by the context changing, whenever that
   * happens, and capture is reinstalled without anyone asking.
   */
  get tracksRuntimes(): boolean {
    return this.seenContext;
  }

  /**
   * Runtime identity, not liveness, says a reload happened: the old runtime
   * keeps answering while a slow device fetches the new bundle, so "is the old
   * one gone yet" after a fixed wait was a guess that came out wrong on a slow
   * emulator (field test D26). A context created after a clear, or with a new
   * id, is a new runtime. The context announced in answer to connect()'s own
   * Runtime.enable is not — connect() adopts it and installs into it itself.
   */
  /**
   * True between "the target destroyed its execution context" and "it created
   * the next one": there is no JS runtime to evaluate in, and the target says
   * so itself, so nothing has to be guessed from a failing call.
   */
  get runtimeGone(): boolean {
    return this.seenContext && this.contextCleared;
  }

  /**
   * The runtime is gone, or a new one is up but its (re)install has not
   * finished. An unhealthy interceptor status in this state is a reload in
   * progress, not something another reload_app would fix.
   */
  get runtimeSettling(): boolean {
    return this.runtimeGone || this.setupsRunning > 0;
  }

  /** How long the app has been without a JS runtime, in ms (0 when it has one). */
  get runtimeGoneForMs(): number {
    return this.runtimeGone ? Date.now() - this.contextGoneAt : 0;
  }

  /** An error captured in a JS runtime that has since been replaced. */
  errorIsFromEarlierRuntime(e: ErrorEntry): boolean {
    return e.runtime !== undefined && e.runtime < this.runtimeGeneration;
  }

  private onContextGone(): void {
    if (!this.seenContext || this.contextCleared) return;
    this.contextCleared = true;
    this.contextGoneAt = Date.now();
    this.contextWaitRanOutAt = 0;
  }

  private wakeContextWaiters(): void {
    const waiters = this.contextWaiters;
    this.contextWaiters = [];
    for (const w of waiters) w();
  }

  /**
   * Holds an evaluate while the app is between JS runtimes, then lets it run in
   * the new one. Without this every tool failed with a bare CDP error for the
   * 7–10 s a reload takes on a real device (field test D33). Bounded three
   * ways so a dead app cannot hang a call: by `maxMs`, by a cooldown after a
   * wait that ran out (a tool's second evaluate must not wait all over again),
   * and by giving up on a runtime that has been gone for a minute.
   */
  private async waitForContext(maxMs: number): Promise<void> {
    if (!this.runtimeGone || !this.connected) return;
    if (this.runtimeGoneForMs > CONTEXT_GONE_GIVE_UP_MS) {
      throw new RuntimeError(
        `the app's JS runtime went away ${Math.round(this.runtimeGoneForMs / 1000)}s ago and has not come back ` +
          `(no execution context) — the app may have crashed or be stuck loading its bundle; check the screen (screenshot) and relaunch it with launch_app`,
      );
    }
    if (Date.now() - this.contextWaitRanOutAt < CONTEXT_WAIT_COOLDOWN_MS) {
      throw new RuntimeError(RUNTIME_RELOADING_MESSAGE);
    }
    await new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        this.contextWaiters = this.contextWaiters.filter((w) => w !== wake);
        resolve();
      }, maxMs);
      timer.unref?.();
      this.contextWaiters.push(wake);
    });
    // Socket closed meanwhile: fall through, the send reports "not connected".
    if (!this.runtimeGone || !this.connected) return;
    this.contextWaitRanOutAt = Date.now();
    throw new RuntimeError(RUNTIME_RELOADING_MESSAGE);
  }

  /** Records the context connect() is about to install into — not a reload. */
  adoptContext(p: any): void {
    this.seenContext = true;
    this.contextId = p?.context?.id;
    this.contextCleared = false;
  }

  private onContextCreated(p: any): void {
    const id = p?.context?.id;
    const replaced = this.seenContext && (this.contextCleared || id !== this.contextId);
    this.seenContext = true;
    this.contextId = id;
    this.contextCleared = false;
    if (replaced) this.markRuntimeReplaced({ install: true });
    this.wakeContextWaiters();
  }

  /**
   * Bookkeeping for a JS runtime that replaced the one this connection was in:
   * the log/network streams get a gap, the request-seq offset moves past
   * everything already captured, and — when `install` — both interceptors go
   * into the new runtime in the background: once straight away, so startup
   * requests are caught as early as the runtime lets us, and again once React
   * has rendered, because bundle init can replace what went on too early
   * (field test D14). Errors no longer depend on that second pass: the error
   * interceptor follows a later setGlobalHandler by itself (D26).
   */
  markRuntimeReplaced(opts?: { install?: boolean }): void {
    this.runtimeGeneration++;
    this.runtimeRestartedAt = Date.now();
    this.captureReinstalledAt = undefined;
    this.logs.markGap();
    this.network.markGap();
    this.netSeqBase += this.lastNetSeq;
    this.lastNetSeq = 0;
    this.netIndex = new Map();
    this.runtimeSetup = opts?.install ? this.setUpNewRuntime(this.runtimeGeneration) : undefined;
  }

  private async setUpNewRuntime(generation: number): Promise<RuntimeSetupOutcome> {
    const readyTimeoutMs = NEW_RUNTIME_READY_TIMEOUT_MS;
    this.setupsRunning++;
    try {
      await this.installInterceptors();
      const ready = await this.waitForAppReady(readyTimeoutMs, generation);
      // A newer runtime took over while we waited; its own setup owns it now.
      if (generation !== this.runtimeGeneration || !this.connected) return { ready, readyTimeoutMs };
      await this.installInterceptors();
      return { ready, readyTimeoutMs };
    } catch {
      return { ready: false, readyTimeoutMs };
    } finally {
      this.setupsRunning--;
    }
  }

  /**
   * Resolves once React has registered a renderer, or after the budget — never
   * throws. Returns whether readiness was actually confirmed, so a caller that
   * installs hooks right after this can tell an honest "the bundle was ready"
   * from "we gave up waiting". Stops early when the socket drops or (with
   * `generation`) a newer runtime replaced the one it was waiting on.
   */
  async waitForAppReady(timeoutMs: number, generation?: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.connected) return false;
      if (generation !== undefined && generation !== this.runtimeGeneration) return false;
      const ready = await this.evaluate(APP_READY_PROBE, {
        timeoutMs: Math.max(500, Math.min(DEFAULT_EVAL_TIMEOUT_MS, deadline - Date.now())),
      }).catch(() => false);
      if (ready === true) return true;
      await sleep(150);
    }
    return false;
  }

  /**
   * Fires when the underlying socket drops — an app reload, a Metro restart, or
   * this connection being replaced. Anything holding work that outlives a
   * single tool call (core/jobs.ts) needs this: without it a job whose runtime
   * vanished would sit at "running" forever.
   */
  onClose(handler: () => void): void {
    this.client.onClose(handler);
  }

  /**
   * Raw CDP access for domains that have no Runtime.evaluate equivalent (the
   * Profiler domain lives in the VM). Everything else keeps going through
   * evaluate() so the polyfilled-Promise handling there is not bypassed.
   */
  get cdp(): Pick<CdpClient, "send"> {
    return this.client;
  }

  private onConsole(p: any): void {
    const levelMap: Record<string, LogEntry["level"]> = {
      log: "log", info: "info", warning: "warn", warn: "warn", error: "error", debug: "debug",
    };
    this.logs.push({
      seq: ++this.logSeq,
      level: levelMap[p.type] ?? "log",
      text: (p.args ?? []).map(stringifyArg).join(" "),
      timestamp: p.timestamp ?? Date.now(),
    });
  }

  private onException(p: any): void {
    const d = p.exceptionDetails ?? {};
    this.errors.push({
      seq: ++this.errSeq,
      kind: "exception",
      text: d.exception?.description ?? d.text ?? "Uncaught exception",
      stack: d.stackTrace ? JSON.stringify(d.stackTrace) : undefined,
      timestamp: Date.now(),
      runtime: this.runtimeGeneration,
    });
  }

  private async rawEvaluate(expression: string, timeoutMs: number): Promise<unknown> {
    const res = await this.client
      .send("Runtime.evaluate", { expression, returnByValue: true }, { timeoutMs })
      .catch((err) => {
        // The target's own way of saying "no JS runtime right now" is a bare
        // method name with a code; passed on as is it reached the agent as
        // "Unexpected error: Runtime.evaluate" (field test D33).
        if (isNoContextError(err)) throw new NoContextError();
        throw err;
      });
    if (res?.exceptionDetails) {
      throw new RuntimeError(
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "eval failed",
      );
    }
    return res?.result?.value;
  }

  // Resolves to the *value* of `expression`, including when it is a promise —
  // see core/evaluate.ts for why awaitPromise cannot be trusted here.
  async evaluate(expression: string, opts?: { timeoutMs?: number }): Promise<any> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS;
    // A caller that set its own budget said how long it is willing to wait.
    const contextWaitMs = Math.min(this.contextWaitMs, opts?.timeoutMs ?? this.contextWaitMs);
    await this.waitForContext(contextWaitMs);
    let deadline = Date.now() + timeoutMs;
    let first: unknown;
    try {
      first = await this.rawEvaluate(evalWrapper(expression), timeoutMs);
    } catch (err) {
      if (!(err instanceof NoContextError)) throw err;
      // The runtime was torn down under this request. If the target announced
      // it, the expression never ran: wait for the next runtime and run it
      // there, once. If it did not, there is nothing to wait on.
      if (!this.runtimeGone) throw new RuntimeError(RUNTIME_UNAVAILABLE_MESSAGE);
      await this.waitForContext(contextWaitMs);
      deadline = Date.now() + timeoutMs;
      first = await this.rawEvaluate(evalWrapper(expression), timeoutMs).catch((again) => {
        throw again instanceof NoContextError ? new RuntimeError(RUNTIME_RELOADING_MESSAGE) : again;
      });
    }
    let env = parseEnvelope(first);

    if (env.s === "pending" && env.t) {
      const token = env.t;
      let interval = 10;
      while (true) {
        if (Date.now() >= deadline) {
          await this.rawEvaluate(evalDiscard(token), 2000).catch(() => {});
          throw new RuntimeError(
            `evaluation did not settle within ${timeoutMs}ms (pending promise) — the app may be blocked or waiting on I/O`,
          );
        }
        await sleep(interval);
        interval = Math.min(interval * 2, 100);
        env = parseEnvelope(
          await this.rawEvaluate(evalPoll(token), Math.max(1000, deadline - Date.now())).catch((err) => {
            // The runtime holding the pending promise is gone; so is the result.
            if (err instanceof NoContextError) return JSON.stringify({ s: "lost" });
            throw err;
          }),
        );
        if (env.s !== "pending") break;
      }
    }

    if (env.s === "lost") {
      throw new RuntimeError("pending evaluation was lost — the app reloaded while it was running");
    }
    if (env.s === "err") throw new RuntimeError(env.e);
    const value = (env as { v?: unknown }).v;
    if (isPolyfilledPromiseShape(value)) {
      throw new RuntimeError(
        "expression resolved to an unresolved promise object — it could not be awaited in this runtime",
      );
    }
    return value;
  }

  // RN advertises `nativePageReloads` on the target; Page.reload is the only
  // reload path that actually works — DevSettings is a module, never a global,
  // so the old `typeof DevSettings !== "undefined"` branch could never run.
  async requestReload(): Promise<void> {
    try {
      await this.client.send("Page.reload", {}, { timeoutMs: 5000 });
      return;
    } catch (err) {
      const ok = await this.evaluate(
        `(function(){ if (typeof globalThis.__RNE_RELOAD__ === "function") { globalThis.__RNE_RELOAD__(); return true; } return false; })()`,
      ).catch(() => false);
      if (!ok) {
        throw new ConnectionError(
          `reload failed: ${err instanceof Error ? err.message : String(err)} (and the app exposes no __RNE_RELOAD__ hook)`,
        );
      }
    }
  }

  async drainNetwork(): Promise<void> {
    const raw = await this.evaluate(drainNetworkExpression(this.lastNetSeq));
    if (!raw) return;
    let entries: NetworkEntry[];
    try {
      entries = JSON.parse(raw);
    } catch {
      return;
    }
    for (const raw of entries) {
      const runtimeSeq = raw.seq;
      const e = { ...raw, seq: this.netSeqBase + runtimeSeq };
      // A response body arrives after the entry is recorded, so the interceptor
      // re-offers updated entries; merge them in place instead of duplicating.
      const known = this.netIndex.get(e.seq);
      if (known) {
        Object.assign(known, e);
      } else {
        this.network.push(e);
        this.netIndex.set(e.seq, e);
      }
      if (runtimeSeq > this.lastNetSeq) this.lastNetSeq = runtimeSeq;
    }
  }

  /**
   * Pulls the errors the app captured itself. In a dev build LogBox is the
   * ErrorUtils global handler: it paints the redbox and swallows the exception,
   * so Runtime.exceptionThrown never fires and the buffer stayed empty while a
   * redbox covered the screen (field test D3).
   */
  async drainErrors(): Promise<void> {
    const raw = await this.evaluate(drainErrorsExpression()).catch(() => undefined);
    if (!raw) return;
    let entries: { seq: number; kind?: string; text?: string; stack?: string; timestamp?: number }[];
    try {
      entries = JSON.parse(raw);
    } catch {
      return;
    }
    for (const e of entries) {
      const text = e.text ?? "Uncaught exception";
      // Without LogBox in the chain both paths fire for the same throw. Telling
      // the agent the app failed twice sends it hunting for a second bug.
      if (this.recentlyRecorded(text, e.timestamp ?? Date.now())) continue;
      this.errors.push({
        seq: ++this.errSeq,
        kind: e.kind === "redbox" ? "redbox" : "exception",
        text,
        stack: e.stack,
        timestamp: e.timestamp ?? Date.now(),
        runtime: this.runtimeGeneration,
      });
    }
  }

  /**
   * Installs (or heals) one or both interceptors in whatever runtime is live
   * now. Both sources check that their own wrapper is still the one in place,
   * so calling this repeatedly is cheap and is the only way a runtime whose
   * bundle re-init replaced them gets fixed (field test D13/D14).
   *
   * `only` lets a drain path re-assert just the source it is about to read
   * (get_network doesn't care about the error interceptor and vice versa) —
   * omit it to install both, which is what `connect` and the `reload_app`
   * success path rely on to never install one and forget the other. The
   * source that is skipped leaves its recorded status untouched.
   */
  async installInterceptors(only?: "network" | "errors"): Promise<void> {
    if (only !== "errors") {
      this.interceptorStatus = await this.evaluate(NETWORK_INTERCEPTOR_SOURCE).catch(() => "failed");
      if (this.interceptorStatus === "ok" && this.runtimeRestartedAt !== undefined) {
        this.captureReinstalledAt ??= Date.now();
      }
    }
    if (only !== "network") {
      this.errorInterceptorStatus = await this.evaluate(ERROR_INTERCEPTOR_SOURCE).catch(() => "failed");
    }
  }

  private recentlyRecorded(text: string, at: number): boolean {
    const DEDUPE_WINDOW_MS = 5000;
    return this.errors
      .last(20)
      .some((e) => e.text === text && Math.abs((e.timestamp ?? 0) - at) < DEDUPE_WINDOW_MS);
  }

  close(): void {
    this.client.close();
  }
}

function targetMeta(port: number, t: CDPTarget, deviceId?: string): ConnectionMeta {
  return {
    deviceId,
    port,
    targetId: t.id,
    title: t.title,
    deviceName: t.deviceName,
    appId: t.appId,
    nativePageReloads: t.reactNative?.capabilities?.nativePageReloads === true,
  };
}

export class Registry {
  private conn?: Connection;
  private defaultPort?: number;
  private last?: { port: number; targetId: string; deviceName?: string; title?: string; deviceId?: string };
  private everConnected = false;

  get active_or_null(): Connection | undefined {
    return this.conn;
  }

  setDefaultPort(port?: number): void {
    this.defaultPort = port;
  }

  private portsToScan(explicit?: number[]): number[] | undefined {
    // A configured port (--port / METRO_PORT) narrows discovery too, instead of
    // scanning every default port and reporting apps the user did not ask about.
    return explicit ?? (this.defaultPort ? [this.defaultPort] : undefined);
  }

  async listTargets(opts?: { ports?: number[] }): Promise<MetroTarget[]> {
    return discoverMetro({ ports: this.portsToScan(opts?.ports) });
  }

  // Ports answering Metro's /status but exposing no debuggable target: Metro is
  // up, the app just isn't attached. Reported separately so the user is not sent
  // off to restart a bundler that is already running.
  async listMetroWithoutTargets(opts?: { ports?: number[] }): Promise<number[]> {
    const ports = this.portsToScan(opts?.ports);
    const [alive, targets] = await Promise.all([probeMetroPorts(ports), this.listTargets({ ports })]);
    const withTargets = new Set(targets.map((t) => t.port));
    return alive.filter((p) => !withTargets.has(p));
  }

  async connect(opts?: { port?: number; targetId?: string; device?: string; deviceId?: string }): Promise<Connection> {
    let metroTarget: MetroTarget | undefined;
    const wantPort = opts?.port ?? this.defaultPort;
    const matchesDevice = (t: CDPTarget): boolean => {
      if (!opts?.device) return true;
      const needle = opts.device.toLowerCase();
      return (t.deviceName ?? "").toLowerCase().includes(needle) || (t.title ?? "").toLowerCase().includes(needle);
    };

    if (wantPort) {
      const targets = (await fetchTargets(wantPort)).filter(matchesDevice);
      const target = opts?.targetId ? targets.find((t) => t.id === opts.targetId) : pickHermesTarget(targets);
      if (target) metroTarget = { port: wantPort, target };
    } else {
      const all = await discoverMetro();
      const wanted = all.filter((m) => matchesDevice(m.target));
      metroTarget = opts?.targetId ? wanted.find((m) => m.target.id === opts.targetId) : wanted[0];
    }

    if (!metroTarget) {
      const idle = await this.listMetroWithoutTargets(wantPort ? { ports: [wantPort] } : undefined);
      const where = wantPort ? `on port ${wantPort}` : "on the scanned ports";
      if (idle.length > 0) {
        throw new ConnectionError(
          `Metro is running on port ${idle.join(", ")} but no app is attached — start (or reload) your app, then retry`,
        );
      }
      throw new ConnectionError(
        opts?.targetId
          ? `no target with id ${opts.targetId} ${where}`
          : opts?.device
            ? `no React Native target matching device "${opts.device}" ${where}`
            : `no React Native target found ${where} — is Metro running?`,
      );
    }

    if (this.conn) this.conn.close();

    const client = new CdpClient(metroTarget.target.webSocketDebuggerUrl);
    await client.connect();
    // The target announces the live execution context in answer to
    // Runtime.enable — before the Connection (and its listeners) exists. That
    // context is the identity a later reload is told apart from.
    const announced: unknown[] = [];
    let beforeConn = true;
    client.on("Runtime.executionContextCreated", (p) => {
      if (beforeConn) announced.push(p);
    });
    await client.send("Runtime.enable");
    await client.send("Log.enable").catch(() => {});
    const conn = new Connection(client, targetMeta(metroTarget.port, metroTarget.target, opts?.deviceId));
    beforeConn = false;
    for (const p of announced) conn.adoptContext(p);
    await conn.installInterceptors();
    this.conn = conn;
    this.last = {
      port: metroTarget.port,
      targetId: metroTarget.target.id,
      deviceName: metroTarget.target.deviceName,
      title: metroTarget.target.title,
      deviceId: opts?.deviceId,
    };
    this.everConnected = true;
    return conn;
  }

  active(): Connection {
    if (!this.conn) throw new ConnectionError(this.notConnectedReason());
    return this.conn;
  }

  private notConnectedReason(): string {
    return this.everConnected
      ? "the connection was closed — run connect to re-attach"
      : "no active connection — run connect";
  }

  // Used by every tool that needs the runtime: re-attaches transparently when
  // the socket dropped (app reload, Metro restart) instead of telling the user
  // to start Metro, which is usually already running.
  async ensure(): Promise<Connection> {
    if (this.conn?.connected) return this.conn;
    if (!this.everConnected || !this.last) throw new ConnectionError(this.notConnectedReason());
    const last = this.last;
    try {
      return await this.connect({ port: last.port, targetId: last.targetId, deviceId: last.deviceId });
    } catch {
      // The old target is gone (typical after a reload, which gives the app a
      // new target id). Only the same device may take its place: the next
      // target on the port can be the same app on another simulator, and
      // re-attaching there would send this session's calls to the wrong device.
      if (last.deviceName) {
        const targets = await fetchTargets(last.port).catch(() => [] as CDPTarget[]);
        const same = pickHermesTarget(targets.filter((t) => t.deviceName === last.deviceName));
        if (same) return this.connect({ port: last.port, targetId: same.id, deviceId: last.deviceId });
        // One app often shows up as two targets on a device; name each once.
        const others = [...new Set(targets.map((t) => `"${t.title}"${t.deviceName ? ` [${t.deviceName}]` : ""}`))];
        throw new ConnectionError(
          `connection to "${last.title ?? "the app"}" on ${last.deviceName} was lost and the app is no longer attached to Metro on port ${last.port}` +
            (others.length
              ? ` — other targets there: ${others.join("; ")}. Start the app again, or run connect with device: to switch to another one`
              : " — start (or reload) the app, then retry"),
        );
      }
      try {
        return await this.connect({ port: last.port, deviceId: last.deviceId });
      } catch (err) {
        throw new ConnectionError(
          `connection to "${this.conn?.meta.title ?? "the app"}" was lost and could not be re-established: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // For tools that can work without the runtime (device-driven ones): returns a
  // live connection when there is one, never throws.
  async optional(): Promise<Connection | undefined> {
    if (this.conn?.connected) return this.conn;
    if (!this.everConnected) return undefined;
    return this.ensure().catch(() => undefined);
  }

  reset(): void {
    this.conn?.close();
    this.conn = undefined;
    this.defaultPort = undefined;
    this.last = undefined;
    this.everConnected = false;
  }
}

let singleton: Registry | undefined;
export function getRegistry(): Registry {
  if (!singleton) singleton = new Registry();
  return singleton;
}
