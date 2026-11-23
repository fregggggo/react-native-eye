import { describe, it, expect } from "vitest";
import { pressExpression } from "../../src/input/press.js";
import { makeRuntime, fakeClient } from "../helpers/rnRuntime.js";
import { linkParents, paperFiber, fabricFiber, hookGlobals, type NodeSpec } from "../helpers/fiberTree.js";
import { Connection } from "../../src/core/registry.js";

const SCREEN: NodeSpec = { type: "RCTView", rect: { x: 0, y: 0, w: 400, h: 800 } };

/**
 * Runs the expression the way the app does — through the evaluate protocol, so a
 * Paper tree's asynchronous measurement exercises the promise settle path rather
 * than being string-matched.
 */
async function press(
  root: any,
  x: number,
  y: number,
  opts?: { longPress?: boolean; fabric?: boolean; target?: { testID?: string; text?: string } },
): Promise<any> {
  const runtime = makeRuntime(hookGlobals(linkParents(root), { fabric: opts?.fabric !== false }));
  const conn = new Connection(fakeClient(runtime) as any, { port: 0, targetId: "t", title: "fake" });
  return JSON.parse(await conn.evaluate(pressExpression(x, y, { longPress: opts?.longPress, target: opts?.target })));
}

/** Pressable is a forwardRef: its fiber.type is an object carrying displayName, not a tag string. */
function composite(fiber: any, displayName: string): any {
  fiber.type = { displayName };
  return fiber;
}

/** Hangs a hand-stitched subtree under a full-screen root. */
function screenWith(child: any): any {
  const root = fabricFiber(SCREEN);
  root.child = child;
  return root;
}

