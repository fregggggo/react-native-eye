import { captureLayout, type EvalConn } from "../tools/layout.js";
import { formatLayout, type Element } from "../layout/elements.js";
import type { DeviceDriver } from "../drivers/types.js";

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Waits for the app to paint: two rAF ticks confirm a frame rendered. The outer
// setTimeout is a hard cap in case rAF never fires (suspended app).
//
// InteractionManager is deliberately *not* consulted through globalThis — it is a
// module, never a global in React Native, so the old branch could not run. An app
// that wants precise settling can expose its own hook as __RNE_SETTLE__(cb).
export function settleExpression(capMs: number): string {
  return `new Promise(function (resolve) {
    var done = false;
    function finish() { if (!done) { done = true; resolve("settled"); } }
    setTimeout(finish, ${capMs});
    if (typeof requestAnimationFrame !== "function") return finish();
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      var hook = globalThis.__RNE_SETTLE__;
      if (typeof hook === "function") { try { hook(finish); return; } catch (e) {} }
      finish();
    }); });
  })`;
}

export async function settleLayout(
  driver: DeviceDriver,
  udid: string,
  opts?: {
    fixedMs?: number;
    maxMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    conn?: EvalConn;
  },
): Promise<Element[]> {
  const sleep = opts?.sleep ?? realSleep;
  const now = opts?.now ?? (() => Date.now());
  // Settling is best-effort: it exists to pace the next step, so a failed layout
  // capture (e.g. axe timing out on a heavy screen) must not fail a step whose
  // interaction already succeeded.
  if (typeof opts?.fixedMs === "number") {
    if (opts.fixedMs > 0) await sleep(opts.fixedMs);
    return captureLayout(driver, udid, { conn: opts?.conn }).catch(() => []);
  }
  const maxMs = opts?.maxMs ?? 1000;
  if (opts?.conn) {
    try {
      await opts.conn.evaluate(settleExpression(maxMs), { timeoutMs: maxMs + 5000 });
      return await captureLayout(driver, udid, { conn: opts.conn }).catch(() => []);
    } catch {
      // dead runtime — fall back to layout-diff settling below
    }
  }
  const intervalMs = opts?.intervalMs ?? 100;
  const start = now();
  let prev: Element[];
  try {
    prev = await captureLayout(driver, udid, { conn: opts?.conn });
  } catch {
    return [];
  }
  let prevStr = formatLayout(prev);
  while (now() - start < maxMs) {
    await sleep(intervalMs);
    let cur: Element[];
    try {
      cur = await captureLayout(driver, udid, { conn: opts?.conn });
    } catch {
      return prev;
    }
    const curStr = formatLayout(cur);
    if (curStr === prevStr) return cur;
    prev = cur;
    prevStr = curStr;
  }
  return prev;
}
