import { describe, it, expect, beforeEach } from "vitest";
import { appStateExpression, foregroundGuarded, probeAppState } from "../../src/input/appState.js";
import { dispatchTap, dispatchType, dispatchSwipe, dispatchBack, dispatchSubmit } from "../../src/input/dispatch.js";
import { pressExpression } from "../../src/input/press.js";
import { resetAppSpaceCache } from "../../src/layout/appSpace.js";
import { resetHotState } from "../../src/input/hotState.js";
import { UserInputError } from "../../src/core/errors.js";
import { makeRuntime, fakeClient } from "../helpers/rnRuntime.js";
import { fabricFiber, hookGlobals, linkParents, type NodeSpec } from "../helpers/fiberTree.js";
import { Connection } from "../../src/core/registry.js";
import { AXE } from "../helpers/osPath.js";
import type { DeviceDriver } from "../../src/drivers/types.js";

/**
 * The native AppState module as RN exposes it to JS: getCurrentAppState answers
 * through a callback, on a later turn (the native method queue).
 */
function appStateModule(state: string) {
  return {
    getCurrentAppState: (ok: (d: { app_state: string }) => void) => setTimeout(() => ok({ app_state: state }), 1),
  };
}

function connFor(globals: Record<string, unknown>) {
  const runtime = makeRuntime(globals);
  return new Connection(fakeClient(runtime) as any, { port: 0, targetId: "t", title: "fake" });
}

const SCREEN: NodeSpec = { type: "RCTView", rect: { x: 0, y: 0, w: 400, h: 800 } };

describe("appStateExpression / probeAppState", () => {
  it("reads the state through __turboModuleProxy (bridge)", async () => {
    const conn = connFor({ __turboModuleProxy: (name: string) => (name === "AppState" ? appStateModule("background") : null) });
    expect(await probeAppState(conn)).toBe("background");
  });

  it("reads the state through nativeModuleProxy (bridgeless)", async () => {
    const conn = connFor({ nativeModuleProxy: { AppState: appStateModule("active") } });
    expect(await probeAppState(conn)).toBe("active");
  });

  it("answers null at once, without a Promise, when the module is not reachable", () => {
    const runtime = makeRuntime({});
    expect(runtime.evaluate(appStateExpression())).toBe(JSON.stringify({ state: null }));
  });

  it("answers null when the module never calls back", async () => {
    const conn = connFor({ nativeModuleProxy: { AppState: { getCurrentAppState: () => {} } } });
    expect(await probeAppState(conn)).toBeNull();
  });
});

describe("foregroundGuarded", () => {
  it("runs the expression as before when the state cannot be told", () => {
    const runtime = makeRuntime({});
    expect(runtime.evaluate(foregroundGuarded(`/* rne:x */(function () { return "ran"; })()`))).toBe("ran");
  });

  it("keeps the marker comment in front", () => {
    expect(foregroundGuarded(`/* rne:type */(function () { return 1; })()`).indexOf("/* rne:type */")).toBe(0);
  });

  it("never runs the expression on a backgrounded app", async () => {
    let ran = false;
    const conn = connFor({ nativeModuleProxy: { AppState: appStateModule("background") }, mark: () => (ran = true) });
    const out = JSON.parse(await conn.evaluate(foregroundGuarded(`(function () { mark(); return "ran"; })()`)));
    expect(out).toEqual({ background: "background", reason: "the app is not in the foreground (AppState: background)" });
    expect(ran).toBe(false);
  });

  it("runs it, and waits for its own Promise, when the app is active", async () => {
    const conn = connFor({ nativeModuleProxy: { AppState: appStateModule("active") } });
    const out = await conn.evaluate(
      foregroundGuarded(`(function () { return new Promise(function (r) { setTimeout(function () { r("late"); }, 5); }); })()`),
    );
    expect(out).toBe("late");
  });
});

/** A driver that records every OS action, so a test can say none happened. */
function recordingDriver() {
  const os: string[] = [];
  const driver = {
    platform: "ios" as const,
    tapXY: async () => (os.push("tap"), AXE),
    swipe: async () => (os.push("swipe"), AXE),
    typeText: async () => (os.push("type"), AXE),
    pressKey: async () => (os.push("key"), AXE),
    pointScale: async () => 1,
  } as unknown as DeviceDriver;
  return { driver, os };
}