describe("pressExpression", () => {
  it("presses a Pressable whose onPress sits three levels above the hit host", async () => {
    const calls: string[] = [];
    const pressable = composite(
      fabricFiber({
        type: "Pressable",
        props: { onPress: () => calls.push("press") },
        children: [
          {
            type: "RCTView",
            rect: { x: 0, y: 700, w: 100, h: 60 },
            children: [
              {
                type: "RCTView",
                rect: { x: 10, y: 710, w: 80, h: 40 },
                children: [
                  { type: "RCTText", props: { children: "Trends" }, rect: { x: 20, y: 720, w: 60, h: 20 } },
                ],
              },
            ],
          },
        ],
      }),
      "Pressable",
    );
    const out = await press(screenWith(pressable), 50, 730);
    expect(out).toEqual({ pressed: true, component: "Pressable", handler: "onPress", depth: 3 });
    expect(calls).toEqual(["press"]);
  });

  it("picks the innermost element containing the point when two are nested", async () => {
    // Paper: measurement arrives on a callback, so this case also covers the
    // promise settle path and proves the press is dispatched once, not per resolve.
    const calls: string[] = [];
    const tree = paperFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { onPress: () => calls.push("big") },
          rect: { x: 0, y: 0, w: 300, h: 300 },
          children: [
            {
              type: "RCTView",
              props: { onPress: () => calls.push("small") },
              rect: { x: 100, y: 100, w: 50, h: 50 },
            },
          ],
        },
      ],
    });
    const out = await press(tree, 120, 120, { fabric: false });
    expect(out).toMatchObject({ pressed: true, component: "RCTView", handler: "onPress", depth: 0 });
    expect(calls).toEqual(["small"]);
  });

  it("prefers onLongPress over a nearer host handler when a long press was asked for", async () => {
    // The real shape: Pressable renders a host View that carries onClick, so a
    // per-fiber preference order would take the nearer onClick and never reach
    // the long press. The climb therefore looks for onLongPress across the whole
    // ancestry first.
    const calls: string[] = [];
    const pressable = composite(
      fabricFiber({
        type: "Pressable",
        props: { onPress: () => calls.push("short"), onLongPress: () => calls.push("long") },
        children: [
          {
            type: "RCTView",
            props: { onClick: () => calls.push("click") },
            rect: { x: 0, y: 0, w: 200, h: 60 },
            children: [{ type: "RCTText", props: { children: "Save" }, rect: { x: 10, y: 10, w: 80, h: 20 } }],
          },
        ],
      }),
      "Pressable",
    );
    const out = await press(screenWith(pressable), 50, 20, { longPress: true });
    expect(out).toMatchObject({ pressed: true, component: "Pressable", handler: "onLongPress", depth: 2 });
    expect(calls).toEqual(["long"]);
  });

  it("falls back to onPress when a long press was asked for and there is no onLongPress", async () => {
    const calls: string[] = [];
    const pressable = composite(
      fabricFiber({
        type: "TouchableOpacity",
        props: { onPress: () => calls.push("short") },
        children: [{ type: "RCTText", props: { children: "Save" }, rect: { x: 10, y: 10, w: 80, h: 20 } }],
      }),
      "TouchableOpacity",
    );
    const out = await press(screenWith(pressable), 50, 20, { longPress: true });
    expect(out).toMatchObject({ pressed: true, component: "TouchableOpacity", handler: "onPress", depth: 1 });
    expect(calls).toEqual(["short"]);
  });

  it("uses a host onClick when no composite onPress is in the ancestry", async () => {
    const calls: string[] = [];
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { onClick: () => calls.push("click") },
          rect: { x: 0, y: 100, w: 200, h: 60 },
          children: [{ type: "RCTText", props: { children: "Trends" }, rect: { x: 10, y: 110, w: 80, h: 20 } }],
        },
      ],
    });
    const out = await press(tree, 40, 120);
    expect(out).toMatchObject({ pressed: true, component: "RCTView", handler: "onClick", depth: 1 });
    expect(calls).toEqual(["click"]);
  });

  it("names the reason when nothing in the ancestry can be pressed", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [{ type: "RCTText", props: { children: "Read only" }, rect: { x: 0, y: 0, w: 200, h: 40 } }],
    });
    const out = await press(tree, 100, 20);
    expect(out.pressed).toBe(false);
    expect(out.reason).toMatch(/no press handler in the ancestry/);
    expect(out.reason).toMatch(/RCTText/);
  });

  it("names the reason when the point hits nothing", async () => {
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        { type: "RCTText", props: { onPress: () => {}, children: "Go" }, rect: { x: 0, y: 0, w: 40, h: 20 } },
      ],
    });
    const out = await press(tree, 5000, 5000);
    expect(out.pressed).toBe(false);
    expect(out.reason).toMatch(/no element at \(5000, 5000\)/);
  });

  it("steps over a Reanimated prop object that throws when read", async () => {
    // The field test found props that throw on access. An unguarded read one
    // level up loses the press entirely, so the climb reads through safe().
    const calls: string[] = [];
    const animated: Record<string, unknown> = {};
    for (const key of ["onPress", "onLongPress", "onClick", "style"]) {
      Object.defineProperty(animated, key, {
        enumerable: true,
        get() {
          throw new Error("[Reanimated] Trying to read an animated value outside of a worklet");
        },
      });
    }
    const pressable = composite(
      fabricFiber({
        type: "Pressable",
        props: { onPress: () => calls.push("press") },
        children: [
          {
            type: "RCTView",
            props: animated,
            rect: { x: 0, y: 0, w: 200, h: 60 },
            children: [{ type: "RCTText", props: { children: "Like" }, rect: { x: 10, y: 10, w: 60, h: 20 } }],
          },
        ],
      }),
      "Pressable",
    );
    const out = await press(screenWith(pressable), 40, 20);
    expect(out).toMatchObject({ pressed: true, component: "Pressable", handler: "onPress", depth: 2 });
    expect(calls).toEqual(["press"]);
  });

  it("reports a handler that throws instead of losing the whole expression", async () => {
    const pressable = composite(
      fabricFiber({
        type: "Pressable",
        props: {
          onPress: () => {
            throw new Error("boom");
          },
        },
        children: [{ type: "RCTText", props: { children: "Save" }, rect: { x: 10, y: 10, w: 80, h: 20 } }],
      }),
      "Pressable",
    );
    const out = await press(screenWith(pressable), 50, 20);
    expect(out.pressed).toBe(false);
    expect(out.reason).toMatch(/handler threw: Error: boom/);
  });

  it("reports a missing DevTools hook", async () => {
    const runtime = makeRuntime();
    const conn = new Connection(fakeClient(runtime) as any, { port: 0, targetId: "t", title: "fake" });
    const out = JSON.parse(await conn.evaluate(pressExpression(10, 10)));
    expect(out.pressed).toBe(false);
    expect(out.reason).toMatch(/DevTools hook not present/);
  });

  it("never presses a smaller candidate hidden inside an inactive react-native-screens screen", async () => {
    // Same bug elementAtPoint's doc comment describes: a mounted-but-hidden
    // screen keeps a valid frame and measures at the same coordinates as the
    // visible one, so geometry alone cannot tell them apart. Here the hidden
    // candidate is also *smaller*, so an unfiltered hitIndex() would prefer it
    // over the visible one at the same point.
    const calls: string[] = [];
    const tree = fabricFiber({
      ...SCREEN,
      children: [
        {
          type: "RCTView",
          props: { activityState: 0 }, // react-native-screens: inactive, kept mounted
          rect: { x: 0, y: 0, w: 400, h: 800 },
          children: [
            {
              type: "RCTView",
              props: { onPress: () => calls.push("hidden") },
              rect: { x: 40, y: 40, w: 20, h: 20 }, // smaller area — would win an unfiltered tie-break
            },
          ],
        },
        {
          type: "RCTView",
          props: { onPress: () => calls.push("visible") },
          rect: { x: 0, y: 0, w: 200, h: 200 }, // larger, but the one actually on screen
        },
      ],
    });
    const out = await press(tree, 50, 50);
    expect(out).toMatchObject({ pressed: true, component: "RCTView", handler: "onPress" });
    expect(calls).toEqual(["visible"]);
  });

  describe("overlapping elements", () => {
    // A list row whose label sits under a bottom sheet's Confirm button: the
    // label is smaller, and the sheet is painted later (it comes later in the
    // tree). Smallest-area used to press the row under the sheet.
    function sheetOverRow(calls: string[], sheetProps: Record<string, unknown> = {}) {
      return fabricFiber({
        ...SCREEN,
        children: [
          {
            type: "RCTView",
            props: { onClick: () => calls.push("row 12") },
            rect: { x: 0, y: 600, w: 400, h: 60 },
            children: [{ type: "RCTText", props: { children: "Row 12" }, rect: { x: 170, y: 620, w: 60, h: 20 } }],
          },
          {
            type: "RCTView",
            props: sheetProps,
            rect: { x: 0, y: 500, w: 400, h: 300 },
            children: [
              {
                type: "RCTView",
                props: { onClick: () => calls.push("confirm") },
                rect: { x: 20, y: 600, w: 360, h: 60 },
                children: [{ type: "RCTText", props: { children: "Confirm" }, rect: { x: 150, y: 618, w: 100, h: 24 } }],
              },
            ],
          },
        ],
      });
    }

    it("presses what is painted on top, not the smaller element underneath", async () => {
      const calls: string[] = [];
      const out = await press(sheetOverRow(calls), 200, 630);
      expect(out.pressed).toBe(true);
      expect(calls).toEqual(["confirm"]);
    });

    it("presses the element the selector named even where another one is painted over it", async () => {
      const calls: string[] = [];
      const out = await press(sheetOverRow(calls), 200, 630, { target: { text: "Row 12" } });
      expect(out.pressed).toBe(true);
      expect(calls).toEqual(["row 12"]);
    });

    it("lets touches through a pointerEvents:none overlay and a box-none container", async () => {
      const calls: string[] = [];
      const none = await press(sheetOverRow(calls, { pointerEvents: "none" }), 200, 630);
      expect(none.pressed).toBe(true);
      expect(calls).toEqual(["row 12"]);
      calls.length = 0;
      // box-none: the container itself is transparent to touches, its button is not.
      const boxNone = await press(sheetOverRow(calls, { style: { pointerEvents: "box-none" } }), 200, 630);
      expect(boxNone.pressed).toBe(true);
      expect(calls).toEqual(["confirm"]);
    });

    it("matches the named element by testID or accessibility label", async () => {
      const calls: string[] = [];
      const tree = fabricFiber({
        ...SCREEN,
        children: [
          { type: "RCTView", props: { testID: "under", onClick: () => calls.push("under") }, rect: { x: 0, y: 0, w: 100, h: 100 } },
          { type: "RCTView", props: { accessibilityLabel: "Close", onClick: () => calls.push("close") }, rect: { x: 0, y: 0, w: 100, h: 100 } },
        ],
      });
      await press(tree, 50, 50, { target: { testID: "under" } });
      await press(tree, 50, 50, { target: { text: "Close" } });
      expect(calls).toEqual(["under", "close"]);
    });
  });
});
