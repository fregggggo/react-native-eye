import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deviceContext } from "./context.js";
import { captureLayout, captureLayoutWithSource, resolveViewport, type EvalConn } from "./layout.js";
import {
  findByText,
  findByTestID,
  isVisible,
  layoutDiff,
  matchingElements,
  sameElement,
  type Element,
} from "../layout/elements.js";
import { swipeVector, type Direction } from "../layout/gestures.js";
import { settleLayout } from "../composite/settle.js";
import { scrollToExpression, type ScrollResult } from "../input/scroll.js";
import { foregroundGuarded, notForeground } from "../input/appState.js";
import type { PressTarget } from "../input/press.js";
import { recordTouch, hotNotice } from "../input/hotState.js";
import { text } from "../core/format.js";
import { toToolError, UserInputError, DriverError } from "../core/errors.js";
import type { DeviceDriver, OsPath, Viewport } from "../drivers/types.js";
import {
  dispatchTap,
  dispatchType,
  dispatchSwipe,
  dispatchBack,
  dispatchSubmit,
  osMarker,
  type Dispatched,
  type InputVia,
} from "../input/dispatch.js";
import type { InputTarget } from "../input/text.js";
import { resolveAppSpace, toAppPoint } from "../layout/appSpace.js";

export type Selector = { text?: string; testID?: string; x?: number; y?: number };

/**
 * Refuses points outside the screen. A touch there is clamped or dropped by
 * the OS, and a JS press finds nothing — either way the caller was told
 * "tapped" about a tap that went nowhere.
 *
 * The screen size is the cheap read and settles almost every call. Only a
 * point outside it (or no size at all) pays for the app's root frame, and the
 * area is then the union of the two, because each can be wrong alone:
 * Android's `wm size` stays portrait in landscape, and the root frame can stop
 * short of the system bars a caller may legitimately touch. Nothing known,
 * nothing refused.
 */
export async function checkOnScreen(
  driver: DeviceDriver,
  udid: string,
  conn: EvalConn | undefined,
  points: [number, number][],
  what: string,
): Promise<void> {
  const inside = (b: Viewport) => points.every(([x, y]) => x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h);
  const size = driver.screenSize ? await driver.screenSize(udid).catch(() => undefined) : undefined;
  const rects: Viewport[] = [];
  if (size && size.w > 0 && size.h > 0) rects.push({ x: 0, y: 0, w: size.w, h: size.h });
  if (rects.length && inside(rects[0])) return;
  const vp = conn ? await resolveViewport(driver, udid, conn).catch(() => undefined) : undefined;
  if (vp && vp.w > 0 && vp.h > 0) rects.push(vp);
  if (!rects.length) return;
  const x1 = Math.round(Math.min(...rects.map((r) => r.x)));
  const y1 = Math.round(Math.min(...rects.map((r) => r.y)));
  const x2 = Math.round(Math.max(...rects.map((r) => r.x + r.w)));
  const y2 = Math.round(Math.max(...rects.map((r) => r.y + r.h)));
  for (const [x, y] of points) {
    if (x < x1 || y < y1 || x > x2 || y > y2) {
      throw new UserInputError(
        `${what} (${x}, ${y}) is outside the screen: x must be ${x1}–${x2} and y ${y1}–${y2} ` +
          `(${driver.platform === "android" ? "pixels" : "points"}, the units get_layout reports).`,
      );
    }
  }
}

