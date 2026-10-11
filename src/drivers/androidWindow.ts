// Where React Native's Android `measureInWindow` puts its (0,0) on the screen.
//
// RN subtracts the window's *visible display frame* origin from every
// measurement, on both architectures (Paper: NativeViewHierarchyManager
// .measureInWindow; Fabric: the root's viewportOffset = root location −
// getWindowVisibleDisplayFrame().topLeft, applied with includeViewportOffset).
// So screen px = visibleFrameOrigin + measureInWindow dp × density.
//
// getWindowVisibleDisplayFrame() is the window's display frame inset by its
// *visible* insets (ViewRootImpl → InsetsState.calculateVisibleInsets): the
// visible system bars (status, navigation, caption) and the display cutout,
// each intersected with the window frame (InsetsSource.calculateInsets); the
// IME only ever insets the bottom, gesture/tappable-element insets never
// count, and FLAG_LAYOUT_NO_LIMITS clears them all for an app window. That is
// what this file recomputes from `dumpsys window`, top and left only:
//
//   * edge-to-edge window (frame = whole screen): status bar / cutout height;
//   * classic window laid out below the bar: the window's own top (the bar
//     does not intersect it);
//   * immersive: the cutout if the device has one, else 0.
//
// It is read from the system server rather than from the app because the app
// has no API for it: StatusBar.currentHeight is a constant even while the bar
// is hidden.

export const WINDOW_DUMP_CMD = "dumpsys window displays; dumpsys window windows";

type Rect = { l: number; t: number; r: number; b: number };
type Source = { type: string; frame: Rect; visible: boolean; side?: string; forceConsuming: boolean };

const RECT_RE = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;

function rect(s: string | undefined): Rect | undefined {
  const m = s ? RECT_RE.exec(s) : null;
  return m ? { l: +m[1], t: +m[2], r: +m[3], b: +m[4] } : undefined;
}

const OLD_TYPES: Record<string, string> = {
  ITYPE_STATUS_BAR: "statusBars",
  ITYPE_CLIMATE_BAR: "statusBars",
  ITYPE_NAVIGATION_BAR: "navigationBars",
  ITYPE_EXTRA_NAVIGATION_BAR: "navigationBars",
  ITYPE_CAPTION_BAR: "captionBar",
};

function normType(t: string): string {
  if (OLD_TYPES[t]) return OLD_TYPES[t];
  if (/^ITYPE_.*DISPLAY_CUTOUT$/.test(t)) return "displayCutout";
  return t;
}

/** The types InsetsState.calculateVisibleInsets counts (the IME only insets the bottom). */
const VISIBLE_TYPES = new Set(["statusBars", "navigationBars", "captionBar", "displayCutout"]);

/**
 * The display's InsetsState sources. Taken from the first `InsetsState` block
 * (display 0, the one the app is on); the provider dumps below it repeat the
 * same sources as `mSource=`, and are used only when that block is missing.
 */
