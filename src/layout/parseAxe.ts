import type { RawElement, Viewport } from "../drivers/types.js";

type AxeNode = {
  AXLabel?: string;
  AXValue?: string;
  AXIdentifier?: string;
  type?: string;
  frame?: { x: number; y: number; width: number; height: number };
  children?: AxeNode[];
};

// iOS scroll indicators are accessibility elements too; they carry a label and a
// frame, so without this they show up as "interactive" alongside real controls.
export const SYSTEM_LABEL_RE = /\b(scroll bar|scrollbar|dimming view)\b/i;
const CONTAINER_TYPES = new Set(["Application", "Window"]);

/** The part of the frame inside the window, or null when nothing of it shows. */
export function clipToViewport(e: { x: number; y: number; w: number; h: number }, vp?: Viewport) {
  if (!vp) return { x: e.x, y: e.y, w: e.w, h: e.h };
  const x1 = Math.max(e.x, vp.x);
  const y1 = Math.max(e.y, vp.y);
  const x2 = Math.min(e.x + e.w, vp.x + vp.w);
  const y2 = Math.min(e.y + e.h, vp.y + vp.h);
  if (x2 <= x1 || y2 <= y1) return null;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export function parseAxe(json: string): RawElement[] {
  let nodes: AxeNode[];
  try {
    const parsed = JSON.parse(json);
    nodes = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }

  // The window's own frame is the viewport; content scrolled out of it keeps a
  // frame far outside the screen and must not be offered as tappable.
  let viewport: Viewport | undefined;
  const considerViewport = (n: AxeNode): void => {
    if (!n.frame) return;
    const area = n.frame.width * n.frame.height;
    if (!CONTAINER_TYPES.has(n.type ?? "") && viewport) return;
    if (!viewport || area > viewport.w * viewport.h) {
      viewport = { x: n.frame.x, y: n.frame.y, w: n.frame.width, h: n.frame.height };
    }
  };
  for (const n of nodes) {
    considerViewport(n);
    for (const c of n.children ?? []) considerViewport(c);
  }

  const out: RawElement[] = [];
  const seen = new Set<string>();
  const visit = (node: AxeNode): void => {
    const label = node.AXLabel || node.AXValue || undefined;
    const id = node.AXIdentifier || undefined;
    if (node.frame && (label || id) && !CONTAINER_TYPES.has(node.type ?? "")) {
      const el: RawElement = {
        // AXIdentifier is RN's testID; AXLabel is the accessibilityLabel.
        text: label,
        testID: id,
        type: node.type || undefined,
        x: node.frame.x,
        y: node.frame.y,
        w: node.frame.width,
        h: node.frame.height,
      };
      const isSystem = SYSTEM_LABEL_RE.test(label ?? "") || /scrollbar/i.test(node.type ?? "");
      const dedupe = `${el.text ?? ""}|${el.testID ?? ""}|${el.x},${el.y},${el.w},${el.h}`;
      if (!isSystem && el.w > 0 && el.h > 0 && !seen.has(dedupe)) {
        seen.add(dedupe);
        const vis = clipToViewport(el, viewport);
        if (!vis) el.offscreen = true;
        else if (vis.x !== el.x || vis.y !== el.y || vis.w !== el.w || vis.h !== el.h) el.visible = vis;
        out.push(el);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const n of nodes) visit(n);
  return out;
}