export async function resolveTarget(
  driver: DeviceDriver,
  udid: string,
  sel: Selector,
  o?: { pre?: Element[]; conn?: EvalConn },
): Promise<{ x: number; y: number; label: string; before?: Element[]; el?: Element }> {
  // Explicit coordinates never need a layout capture — on heavy screens
  // `axe describe-ui` can exceed its timeout, which must not break x/y taps.
  // The bounds check is one cheap read.
  if (typeof sel.x === "number" && typeof sel.y === "number") {
    await checkOnScreen(driver, udid, o?.conn, [[sel.x, sel.y]], "Tap point");
    return { x: sel.x, y: sel.y, label: `(${sel.x}, ${sel.y})` };
  }
  const before = o?.pre ?? (await captureLayout(driver, udid, { conn: o?.conn }));
  if (sel.testID) {
    const el = findByTestID(before, sel.testID);
    if (!el) throw new UserInputError(`No element with testID "${sel.testID}".`);
    return { x: el.cx, y: el.cy, label: `testID "${sel.testID}"`, before, el };
  }
  if (sel.text) {
    const el = findByText(before, sel.text);
    return { x: el.cx, y: el.cy, label: `"${el.text ?? sel.text}"`, before, el };
  }
  throw new UserInputError("Provide one of: text, testID, or x+y.");
}

/**
 * The label a JS press or scroll recognises the resolved element by — the one
 * the listing showed, so a host painted over it (or under it) cannot be taken
 * for it.
 */
export function pressTargetOf(el: Element | undefined, sel: { testID?: string }): PressTarget | undefined {
  if (sel.testID) return { testID: sel.testID };
  const label = el?.text ?? el?.placeholder;
  return label ? { text: label } : undefined;
}

/** What a layout looks like, for telling whether a swipe moved anything at all. */
function layoutSignature(els: Element[]): string {
  return els
    .map(
      (e) =>
        `${e.text ?? ""}|${e.testID ?? ""}|${e.placeholder ?? ""}|${Math.round(e.x)},${Math.round(e.y)},${Math.round(e.w)},${Math.round(e.h)}|${e.offscreen ? 1 : 0}${e.hidden ? 1 : 0}`,
    )
    .join("\n");
}

/**
 * `findByText`/`findByTestID` refuse an element that exists but is not visible —
 * which is precisely what `scroll_to` is for. That one refusal is caught and the
 * match re-run over the off-screen elements; every other refusal, ambiguity
 * above all, is left to stand, so `scroll_to` and `tap` never disagree about
 * what a selector means.
 */
function resolveScrollTarget(els: Element[], sel: { text?: string; testID?: string }): Element {
  try {
    if (sel.testID) {
      const el = findByTestID(els, sel.testID);
      if (!el) throw new UserInputError(`No element with testID "${sel.testID}".`);
      return el;
    }
    if (sel.text) return findByText(els, sel.text);
    throw new UserInputError("Provide one of: text, testID.");
  } catch (err) {
    if (!(err instanceof UserInputError) || !/is not visible/.test(err.message)) throw err;
    // Only `offscreen` is reachable by scrolling: an element on an inactive tab
    // or behind display:none measures identically and no swipe will reveal it,
    // so the original refusal — which says to navigate instead — stands. The
    // match is tiered like findByText's: "Row 1" is the row called exactly
    // that, not "Row 1" and "Row 10"…"Row 19" in one false ambiguity.
    const off = matchingElements(
      els.filter((e) => e.offscreen),
      sel,
    );
    if (off.length === 1) return off[0];
    if (off.length > 1) {
      throw new UserInputError(
        `Ambiguous target — ${off.length} off-screen elements match: ${off
          .map((e) => `@${e.cx},${e.cy}`)
          .join(", ")}. Use a testID.`,
      );
    }
    throw err;
  }
}

/** Which way to swipe to pull the element toward the viewport. */
function directionTo(el: Element, vp?: Viewport): Direction {
  const v = vp && vp.w > 0 && vp.h > 0 ? vp : { x: 0, y: 0, w: 400, h: 800 };
  const below = el.cy - (v.y + v.h);
  const above = v.y - el.cy;
  const right = el.cx - (v.x + v.w);
  const left = v.x - el.cx;
  if (Math.max(below, above) >= Math.max(right, left)) return below >= above ? "up" : "down";
  return right >= left ? "left" : "right";
}

/**
 * A touch that times out is genuinely ambiguous: during the field test a swipe
 * had scrolled the feed while a tap had not landed, and both surfaced as the
 * same "timed out" string. An agent that cannot tell them apart retries and
 * double-taps. The before-layout is already in hand for the diff.
 */
