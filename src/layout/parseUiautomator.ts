import type { RawElement, Viewport } from "../drivers/types.js";

// Opening (<node …> or <node …/>) and closing (</node>) tags, in document order.
const TAG_RE = /<node\b([^>]*?)(\/?)>|<\/node\s*>/g;
const ATTR_RE = /(\w[\w-]*)="([^"]*)"/g;
const BOUNDS_RE = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/;
/** Windows that are never "the screen": status/navigation bars, shade, keyboards. */
const SYSTEM_WINDOW_RE = /^com\.android\.systemui$|inputmethod|honeyboard|swiftkey/;
/** Keyboards: their keys would match text searches and taps. */
const KEYBOARD_PACKAGE_RE = /inputmethod|honeyboard|swiftkey/;

// Attribute values arrive XML-escaped: without decoding, a label like
// "Tom & Jerry" is stored as "Tom &amp; Jerry" and no search for it ever matches.
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

type Scanned = RawElement & { area: number; depth: number; pkg: string; toast?: boolean };

const isToastClass = (cls: string | undefined) => !!cls && /(^|\.)Toast$/.test(cls);

/**
 * Where the system draws a default toast: the bottom-centre band of the screen
 * (ViewHierarchy.toastBounds in native/android-server, same arithmetic). The
 * server's toast node is synthetic — built from an accessibility event, not a
 * window — and a server build older than that fix sends `[0,0][0,0]`.
 */
function toastBand(v: Viewport): { x: number; y: number; w: number; h: number } {
  const bottom = v.y + v.h - Math.trunc(v.h / 10);
  const x = v.x + Math.trunc(v.w / 10);
  const h = Math.trunc(v.h / 20);
  return { x, y: bottom - h, w: v.w - 2 * Math.trunc(v.w / 10), h };
}

export function parseUiautomator(xml: string): RawElement[] {
  const raw: Scanned[] = [];
  const roots: Scanned[] = [];
  let depth = 0;
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(xml))) {
    if (m[1] === undefined) {
      depth = Math.max(0, depth - 1); // </node>
      continue;
    }
    const nodeDepth = depth;
    if (m[2] !== "/") depth++;
    const attrs: Record<string, string> = {};
    let a: RegExpExecArray | null;
    ATTR_RE.lastIndex = 0;
    while ((a = ATTR_RE.exec(m[1]))) attrs[a[1]] = decodeXmlEntities(a[2]);
    const bounds = attrs.bounds ? BOUNDS_RE.exec(attrs.bounds) : null;
    if (!bounds) continue;
    const x1 = +bounds[1], y1 = +bounds[2], x2 = +bounds[3], y2 = +bounds[4];
    const w = x2 - x1;
    const h = y2 - y1;
    const pkg = attrs.package ?? "";
    const toast = isToastClass(attrs.class);
    // Window roots (depth 0) are the viewport candidates, labelled or not. The
    // server's toast is a depth-0 node too, but not a window: over a system-UI
    // screen it would otherwise be the only non-system "root".
    if (nodeDepth === 0 && w > 0 && h > 0 && !toast) roots.push({ x: x1, y: y1, w, h, area: w * h, depth: 0, pkg });
    if (KEYBOARD_PACKAGE_RE.test(pkg)) continue;
    const rid = attrs["resource-id"] || "";
    const testID = rid.includes(":id/") ? rid.split(":id/")[1] : rid || undefined;
    // hintText (Android server only): an empty field is findable by its placeholder.
    const text = attrs.text || attrs["content-desc"] || attrs.hintText || undefined;
    if (!text && !testID) continue;
    const type = attrs.class ? attrs.class.split(".").pop() : undefined;
    raw.push({ text, testID: testID || undefined, type, x: x1, y: y1, w, h, area: w * h, depth: nodeDepth, pkg, toast });
  }

  // The viewport is the largest window root that is not system UI. uiautomator
  // dump has one root covering the display; the Android server has one per
  // window, and the status bar comes first. Only roots count: a scroll
  // container can be taller than the screen.
  const largest = (xs: Scanned[]) =>
    xs.reduce<Scanned | undefined>((best, r) => (!best || r.area > best.area ? r : best), undefined);
  const root = largest(roots.filter((r) => !SYSTEM_WINDOW_RE.test(r.pkg))) ?? largest(roots);
  const viewport: Viewport | undefined = root ? { x: root.x, y: root.y, w: root.w, h: root.h } : undefined;

  const out: RawElement[] = [];
  for (const e of raw) {
    if (!e.text && !e.testID) continue;
    if (e.w <= 0 || e.h <= 0) {
      // A toast is on screen even when its node has no bounds (see toastBand).
      if (!e.toast || !viewport) continue;
      Object.assign(e, toastBand(viewport));
    }
    const { area: _area, depth: _depth, pkg: _pkg, toast: _toast, ...el } = e;
    if (viewport) {
      const x1 = Math.max(el.x, viewport.x);
      const y1 = Math.max(el.y, viewport.y);
      const x2 = Math.min(el.x + el.w, viewport.x + viewport.w);
      const y2 = Math.min(el.y + el.h, viewport.y + viewport.h);
      // Clipped, not just flagged: the centre of a row half past the edge is not
      // where a tap must land.
      if (x2 <= x1 || y2 <= y1) el.offscreen = true;
      else if (x1 !== el.x || y1 !== el.y || x2 - x1 !== el.w || y2 - y1 !== el.h) {
        el.visible = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
      }
    }
    out.push(el);
  }
  return out;
}