function parseSources(dump: string): Source[] {
  const lines = dump.split("\n");
  const start = lines.findIndex((l) => /^\s*InsetsState\s*$/.test(l));
  let block: string[] = [];
  if (start >= 0) {
    for (let i = start + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/InsetsSource\b/.test(l) && !/mSource=/.test(l)) block.push(l);
      else if (/^\s*(Control map|InsetsSourceProviders|InsetsPolicy)/.test(l)) break;
    }
  }
  if (!block.length) block = lines.filter((l) => /InsetsSource\b.*\btype=/.test(l));
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const l of block) {
    const type = /\btype=(\w+)/.exec(l)?.[1];
    const frame = rect(/\bframe=(\S+)/.exec(l)?.[1]);
    const vis = /\bvisible=(true|false)/.exec(l)?.[1];
    if (!type || !frame || !vis) continue;
    const key = `${/\bid=(\S+)/.exec(l)?.[1] ?? ""}|${type}|${l.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      type: normType(type),
      frame,
      visible: vis === "true",
      side: /\bsideHint=(\w+)/.exec(l)?.[1],
      forceConsuming: /\bflags=\S*FORCE_CONSUMING/.test(l),
    });
  }
  return out;
}

type WindowInfo = { display: Rect; frame: Rect; noLimits: boolean };

/** Window blocks of `dumpsys window windows`, keyed by their header line. */
function windowBlocks(dump: string): { header: string; body: string }[] {
  const parts = dump.split(/\n(?=\s*Window #\d+ Window\{)/);
  return parts
    .filter((p) => /^\s*Window #\d+ Window\{/.test(p))
    .map((p) => {
      const nl = p.indexOf("\n");
      return { header: nl < 0 ? p : p.slice(0, nl), body: nl < 0 ? "" : p.slice(nl + 1) };
    });
}

function windowInfo(body: string): WindowInfo | undefined {
  const frames = /Frames:.*?\bdisplay=(\S+).*?\bframe=(\S+)/.exec(body);
  const display = rect(frames?.[1]);
  const frame = rect(frames?.[2]);
  if (!display || !frame) return undefined;
  // The window's own `fl=` line, not one from a per-rotation override block.
  const fl = /^\s{6}fl=(.*)$/m.exec(body)?.[1] ?? "";
  return { display, frame, noLimits: /\bLAYOUT_NO_LIMITS\b/.test(fl) };
}

/**
 * The window whose measurements RN reports: the focused app's activity window
 * (BASE_APPLICATION). A popup, a dialog or a Modal may hold input focus, but
 * Fabric measures their content against the activity's root surface.
 */
function appWindow(dump: string): WindowInfo | undefined {
  const blocks = windowBlocks(dump);
  const focusedApp = /mFocusedApp=ActivityRecord\{(\w+)/.exec(dump)?.[1];
  if (focusedApp) {
    const own = blocks.find(
      (b) => b.body.includes(`mActivityRecord=ActivityRecord{${focusedApp} `) && /\bty=BASE_APPLICATION\b/.test(b.body),
    );
    const info = own && windowInfo(own.body);
    if (info) return info;
  }
  const focus = /mCurrentFocus=Window\{(\w+)/.exec(dump)?.[1];
  if (focus) {
    const b = blocks.find((x) => x.header.includes(`Window{${focus} `));
    const info = b && windowInfo(b.body);
    if (info) return info;
  }
  return undefined;
}

/**
 * Whether the focused activity shows a second window over its own — a Dialog
 * (which is what RN's LogBox inspector and Modal are on Android) — big enough
 * to cover the app: at least 60 % of the activity window's frame, the same
 * threshold the JS layout uses for a LogBox overlay.
 *
 * It exists because the app runtime cannot answer this (field test 3 D38):
 * LogBox's inspector surface is created, laid out and measurable whether or
 * not its dialog was ever shown — `measure`, `measureInWindow` and
 * `getBoundingClientRect` return byte-identical frames in both states, and
 * NativeLogBox exposes only show()/hide(). The window list is the only
 * witness. A small popup of the same activity (the dev "Refreshing…" banner
 * is one, 1440x93 px) is not an overlay.
 *
 * undefined when the dump does not name the focused activity or its base
 * window: the caller then keeps whatever the JS layout concluded.
 */
export function overlayWindowShown(dump: string): boolean | undefined {
  const focusedApp = /mFocusedApp=ActivityRecord\{(\w+)/.exec(dump)?.[1];
  if (!focusedApp) return undefined;
  const own = windowBlocks(dump).filter((b) => b.body.includes(`mActivityRecord=ActivityRecord{${focusedApp} `));
  const base = own.find((b) => /\bty=BASE_APPLICATION\b/.test(b.body));
  const baseFrame = base && windowInfo(base.body)?.frame;
  if (!baseFrame) return undefined;
  const area = (r: Rect) => Math.max(0, r.r - r.l) * Math.max(0, r.b - r.t);
  const need = area(baseFrame) * 0.6;
  if (!(need > 0)) return undefined;
  return own.some((b) => {
    if (b === base || !/\bmHasSurface=true\b/.test(b.body)) return false;
    const f = windowInfo(b.body)?.frame;
    return !!f && area(f) >= need;
  });
}

function intersect(a: Rect, b: Rect): Rect | undefined {
  const r = { l: Math.max(a.l, b.l), t: Math.max(a.t, b.t), r: Math.min(a.r, b.r), b: Math.min(a.b, b.b) };
  return r.r > r.l && r.b > r.t ? r : undefined;
}

/** InsetsSource.calculateInsets, the left and top results only. */
function sourceInsets(s: Source, win: Rect): { left: number; top: number } {
  const none = { left: 0, top: 0 };
  if (!s.visible) return none;
  if (s.type === "captionBar") return { left: 0, top: s.frame.b - s.frame.t };
  const i = intersect(s.frame, win);
  if (!i) return none;
  const w = i.r - i.l;
  const h = i.b - i.t;
  const fw = win.r - win.l;
  const fh = win.b - win.t;
  const side = s.side ?? "LEFT";
  if (i.l === win.l && i.t === win.t && w === fw && h === fh) {
    if (side === "TOP") return { left: 0, top: h };
    if (side === "LEFT" || side === "NONE") return { left: w, top: 0 };
    return none;
  }
  if (w === fw) {
    if (i.t === win.t) return { left: 0, top: h };
    if (i.b === win.b) return none;
    if (i.t === 0) return { left: 0, top: h };
    return none;
  }
  if (h === fh) return i.l === win.l ? { left: w, top: 0 } : none;
  if (side === "LEFT" && i.l === win.l) return { left: w, top: 0 };
  if (side === "TOP" && i.t === win.t) return { left: 0, top: h };
  return none;
}

/**
 * Top-left of the focused app window's visible display frame, in screen px,
 * from the output of WINDOW_DUMP_CMD. undefined when the dump does not say
 * (no app window, no InsetsState — API < 30) — the caller then keeps origin 0
 * rather than guessing.
 */
export function visibleFrameOrigin(dump: string): { x: number; y: number } | undefined {
  const win = appWindow(dump);
  if (!win) return undefined;
  const sources = parseSources(dump).filter((s) => VISIBLE_TYPES.has(s.type));
  if (!sources.length) return undefined;
  // InsetsState.clearsCompatInsets for an app (ACTIVITY_TYPE_STANDARD) window.
  const cleared = win.noLimits && !sources.some((s) => s.forceConsuming);
  let left = 0;
  let top = 0;
  if (!cleared) {
    for (const s of sources) {
      const ins = sourceInsets(s, win.frame);
      left = Math.max(left, ins.left);
      top = Math.max(top, ins.top);
    }
  }
  return { x: win.display.l + left, y: win.display.t + top };
}

/**
 * Everything the tools read from one WINDOW_DUMP_CMD: the app-space origin and
 * whether a dialog-sized window of the app is up. One dump, one round trip.
 */
export function appWindowState(dump: string): { x: number; y: number; overlayWindow?: boolean } | undefined {
  const o = visibleFrameOrigin(dump);
  if (!o) return undefined;
  const overlayWindow = overlayWindowShown(dump);
  return overlayWindow === undefined ? o : { ...o, overlayWindow };
}