async function timeoutVerdict(
  driver: DeviceDriver,
  udid: string,
  err: Error,
  before: Element[] | undefined,
  conn?: EvalConn,
): Promise<never> {
  const after = before ? await captureLayout(driver, udid, { conn }).catch(() => undefined) : undefined;
  let verdict: string;
  if (!before || !after) {
    verdict = "Layout unavailable — whether the action landed is unknown.";
  } else {
    const diff = layoutDiff(before, after);
    verdict = /no visible layout change/i.test(diff)
      ? "The screen did NOT change — the action probably did not land."
      : `The screen DID change — the action probably landed. Do not repeat it blindly.\n${diff}`;
  }
  throw new DriverError(`${err.message}\n${verdict}`);
}

export async function tapInternal(
  driver: DeviceDriver,
  udid: string,
  sel: Selector,
  durationMs?: number,
  conn?: EvalConn,
  via: InputVia = "auto",
): Promise<string> {
  const { x, y, label, before, el } = await resolveTarget(driver, udid, sel, { conn });
  let dispatched: Dispatched;
  try {
    dispatched = await dispatchTap({ driver, udid, x, y, durationMs, via, conn, target: pressTargetOf(el, sel) });
  } catch (err) {
    if (err instanceof DriverError && /timed out/i.test(err.message)) {
      await timeoutVerdict(driver, udid, err, before, conn);
    }
    throw err;
  }
  // Always say where the tap landed and by which path: with only a diff, a
  // missed target, an unresponsive control and an invisible element all read
  // the same, and a JS press and a 20s touch are indistinguishable.
  const head = `Tapped ${label} @${x},${y}. ${dispatched.marker}`;
  const note = dispatched.note ? `\n${dispatched.note}` : "";
  if (!before) return head + note;
  let after = await captureLayout(driver, udid, { conn }).catch(() => undefined);
  if (!after) return `${head} (layout unavailable for diff)${note}`;
  let diff = layoutDiff(before, after);
  if (/no visible layout change/i.test(diff)) {
    // An OS touch reaches JS asynchronously, and on a busy screen the touch-up
    // lands at the very end of a slow axe call: the read right after it can
    // come before React commits. One settle (two frames, capped) and a second
    // read tell "nothing happened" from "not drawn yet"; a tap that did change
    // something never pays for it.
    const settled = await settleLayout(driver, udid, { conn, maxMs: 600 });
    if (settled.length) {
      after = settled;
      diff = layoutDiff(before, after);
    }
  }
  return `${head}\n${diff}${note}`;
}

const JS_SCROLL_TIMEOUT_MS = 15000;

/**
 * Brings an off-screen element into view. `via: "js"` asks the element's own
 * scroll container to jump there (no touch, no swipe — see scrollToExpression);
 * `via: "os"` swipes toward it, re-reading the layout after every swipe so it
 * stops the moment the element appears instead of swiping a fixed count and
 * hoping; `via: "auto"` (default) tries JS first and names the fallback reason
 * when it degrades to swipes. Exported so a flow step can call it directly.
 */
