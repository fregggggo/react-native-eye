export type Platform = "ios" | "android";

/** Which OS-level mechanism delivered an input or captured a layout. */
export type OsPathKind = "runner" | "axe" | "adb";
/**
 * `reason` says why the runner was not used ("runner starting",
 * "runner failed: <why>", "unsupported: <symbol>"). It is absent when
 * `path` is "runner", and always absent before the runner exists.
 */
export type OsPath = { path: OsPathKind; reason?: string };

export type DeviceId = { platform: Platform; udid: string; name: string; booted: boolean };

export type RawElement = {
  text?: string;
  testID?: string;
  type?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Outside the visible viewport (scrolled away): present in the tree, not tappable. */
  offscreen?: boolean;
  /** The part of the frame actually inside the viewport — where a tap must land. */
  visible?: { x: number; y: number; w: number; h: number };
  /** Mounted but not on screen: an inactive tab/screen, display:none, or covered. */
  hidden?: boolean;
  /**
   * Why: `covered` — under a LogBox redbox or toast; `window` — in a window
   * that is not on screen (LogBox's inspector, selected in JS but never shown).
   */
  hiddenBy?: "style" | "covered" | "inactive-screen" | "window";
  /** JS layout only: inside the LogBox inspector's own subtree. */
  overlay?: boolean;
  /**
   * JS layout only: what this element was before a LogBox overlay marked it
   * covered — kept so the verdict can be withdrawn when the OS says no such
   * window is on screen (D38).
   */
  beneath?: "visible" | "inactive-screen" | "covered";
  /** An unlabelled icon inside a pressable — addressable, but noise in a listing. */
  decorative?: boolean;
  /** A container whose text is just its children's labels glued together. */
  container?: boolean;
};

export type Viewport = { x: number; y: number; w: number; h: number };

export type RecordingHandle = { finalize(): Promise<void> };

/**
 * One row of a CPU sample: a thread, or one dispatch queue that ran on it —
 * macOS `sample` reports the same tid several times when queues hop threads,
 * and collapsing those rows would attribute 600 idle samples to the queue that
 * happened to contribute one.
 */
export type CpuThread = {
  /** `sample`'s Thread_<id> on iOS, the TID on Android. */
  id: string;
  name?: string;
  /**
   * What the thread does in a React Native app. Which of `main` (the UI thread)
   * and `js` (Hermes) is hot is the whole question this sample exists to answer.
   */
  role: "main" | "js" | "render" | "shadow" | "other";
  /** Fraction (0..1) of the app's busy CPU attributed to this row. */
  share: number;
  /**
   * iOS: fraction (0..1) of this row's wall-clock samples that were NOT parked
   * in a blocking syscall. `sample` samples every thread on every tick whether
   * it is running or asleep, so a raw sample count says nothing about load —
   * this is the number that means "the main thread was working 12% of the time".
   */
  busyFraction?: number;
  /** Android: %CPU exactly as `top` reports it, where 100% is one full core. */
  cpuPercent?: number;
  /** Hottest non-blocking leaf frames inside this row, when the platform has frames. */
  topFrames?: { frame: string; share: number }[];
};

export type CpuSample = {
  pid: number;
  durationS: number;
  /** Stack samples taken across all threads (macOS `sample`); Android has no such count. */
  totalSamples?: number;
  /** Of those, the ones not parked in a blocking syscall. */
  busySamples?: number;
  threads: CpuThread[];
  /** The head of an output that could not be parsed — a format change must be visible, not silent. */
  unparsed?: string;
  /** Platform caveat for the tool to print next to the table. */
  note?: string;
};

export type FrameStats = {
  durationMs: number;
  /** Per-frame FrameCompleted − IntendedVsync in ms, in the order the app rendered them. */
  frameDurationsMs: number[];
  /** The platform's own counters, which cover the same window but count differently. */
  totalRendered?: number;
  jankyFrames?: number;
  jankyPct?: number;
  percentilesMs?: { p50?: number; p90?: number; p95?: number; p99?: number };
  unparsed?: string;
};

export interface DeviceDriver {
  platform: Platform;
  listDevices(): Promise<DeviceId[]>;
  screenshotPng(udid: string): Promise<Buffer>;
  screenshotFile(udid: string, path: string, opts: { format: "png" | "jpeg"; mask?: "ignored" | "alpha" | "black" }): Promise<void>;
  /** `os` names the path that produced the tree, so layout output can report it. */
  rawLayout(udid: string): Promise<{ els: RawElement[]; os: OsPath }>;
  tapXY(udid: string, x: number, y: number, durationMs?: number): Promise<OsPath>;
  swipe(udid: string, x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<OsPath>;
  typeText(udid: string, text: string): Promise<OsPath>;
  pressKey(udid: string, key: "back" | "home", opts?: { viewport?: Viewport }): Promise<OsPath>;
  launchApp(udid: string, appId: string, opts?: { env?: Record<string, string>; terminateRunning?: boolean }): Promise<void>;
  installApp(udid: string, appPath: string): Promise<void>;
  recordStart(udid: string, localPath: string, opts?: { codec?: "hevc" | "h264" }): Promise<RecordingHandle>;
  /**
   * Multiplier from JS layout units to the units tap/swipe take. iOS points map
   * 1:1 to axe coordinates; Android `input` works in physical pixels while RN
   * measures in dp, so JS coordinates must be scaled by density/160.
   */
  pointScale?(udid: string): Promise<number>;
  /**
   * Where the app's measureInWindow (0,0) sits on the screen, in the driver's
   * units: screen = origin + app × pointScale (see src/layout/appSpace.ts,
   * which caches it). Android: top-left of the app window's visible display
   * frame — the status bar height on an edge-to-edge window. Absent (iOS):
   * origin 0. undefined when it cannot be read — callers keep origin 0.
   *
   * `overlayWindow` rides on the same read: whether a dialog-sized window of
   * the app (LogBox's inspector, a Modal) is on screen above its activity
   * window. Left out when the driver cannot tell. It is the OS-side witness
   * for a JS "LogBox covers the screen" verdict, which the runtime alone
   * cannot confirm (field test 3 D38).
   */
  appOrigin?(udid: string): Promise<{ x: number; y: number; overlayWindow?: boolean } | undefined>;
  /** Screen size in the driver's own input units, when it can be had cheaply. */
  screenSize?(udid: string): Promise<{ w: number; h: number } | undefined>;
  /**
   * Screenshot pixels per tap unit: how many pixels of screenshotPng() make one
   * unit of tapXY(). iOS: the simulator's screen scale (axe taps in points,
   * simctl shoots pixels). Android: 1. undefined when unknown — never throws.
   */
  screenScale?(udid: string): Promise<number | undefined>;
  /** Open a deeplink/universal link. Touch-free, so unaffected by degraded touch delivery. */
  openUrl?(udid: string, url: string): Promise<void>;
  /** Grant, revoke or reset one privacy permission for an app. */
  setPermission?(udid: string, appId: string, service: string, status: "grant" | "revoke" | "reset"): Promise<void>;
  /**
   * Per-thread CPU over `durationS`. Optional: only a platform that can sample a
   * running app with nothing installed into it implements this.
   */
  cpuSample?(udid: string, appId: string, durationS: number): Promise<CpuSample>;
  /**
   * UI-thread frame timing over `durationMs`, from the platform's own frame
   * counters. Optional: the iOS simulator exposes none (CADisplayLink needs
   * native code, xctrace's Core Animation instrument needs a physical device).
   */
  frameStats?(udid: string, appId: string, durationMs: number): Promise<FrameStats>;
}