describe("JS input on an app that is not in the foreground", () => {
  beforeEach(() => resetHotState());

  const backgrounded = () => {
    const pressed: string[] = [];
    const tree = fabricFiber({
      ...SCREEN,
      children: [{ type: "RCTView", props: { onClick: () => pressed.push("x") }, rect: { x: 0, y: 0, w: 400, h: 800 } }],
    });
    const conn = connFor({
      ...hookGlobals(linkParents(tree), { fabric: true }),
      nativeModuleProxy: { AppState: appStateModule("background") },
    });
    return { conn, pressed };
  };

  it("refuses a tap, and auto does not fall back to an OS touch", async () => {
    const { conn, pressed } = backgrounded();
    const { driver, os } = recordingDriver();
    const err: any = await dispatchTap({ driver, udid: "U", x: 10, y: 10, via: "auto", conn }).catch((e) => e);
    expect(err).toBeInstanceOf(UserInputError);
    expect(err.message).toMatch(/Cannot tap: the app is not in the foreground \(AppState: background\)/);
    expect(err.message).toMatch(/launch_app/);
    expect(pressed).toEqual([]);
    expect(os).toEqual([]);
  });

  it("refuses typing, swiping, going back and submitting the same way", async () => {
    const { conn } = backgrounded();
    const { driver, os } = recordingDriver();
    await expect(dispatchType({ driver, udid: "U", value: "a", via: "auto", conn, verify: true })).rejects.toThrow(
      /Cannot type: the app is not in the foreground/,
    );
    await expect(dispatchSwipe({ driver, udid: "U", coords: [200, 600, 200, 200], via: "auto", conn })).rejects.toThrow(
      /Cannot swipe: the app is not in the foreground/,
    );
    await expect(dispatchBack({ driver, udid: "U", via: "auto", conn })).rejects.toThrow(
      /Cannot go back: the app is not in the foreground/,
    );
    await expect(dispatchSubmit({ conn })).rejects.toThrow(/Cannot submit: the app is not in the foreground/);
    expect(os).toEqual([]);
  });

  it("still presses when the app is active", async () => {
    const pressed: string[] = [];
    const tree = fabricFiber({
      ...SCREEN,
      children: [{ type: "RCTView", props: { onClick: () => pressed.push("x") }, rect: { x: 0, y: 0, w: 400, h: 800 } }],
    });
    const conn = connFor({
      ...hookGlobals(linkParents(tree), { fabric: true }),
      nativeModuleProxy: { AppState: appStateModule("active") },
    });
    const { driver } = recordingDriver();
    const d = await dispatchTap({ driver, udid: "U", x: 10, y: 10, via: "auto", conn });
    expect(d.marker).toBe("(input: js)");
    expect(pressed).toEqual(["x"]);
  });
});

describe("a JS press with no layout behind it (cold Android origin)", () => {
  beforeEach(() => {
    resetAppSpaceCache();
    resetHotState();
  });

  it("reads the app's root frame first, so the point lands where the screen says", async () => {
    // An RN runtime that measures its root at 0 (no visible-frame offset): the
    // uncalibrated origin (y=144 px) put every press 144 px / 3.5 = 41 dp high.
    const exprs: string[] = [];
    const conn = {
      evaluate: async (expr: string) => {
        exprs.push(expr);
        // Anything but the press is the root-frame read.
        if (!expr.includes("PX =")) return JSON.stringify({ x: 0, y: 0, w: 1080 / 3.5, h: 2400 / 3.5 });
        return JSON.stringify({ pressed: true, component: "Pressable", handler: "onPress", depth: 1 });
      },
    };
    const driver = {
      platform: "android" as const,
      pointScale: async () => 3.5,
      appOrigin: async () => ({ x: 0, y: 144, window: { x: 0, y: 0, w: 1080, h: 2400 } }),
      tapXY: async () => AXE,
    } as unknown as DeviceDriver;
    await dispatchTap({ driver, udid: "cold", x: 540, y: 1200, via: "js", conn });
    const press = exprs.find((e) => e.includes("PX ="))!;
    expect(press).toBeDefined();
    // 1200 px / 3.5 = 342.86 dp from the window top — not (1200 - 144) / 3.5.
    expect(press).toContain("PY = 342.86");
  });
});

describe("pressExpression is unchanged for callers that pass no target", () => {
  it("embeds a null target", () => {
    expect(pressExpression(1, 2)).toContain("TARGET = null");
  });
});