export async function scrollToInternal(
  driver: DeviceDriver,
  udid: string,
  sel: { text?: string; testID?: string },
  opts?: { via?: InputVia; maxSwipes?: number; conn?: EvalConn },
): Promise<string> {
  const via = opts?.via ?? "auto";
  const maxSwipes = opts?.maxSwipes ?? 10;
  const conn = opts?.conn;

  const captured = await captureLayoutWithSource(driver, udid, { conn });
  const el = resolveScrollTarget(captured.els, sel);
  const label = sel.testID ? `testID "${sel.testID}"` : `"${el.text ?? sel.text}"`;
  const layoutNote = captured.note ? `(layout: ${captured.source} — ${captured.note})` : undefined;

  const finish = (body: string, d: Dispatched): string => {
    // hotNotice fires once per device per process — call it exactly once.
    const notice = hotNotice(udid);
    return [body, d.marker, d.note, notice].filter(Boolean).join("\n");
  };

  if (isVisible(el)) {
    return finish(`${label} is already visible @${el.cx},${el.cy} — no scroll needed.`, {
      marker: "(input: none — already visible)",
      note: layoutNote,
    });
  }

  let jsReason = "no active Metro connection";
  if (via !== "os" && conn) {
    // The layout was converted into screen units; the expression hit-tests
    // in the app's own, so the point is converted back by the same rule.
    const p = toAppPoint(el.cx, el.cy, await resolveAppSpace(driver, udid));
    let result: ScrollResult & { background?: string };
    try {
      const raw = await conn.evaluate(foregroundGuarded(scrollToExpression(p.x, p.y, pressTargetOf(el, sel))), {
        timeoutMs: JS_SCROLL_TIMEOUT_MS,
      });
      result = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (err) {
      result = { scrolled: false, reason: `js scroll failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    // Swipes would scroll whatever app is in front instead.
    if (result && typeof result.background === "string") throw notForeground(result.background, "scroll");
    if (result && result.scrolled) {
      const after = await settleLayout(driver, udid, { conn, maxMs: 600 });
      const now = after.find((e) => isVisible(e) && sameElement(e, el));
      const head = `Scrolled ${label} via ${result.container}.${result.method}`;
      return finish(
        now
          ? `${head} — now visible @${now.cx},${now.cy}.`
          : `${head}, but it is still not visible. Run scroll_to again for a nested scroll view, or use via: "os".`,
        { marker: "(input: js)", note: layoutNote },
      );
    }
    jsReason = (result && !result.scrolled && result.reason) || "the JS scroll returned nothing";
    if (via === "js") throw new UserInputError(`JS scroll failed: ${jsReason}`);
  } else if (via === "js") {
    throw new UserInputError("JS scroll unavailable: no active Metro connection.");
  }

  const osReason = via === "os" ? "requested" : jsReason;
  // The marker names the driver path of the last swipe sent. Before any swipe
  // there is no OsPath (unreachable through the tool, whose max_swipes is
  // positive), and the old wording is kept.
  let os: OsPath | undefined;
  const osDone = (): Dispatched => ({
    marker: os ? osMarker(os, osReason) : `(input: os — ${osReason})`,
    note: layoutNote,
  });
  const vp = await resolveViewport(driver, udid, conn).catch(() => undefined);
  let target: Element | undefined = el;
  let dir: Direction = directionTo(el, vp);
  let seen = layoutSignature(captured.els);
  for (let n = 1; n <= maxSwipes; n++) {
    if (target) dir = directionTo(target, vp);
    const [x1, y1, x2, y2] = swipeVector(dir, vp);
    const t0 = Date.now();
    os = await driver.swipe(udid, x1, y1, x2, y2, 300);
    recordTouch(udid, Date.now() - t0);
    const els = await settleLayout(driver, udid, { conn });
    const now = els.find((e) => isVisible(e) && sameElement(e, el));
    if (now) return finish(`Swiped ${dir} ${n}× — ${label} is now visible @${now.cx},${now.cy}.`, osDone());
    // Nothing moved: the list is at its end, or the swipe never landed. Either
    // way the next swipe would cost the same 20 s and change nothing.
    const sig = layoutSignature(els);
    if (sig === seen) {
      return finish(
        `${label} is not visible, and the screen did not change after swipe ${n} ${dir} — the list is at its end in that direction, or the swipe did not land. Navigate to its screen instead.`,
        osDone(),
      );
    }
    seen = sig;
    // A virtualized row can unmount entirely; keep the last direction if so.
    target = els.find((e) => sameElement(e, el));
  }
  const last = target
    ? ` Its last known position was @${target.cx},${target.cy}`
    : " It is no longer in the element tree";
  return finish(
    `${label} never became visible after ${maxSwipes} swipe${maxSwipes === 1 ? "" : "s"} ${dir}.${last} (viewport ${
      vp ? `${vp.w}x${vp.h}` : "unknown"
    }). Raise max_swipes, or navigate to its screen instead.`,
    osDone(),
  );
}

export function registerInteractionTools(server: McpServer, opts?: { drivers?: DeviceDriver[] }): void {
  server.registerTool(
    "tap",
    {
      title: "Tap",
      description:
        "Tap an element by text, testID, or x+y coordinates. Pass duration_ms for a long press. via picks the delivery path (js = call the component's own press handler through the app runtime, os = a real simulator/device touch, default auto). Returns the coordinates tapped, the path used, and what changed on screen.",
      inputSchema: {
        text: z
          .string()
          .optional()
          .describe("Visible label (or accessibility label) of the element; exact match first, then substring. Refused when ambiguous."),
        testID: z.string().optional().describe("The element's testID — the most precise selector."),
        x: z.number().optional().describe("X coordinate in screen units (points on iOS, pixels on Android), with y."),
        y: z.number().optional().describe("Y coordinate in screen units, with x."),
        duration_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Hold time; 500 or more is a long press (calls onLongPress on the JS path)."),
        via: z
          .enum(["js", "os", "auto"])
          .optional()
          .describe("Delivery path: js = the component's own handler through the app runtime, os = a real touch, auto (default) = js, then os."),
        device: z.string().optional().describe("Device udid/serial or name substring; default: the connected or only booted device."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ duration_ms, device, via, ...sel }) => {
      try {
        const { driver, udid, conn } = await deviceContext({ ...opts, device });
        return text(await tapInternal(driver, udid, sel, duration_ms, conn, via));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "swipe",
    {
      title: "Swipe",
      description:
        "Swipe in a direction (scaled to the screen), or between explicit coordinates. via picks the delivery path: js scrolls the container under the start point by the same distance through the app runtime (no touch), os is a real simulator/device gesture, auto (default) tries js and names the reason when it falls back.",
      inputSchema: {
        direction: z
          .enum(["up", "down", "left", "right"])
          .optional()
          .describe("Finger direction: up reveals what is below. Scaled to the screen. Or give x1,y1,x2,y2."),
        x1: z.number().optional().describe("Start x in screen units (points on iOS, pixels on Android)."),
        y1: z.number().optional().describe("Start y in screen units."),
        x2: z.number().optional().describe("End x in screen units."),
        y2: z.number().optional().describe("End y in screen units."),
        duration_ms: z.number().int().positive().optional().describe("Gesture duration on the OS path (default 300)."),
        via: z
          .enum(["js", "os", "auto"])
          .optional()
          .describe("js = scroll the container under the start point by the same distance (no touch), os = a real gesture, auto (default) = js, then os."),
        device: z.string().optional().describe("Device udid/serial or name substring; default: the connected or only booted device."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ direction, x1, y1, x2, y2, duration_ms, via, device }) => {
      try {
        const { driver, udid, conn } = await deviceContext({ ...opts, device });
        let coords: [number, number, number, number];
        if (direction) {
          coords = swipeVector(direction as Direction, await resolveViewport(driver, udid, conn));
        } else if ([x1, y1, x2, y2].every((n) => typeof n === "number")) {
          coords = [x1!, y1!, x2!, y2!];
          await checkOnScreen(
            driver,
            udid,
            conn,
            [
              [x1!, y1!],
              [x2!, y2!],
            ],
            "Swipe point",
          );
        } else {
          throw new UserInputError("Provide a direction or x1,y1,x2,y2.");
        }
        // Screen units in; dispatchSwipe converts the JS route's point and
        // travel into app units itself (src/layout/appSpace.ts).
        const d = await dispatchSwipe({
          driver,
          udid,
          coords,
          durationMs: duration_ms,
          via: via ?? "auto",
          conn,
        });
        // The JS route did not swipe anything, so saying it did would be a
        // lie the caller cannot check; it reports the offsets instead, which
        // is the only evidence that a scroll at the end of its travel did
        // nothing at all.
        const body = d.js
          ? `Scrolled via js: ${d.js.container}.${d.js.method} ${d.js.from} \u2192 ${d.js.to}`
          : `Swiped ${coords[0]},${coords[1]} \u2192 ${coords[2]},${coords[3]}.`;
        return text(`${body} ${d.marker}${d.note ? `\n${d.note}` : ""}`);
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "scroll_to",
    {
      title: "Scroll to element",
      description:
        "Bring an off-screen element into view. Returns immediately when it is already visible. via: js asks the element's own scroll container to jump to it (no touch, no swipe); os swipes toward it and re-reads the layout after each swipe, stopping as soon as it appears; auto (default) tries js and names the reason when it falls back.",
      inputSchema: {
        text: z.string().optional().describe("Label of the element to reveal; exact match first, then substring."),
        testID: z.string().optional().describe("testID of the element to reveal."),
        via: z
          .enum(["js", "os", "auto"])
          .optional()
          .describe("js = the element's own scroll container jumps to it, os = swipe toward it, auto (default) = js, then os."),
        // At 17-25s per touch on a hot app, 30 swipes is already ten minutes.
        max_swipes: z
          .number()
          .int()
          .positive()
          .max(30)
          .optional()
          .describe("Most swipes on the OS path (default 10). It also stops when a swipe changes nothing."),
        device: z.string().optional().describe("Device udid/serial or name substring; default: the connected or only booted device."),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ text: t, testID, via, max_swipes, device }) => {
      try {
        const { driver, udid, conn } = await deviceContext({ ...opts, device });
        return text(
          await scrollToInternal(driver, udid, { text: t, testID }, { via, maxSwipes: max_swipes, conn }),
        );
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "type_text",
    {
      title: "Type text",
      description:
        'Type text into a text input. `into` selects the field by testID, placeholder or accessibilityLabel — omit it only when a single input is on screen. via "js" (default via "auto" tries it first) calls the field\'s own onChangeText in ~1ms and runs the app\'s real onChange pipeline; via "os" drives the simulator keyboard. verify (default true) reads the value back afterwards and fails loudly if it differs — the OS keyboard sends positional keycodes that a non-ASCII host keyboard layout silently rewrites.',
      inputSchema: {
        text: z.string().describe("The text to type. The JS path replaces the field's value; the OS keyboard appends to it."),
        into: z
          .object({
            testID: z.string().optional().describe("The field's testID."),
            placeholder: z.string().optional().describe("The field's placeholder, exactly."),
            label: z.string().optional().describe("The field's accessibilityLabel / aria-label, exactly."),
          })
          .strict()
          .optional()
          .describe("Which field (JS path only). Omit when one field is on screen or one holds focus."),
        via: z
          .enum(["js", "os", "auto"])
          .optional()
          .describe("js = the field's own onChangeText, os = the device keyboard into the focused field, auto (default) = js, then os."),
        verify: z.boolean().optional().describe("Read the value back afterwards and fail if it is wrong (default true)."),
        submit: z.boolean().optional().describe("Then fire the field's onSubmitEditing, as the return key would."),
        device: z.string().optional().describe("Device udid/serial or name substring; default: the connected or only booted device."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ text: t, into, via, verify, submit, device }) => {
      try {
        if (!t) throw new UserInputError("`text` is empty.");
        if (into && into.testID === undefined && into.placeholder === undefined && into.label === undefined) {
          throw new UserInputError("`into` needs at least one of: testID, placeholder, label.");
        }
        const { driver, udid, conn } = await deviceContext({ ...opts, device });
        const d = await dispatchType({
          driver,
          udid,
          value: t,
          into: into as InputTarget | undefined,
          via: via ?? "auto",
          conn,
          verify: verify ?? true,
        });
        const where = into
          ? ` into ${into.testID ? `testID "${into.testID}"` : into.placeholder ? `placeholder "${into.placeholder}"` : `label "${into.label}"`}`
          : "";
        let out = `Typed ${t.length} chars${where}. ${d.marker}${d.note ? `\n${d.note}` : ""}`;
        if (submit) {
          // The text is already in the field by now, so a submit that finds
          // nothing to fire is a note rather than an error: turning it into one
          // would make the caller retype what already landed.
          try {
            const res = await dispatchSubmit({ conn, into: into as InputTarget | undefined });
            out += res.submitted
              ? `\nSubmitted ${res.field} — fired ${res.handlers.join(", ")}.${res.note ? `\n${res.note}` : ""}`
              : `\nNot submitted: ${res.reason}`;
          } catch (err) {
            out += `\nNot submitted: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        return text(out);
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "press_key",
    {
      title: "Press key",
      description:
        'Press a hardware key. "back" goes up one screen — via "js" (tried first by default) calls the navigation container\'s own goBack() with no touch, via "os" uses the hardware key (Android) or an edge swipe (iOS). "home" is OS-only. "enter" submits a text field by firing its own onSubmitEditing, the only route to a submit handler that does not need the OS keyboard — pass `into` to name the field when more than one is on screen and none holds focus.',
      inputSchema: {
        key: z
          .enum(["back", "home", "enter"])
          .describe("back = up one screen, home = background the app (OS only), enter = submit a text field (JS only)."),
        into: z
          .object({
            testID: z.string().optional().describe("The field's testID."),
            placeholder: z.string().optional().describe("The field's placeholder, exactly."),
            label: z.string().optional().describe("The field's accessibilityLabel / aria-label, exactly."),
          })
          .strict()
          .optional()
          .describe('key: "enter" only — the field to submit, when more than one is on screen and none holds focus.'),
        via: z
          .enum(["js", "os", "auto"])
          .optional()
          .describe("back: js = the navigator's goBack(), os = hardware key / edge swipe, auto (default) = js, then os."),
        device: z.string().optional().describe("Device udid/serial or name substring; default: the connected or only booted device."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ key, into, via, device }) => {
      try {
        if (into && key !== "enter") {
          throw new UserInputError('`into` only applies to key: "enter" — it names the field to submit.');
        }
        const { driver, udid, conn } = await deviceContext({ ...opts, device });

        if (key === "enter") {
          if (via === "os") {
            throw new UserInputError(
              'key: "enter" is JS-only: pressing the OS keyboard\'s return key needs a real touch on a keyboard that may not even be up. Omit `via`, or use via: "js".',
            );
          }
          const res = await dispatchSubmit({ conn, into: into as InputTarget | undefined });
          // The refusal is the useful half here — "field has no onSubmitEditing
          // handler" tells the caller the app has nothing to submit, which a
          // silent success would hide.
          if (!res.submitted) throw new UserInputError(`Submit failed: ${res.reason}`);
          return text(
            `Submitted ${res.field} — fired ${res.handlers.join(", ")}. (input: js)${res.note ? `\n${res.note}` : ""}`,
          );
        }

        if (key === "home") {
          if (via === "js") {
            throw new UserInputError(
              'key: "home" is OS-only — backgrounding the app is not something the app can do to itself. Use open_url to navigate instead.',
            );
          }
          const os = await driver.pressKey(udid, "home");
          return text(`Pressed home. ${osMarker(os)}`);
        }

        // iOS "back" is an edge swipe, so the OS half needs to know how big the
        // screen is. Resolved up front because dispatchBack is the one that
        // decides which half runs.
        const viewport =
          driver.platform === "ios" ? await resolveViewport(driver, udid, conn).catch(() => undefined) : undefined;
        const d = await dispatchBack({ driver, udid, via: via ?? "auto", conn, viewport });
        const body = d.went ? "Pressed back." : `Did not go back: ${d.reason}.`;
        return text(`${body} ${d.marker}${d.note ? `\n${d.note}` : ""}`);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
