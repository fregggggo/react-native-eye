import { CdpClient } from "./cdp.js";
import { RingBuffer } from "./buffers.js";
import { CdpTimeoutError, ConnectionError, RuntimeError } from "./errors.js";
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
import {
  evalWrapper,
  evalPoll,
  evalDiscard,
  parseEnvelope,
  isPolyfilledPromiseShape,
  escapeSurrogates,
} from "./evaluate.js";

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
  /** Sent, no response yet — recorded at the start so a request that hangs is visible. */
  pending?: boolean;
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
  if (!(err instanceof Error) || err instanceof ConnectionError || err instanceof CdpTimeoutError) return false;
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

/** One console argument, rendered. Long enough for a real object, short enough that one log cannot flood the buffer. */
const MAX_LOG_ARG_CHARS = 1000;
/** A whole console line; get_logs prints 500 of it, search sees all of it. */
const MAX_LOG_TEXT_CHARS = 8000;
/** Nesting the preview renderer follows before it settles for a description. */
const MAX_PREVIEW_DEPTH = 2;

function cap(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max} chars)` : s;
}

/** A CDP PropertyPreview: its value is already a string, its nested object a preview of its own. */
function previewValue(p: any, depth: number): string {
  if (p?.valuePreview && depth < MAX_PREVIEW_DEPTH) return renderPreview(p.valuePreview, depth + 1);
  if (p?.type === "string") return JSON.stringify(p.value ?? "");
  if (p?.type === "function") return "ƒ";
  if (p?.subtype === "null") return "null";
  if (p?.value !== undefined) return String(p.value);
  return p?.type ?? "?";
}

/**
 * `{a: 1, b: [1, 2]}` / `[1, 2, 3]` from a CDP ObjectPreview — what the agent
 * needs from `console.log("x", obj)`. Without it every object read "Object".
 */
function renderPreview(preview: any, depth = 0): string {
  const props: any[] = Array.isArray(preview?.properties) ? preview.properties : [];
  const more = preview?.overflow ? ", …" : "";
  if (preview?.subtype === "array" || preview?.subtype === "typedarray") {
    return `[${props.map((p) => previewValue(p, depth)).join(", ")}${more}]`;
  }
  if (Array.isArray(preview?.entries) && preview.entries.length > 0) {
    const entries = preview.entries.map((e: any) =>
      e?.key ? `${renderPreview(e.key, MAX_PREVIEW_DEPTH)} => ${renderPreview(e.value, MAX_PREVIEW_DEPTH)}` : renderPreview(e?.value, MAX_PREVIEW_DEPTH),
    );
    return `${preview.description ?? ""} {${entries.join(", ")}${more}}`.trim();
  }
  // A primitive (a Map key), a Date, a RegExp, an Error: its description is the readable form.
  const described = preview?.type !== "object" || (preview?.subtype && preview.subtype !== "map" && preview.subtype !== "set");
  if (preview?.description && (preview?.subtype === "error" || (described && props.length === 0))) {
    return String(preview.description);
  }
  const body = `{${props.map((p) => `${p?.name}: ${previewValue(p, depth)}`).join(", ")}${more}}`;
  // A class instance keeps its name; a plain object needs none.
  const cls = preview?.description;
  return cls && cls !== "Object" && preview?.subtype !== "array" ? `${cls} ${body}` : body;
}

function stringifyArg(a: any): string {
  if (a == null) return String(a);
  if (a.type === "string") return cap(String(a.value), MAX_LOG_ARG_CHARS);
  if (a.unserializableValue !== undefined) return String(a.unserializableValue);
  if ("value" in a) {
    return cap(typeof a.value === "object" ? JSON.stringify(a.value) : String(a.value), MAX_LOG_ARG_CHARS);
  }
  if (a.preview) return cap(renderPreview(a.preview), MAX_LOG_ARG_CHARS);
  if (a.description) return cap(String(a.description), MAX_LOG_ARG_CHARS);
  return a.type ?? "";
}

function renderConsoleArgs(args: any[]): string {
  return cap(args.map(stringifyArg).join(" "), MAX_LOG_TEXT_CHARS);
}

/** Own properties shown for an object that came without a preview. */
const PROPERTY_FETCH_MAX_KEYS = 20;
/** Runtime.getProperties calls in flight at once; a chatty app gets descriptions past this. */
const MAX_PROPERTY_FETCHES = 4;
/** Objects waiting for a property fetch; past this, the rest keep their description. */
const MAX_QUEUED_PROPERTY_FETCHES = 200;

/**
 * Whether a console argument is an object the target sent without a preview —
 * worth one Runtime.getProperties to show its contents. A big array is not:
 * every index comes back as its own descriptor.
 */
function wantsProperties(a: any): boolean {
  if (!a || a.type !== "object" || !a.objectId || a.preview || a.subtype === "null") return false;
  if (a.subtype === "array") {
    const n = /\((\d+)\)/.exec(String(a.description ?? ""))?.[1];
    return n !== undefined && Number(n) <= PROPERTY_FETCH_MAX_KEYS;
  }
  return a.subtype === undefined;
}

/** A Runtime.getProperties answer, shaped as the ObjectPreview a target could have sent. */
function previewFromProperties(arg: any, result: any[]): any {
  const own = result.filter(
    (d) => d && d.enumerable !== false && d.name !== "__proto__" && !(arg.subtype === "array" && d.name === "length"),
  );
  return {
    type: "object",
    subtype: arg.subtype,
    description: arg.subtype === "array" ? undefined : arg.className ?? arg.description,
    overflow: own.length > PROPERTY_FETCH_MAX_KEYS,
    properties: own.slice(0, PROPERTY_FETCH_MAX_KEYS).map((d) => {
      const v = d.value;
      if (!v) return { name: d.name, type: "accessor", value: "(…)" };
      return {
        name: d.name,
        type: v.type,
        subtype: v.subtype,
        value:
          v.type === "string" ? String(v.value) : "value" in v ? String(v.value) : v.unserializableValue ?? v.description,
      };
    }),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Whether a new connection is to the app an earlier one was attached to — the
 * condition for carrying its history over. A reload can give the app a new
 * target id, so the id is not part of it; device, title and app are.
 */
function sameApp(a: ConnectionMeta, b: ConnectionMeta): boolean {
  return (
    a.port === b.port &&
    a.title === b.title &&
    (a.deviceName ?? "") === (b.deviceName ?? "") &&
    (a.appId === undefined || b.appId === undefined || a.appId === b.appId)
  );
}

/** Stamps the live runtime with an id once and returns whichever id it carries. */
function runtimeIdExpression(candidate: string): string {
  return `(function () {
    if (typeof globalThis.__RNE_RUNTIME_ID__ !== "string") globalThis.__RNE_RUNTIME_ID__ = ${JSON.stringify(candidate)};
    return globalThis.__RNE_RUNTIME_ID__;
  })()`;
}

export class Connection {
  readonly logs: RingBuffer<LogEntry>;
  readonly errors: RingBuffer<ErrorEntry>;
  readonly network: RingBuffer<NetworkEntry>;
  private logSeq = 0;
  private errSeq = 0;
  private lastNetSeq = 0;
  /**
   * Added to every seq the app reports. The in-app counter restarts at 1 in
   * each new JS runtime, so without an offset its first requests either hid
   * behind the old runtime's watermark or merged into old entries by seq.
   */
  private netSeqBase = 0;
  /** Entries by seq, for merging a late body in place; trimmed as the ring evicts. */
  private netIndex = new Map<number, NetworkEntry>();
  /** The id stamped on the JS runtime this connection last installed into. */
  runtimeId?: string;
  /** Newest console timestamp the target reported, for spotting a replay on reconnect. */
  private lastConsoleAt = 0;
  /** Console messages at or before this time were already captured by an earlier connection. */
  private replayHorizon = 0;
  /** True from Runtime.enable to its answer being processed: contexts announced then are adopted. */
  private handshaking = false;
  /** Set once a newer connection to the same app took over these buffers. */
  private handedOver = false;
  private propertyFetches = 0;
  private propertyQueue: { entry: LogEntry; args: any[]; arg: any }[] = [];
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

  /**
   * `history`: an earlier connection to the same app. Its logs, errors and
   * requests carry over (the socket drop in between is a gap, not the end of
   * the record), along with the counters that keep its seqs and runtime
   * generations meaningful. Whether the app is still in the same JS runtime is
   * for the caller to establish (see Registry.connect).
   */
  constructor(
    private client: CdpClient,
    readonly meta: ConnectionMeta,
    opts?: { history?: Connection },
  ) {
    const h = opts?.history;
    this.logs = h?.logs ?? new RingBuffer<LogEntry>(500);
    this.errors = h?.errors ?? new RingBuffer<ErrorEntry>(100);
    this.network = h?.network ?? new RingBuffer<NetworkEntry>(200);
    if (h) {
      this.logSeq = h.logSeq;
      this.errSeq = h.errSeq;
      this.lastNetSeq = h.lastNetSeq;
      this.netSeqBase = h.netSeqBase;
      this.netIndex = h.netIndex;
      this.runtimeGeneration = h.runtimeGeneration;
      this.runtimeRestartedAt = h.runtimeRestartedAt;
      this.captureReinstalledAt = h.captureReinstalledAt;
      this.lastConsoleAt = h.lastConsoleAt;
      this.replayHorizon = h.lastConsoleAt;
      this.logs.markGap();
      this.network.markGap();
    }
    client.on("Runtime.consoleAPICalled", (p) => this.onConsole(p));
    client.on("Runtime.exceptionThrown", (p) => this.onException(p));
    client.on("Runtime.executionContextCreated", (p) => this.onContextCreated(p));
    client.on("Runtime.executionContextsCleared", () => this.onContextGone());
    client.on("Runtime.executionContextDestroyed", (p) => {
      if (p?.executionContextId === this.contextId) this.onContextGone();
    });
    client.onClose(() => {
      // Buffers a newer connection took over are its record now: this old
      // socket closing (a single-debugger proxy kicking it) is no hole in it.
      if (!this.handedOver) {
        this.logs.markGap();
        this.network.markGap();
      }
      // Whoever waits on a new context gets the ordinary "not connected" now.
      this.wakeContextWaiters();
    });
  }

  /**
   * The window in which the target answers Runtime.enable: the context it
   * announces then is the one connect installs into, not a reload, and the
   * console messages it replays then may already be in an inherited history.
   */
  beginHandshake(): void {
    this.handshaking = true;
  }

  endHandshake(): void {
    this.handshaking = false;
  }

  /** A newer connection to the same app has these buffers now; stop writing into them. */
  handOver(): void {
    this.handedOver = true;
  }

  /** That newer connection failed its handshake; this one keeps the record after all. */
  takeBack(): void {
    this.handedOver = false;
  }

  /** Stamps the live runtime (once) and records its id; undefined when it could not be read. */
  async stampRuntime(): Promise<string | undefined> {
    const candidate = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const id = await this.evaluate(runtimeIdExpression(candidate)).catch(() => undefined);
    this.runtimeId = typeof id === "string" ? id : undefined;
    return this.runtimeId;
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
    if (this.handshaking) {
      this.adoptContext(p);
      this.wakeContextWaiters();
      return;
    }
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
    // The new runtime carries no stamp yet; the next full install puts one on.
    this.runtimeId = undefined;
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
    if (this.handedOver || !p) return;
    const levelMap: Record<string, LogEntry["level"]> = {
      log: "log", info: "info", warning: "warn", warn: "warn", error: "error", debug: "debug",
    };
    const at = typeof p.timestamp === "number" ? p.timestamp : undefined;
    // Hermes replays the console messages it cached in answer to every
    // Runtime.enable. After a reconnect to the same runtime the older ones are
    // already in the inherited history; the ones logged while we were away are
    // not, and are exactly what the gap would otherwise have swallowed.
    if (this.handshaking && at !== undefined && at <= this.replayHorizon) return;
    if (at !== undefined && at > this.lastConsoleAt) this.lastConsoleAt = at;
    const args: any[] = Array.isArray(p.args) ? p.args : [];
    const entry: LogEntry = {
      seq: ++this.logSeq,
      level: levelMap[p.type] ?? "log",
      text: renderConsoleArgs(args),
      timestamp: at ?? Date.now(),
    };
    this.logs.push(entry);
    this.fillMissingPreviews(entry, args);
  }

  /**
   * A target that sends objects without a preview gets one Runtime.getProperties
   * per object, bounded in flight, and the entry is re-rendered when the
   * answer lands. Best effort: a busy thread or a chatty app keeps the
   * description ("Object") for what it could not afford.
   */
  private fillMissingPreviews(entry: LogEntry, args: any[]): void {
    for (const arg of args) {
      if (!wantsProperties(arg)) continue;
      // Queued, not dropped: on connect the runtime replays its whole console
      // buffer in one burst, and dropping past the in-flight bound left every
      // replayed object as a bare "Object".
      if (this.propertyQueue.length >= MAX_QUEUED_PROPERTY_FETCHES) return;
      this.propertyQueue.push({ entry, args, arg });
    }
    this.pumpPropertyFetches();
  }

  private pumpPropertyFetches(): void {
    while (this.propertyFetches < MAX_PROPERTY_FETCHES && this.propertyQueue.length > 0) {
      const { entry, args, arg } = this.propertyQueue.shift()!;
      this.propertyFetches++;
      this.client
        .send("Runtime.getProperties", { objectId: arg.objectId, ownProperties: true }, { timeoutMs: 3000 })
        .then((res: any) => {
          if (!Array.isArray(res?.result)) return;
          arg.preview = previewFromProperties(arg, res.result);
          entry.text = renderConsoleArgs(args);
        })
        .catch(() => {})
        .finally(() => {
          this.propertyFetches--;
          this.pumpPropertyFetches();
        });
    }
  }

  private onException(p: any): void {
    if (this.handedOver || !p) return;
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
    // Every expression leaves through here, so this is the one place an
    // astral character can be kept from reaching Hermes' compiler raw.
    const res = await this.client
      .send("Runtime.evaluate", { expression: escapeSurrogates(expression), returnByValue: true }, { timeoutMs })
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
      } else if (runtimeSeq > this.lastNetSeq) {
        const evicted = this.network.push(e);
        this.netIndex.set(e.seq, e);
        // The index only has to cover what the ring still holds; kept whole it
        // grew by every request (body included) for the life of the runtime.
        if (evicted) this.netIndex.delete(evicted.seq);
      }
      // An update to an entry already seen but since evicted is dropped:
      // re-adding it would put an old request at the end of the list.
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
    // A runtime installed into gets an id, so a later reconnect can tell
    // "same runtime, carry on" from "the app restarted" (Registry.connect).
    if (only === undefined && this.runtimeId === undefined) await this.stampRuntime();
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

type ConnectOpts = { port?: number; targetId?: string; device?: string; deviceId?: string };

/**
 * Narrows targets to a device by name. An exact name wins over containment —
 * "iPhone 15" used to attach to "iPhone 15 Pro" whenever Metro listed it first
 * — and containment that fits several devices is an error, not a coin toss.
 */
function filterByDevice(targets: MetroTarget[], device: string | undefined): MetroTarget[] {
  if (!device) return targets;
  const needle = normalizeName(device);
  const names = (m: MetroTarget) => [m.target.deviceName ?? "", m.target.title ?? ""].map(normalizeName);
  const exact = targets.filter((m) => names(m).some((n) => n === needle));
  if (exact.length > 0) return exact;
  const contained = targets.filter((m) => names(m).some((n) => n.length > 0 && n.includes(needle)));
  const devices = [...new Set(contained.map((m) => m.target.deviceName ?? m.target.title))];
  if (devices.length > 1) {
    throw new ConnectionError(
      `device "${device}" matches several devices Metro reports: ${devices.map((d) => `"${d}"`).join(", ")} — pass the full name, or a target_id from list_targets`,
    );
  }
  return contained;
}

function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, " ").trim();
}

export class Registry {
  private conn?: Connection;
  /** The handshake in flight, if any — see connect(). */
  private connecting?: Promise<Connection>;
  /** ensure()'s re-attach in flight, shared by every caller that needs it. */
  private reconnecting?: Promise<Connection>;
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

  /**
   * One handshake at a time. Parallel tool calls after a drop each reconnected
   * on their own: several sockets to one app, which on a single-debugger RN
   * kicked each other off mid-call and on a multi-debugger one leaked.
   */
  async connect(opts?: ConnectOpts): Promise<Connection> {
    while (this.connecting) await this.connecting.catch(() => undefined);
    const attempt = this.doConnect(opts);
    this.connecting = attempt;
    try {
      return await attempt;
    } finally {
      if (this.connecting === attempt) this.connecting = undefined;
    }
  }

  private async doConnect(opts?: ConnectOpts): Promise<Connection> {
    let metroTarget: MetroTarget | undefined;
    const wantPort = opts?.port ?? this.defaultPort;

    if (wantPort) {
      const targets = filterByDevice((await fetchTargets(wantPort)).map((target) => ({ port: wantPort, target })), opts?.device);
      metroTarget = opts?.targetId
        ? targets.find((m) => m.target.id === opts.targetId)
        : (() => {
            const t = pickHermesTarget(targets.map((m) => m.target));
            return t ? { port: wantPort, target: t } : undefined;
          })();
    } else {
      const wanted = filterByDevice(await discoverMetro(), opts?.device);
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

    const prev = this.conn;
    const meta = targetMeta(metroTarget.port, metroTarget.target, opts?.deviceId);
    // The same app again (a reconnect after a drop, a reload that changed the
    // target id, connect called twice): its history carries over instead of
    // vanishing — the logs before a crash are the ones that matter most.
    const history = prev && sameApp(prev.meta, meta) ? prev : undefined;

    const client = new CdpClient(metroTarget.target.webSocketDebuggerUrl);
    await client.connect();
    // The Connection, and with it every listener, exists before Runtime.enable:
    // the target answers it with the live execution context and with the
    // console messages Hermes cached, and both used to arrive before anything
    // was listening for them.
    const conn = new Connection(client, meta, { history });
    history?.handOver();
    try {
      conn.beginHandshake();
      await client.send("Runtime.enable");
      await client.send("Log.enable").catch(() => {});
      conn.endHandshake();
      if (history) {
        // A different id (or none readable) means the app restarted while we
        // were away: the old runtime's request seqs and errors are history.
        const id = await conn.stampRuntime();
        if (id === undefined || id !== history.runtimeId) {
          conn.markRuntimeReplaced();
          conn.runtimeId = id;
        }
      }
      await conn.installInterceptors();
    } catch (err) {
      // A failed handshake must not leave its socket open, nor the previous
      // connection (if it is still up) without its record.
      conn.handOver();
      history?.takeBack();
      client.close();
      throw err;
    }
    // Only now: closing first left the session with nothing when this failed.
    if (prev && prev !== conn) prev.close();
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
  // to start Metro, which is usually already running. Callers arriving while
  // a (re)connect is under way share it rather than starting their own.
  async ensure(): Promise<Connection> {
    if (this.conn?.connected) return this.conn;
    if (this.connecting) {
      const c = await this.connecting.catch(() => undefined);
      if (c?.connected) return c;
      if (this.conn?.connected) return this.conn;
    }
    if (!this.everConnected || !this.last) throw new ConnectionError(this.notConnectedReason());
    this.reconnecting ??= this.reconnect().finally(() => {
      this.reconnecting = undefined;
    });
    return this.reconnecting;
  }

  /**
   * For tools that read what was already captured (get_logs, get_errors, the
   * get_network list): a live connection when one can be had, otherwise the
   * last one, with why it is gone. The record of an app that just crashed is
   * the one worth reading; refusing it because the app is gone hid it.
   */
  async ensureOrLast(): Promise<{ conn: Connection; lost?: string }> {
    try {
      return { conn: await this.ensure() };
    } catch (err) {
      if (err instanceof ConnectionError && this.conn) return { conn: this.conn, lost: err.message };
      throw err;
    }
  }

  private async reconnect(): Promise<Connection> {
    const last = this.last!;
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
  /**
   * optional(), plus the record of a connection that is gone: a tool that can
   * work without the runtime (observe) still has what was captured before it
   * dropped, and why it is gone.
   */
  async optionalOrLast(): Promise<{ conn?: Connection; lost?: { conn: Connection; reason: string } }> {
    if (this.conn?.connected) return { conn: this.conn };
    if (!this.everConnected) return {};
    try {
      return { conn: await this.ensure() };
    } catch (err) {
      return this.conn ? { lost: { conn: this.conn, reason: err instanceof Error ? err.message : String(err) } } : {};
    }
  }

  async optional(): Promise<Connection | undefined> {
    if (this.conn?.connected) return this.conn;
    if (!this.everConnected) return undefined;
    return this.ensure().catch(() => undefined);
  }

  reset(): void {
    this.conn?.close();
    this.conn = undefined;
    this.connecting = undefined;
    this.reconnecting = undefined;
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
