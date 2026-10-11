import type { Viewport } from "../drivers/types.js";

export type Direction = "up" | "down" | "left" | "right";

// Swipe vectors used to be hard-coded twice (tap tool and run_flow) in absolute
// coordinates, which on a 1080x2400 Android screen turned "swipe up" into a
// short stroke in the top-left corner. They are derived from the viewport now,
// with the old constants as the fallback when the screen size is unknown.
const FALLBACK: Viewport = { x: 0, y: 0, w: 400, h: 800 };

export function swipeVector(direction: Direction, viewport?: Viewport): [number, number, number, number] {
  const vp = viewport && viewport.w > 0 && viewport.h > 0 ? viewport : FALLBACK;
  const cx = Math.round(vp.x + vp.w / 2);
  const cy = Math.round(vp.y + vp.h / 2);
  const dx = Math.round(vp.w * 0.35);
  const dy = Math.round(vp.h * 0.25);
  switch (direction) {
    case "up":
      return [cx, cy + dy, cx, cy - dy];
    case "down":
      return [cx, cy - dy, cx, cy + dy];
    case "left":
      return [cx + dx, cy, cx - dx, cy];
    case "right":
      return [cx - dx, cy, cx + dx, cy];
  }
}
