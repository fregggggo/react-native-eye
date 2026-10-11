import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerInteractionTools, tapInternal } from "../../src/tools/interact.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, evalEnvelope, type FakeMetro } from "../helpers/fakeCdp.js";
import type { DeviceDriver } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";
import { DriverError } from "../../src/core/errors.js";
import { resetHotState } from "../../src/input/hotState.js";
import type { ScrollResult } from "../../src/input/scroll.js";

let metro: FakeMetro;
beforeEach(() => {
  getRegistry().reset();
  resetHotState();
});
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

function driverThatChangesAfterTap(): { driver: DeviceDriver; taps: number[][] } {
  let tapped = false;
  const taps: number[][] = [];
  const driver: DeviceDriver = {
    platform: "ios",
    listDevices: async () => [{ platform: "ios", udid: "u", name: "n", booted: true }],
    screenshotPng: async () => Buffer.from(""),
    rawLayout: async () =>
      axeLayout(
        tapped
          ? [{ text: "Welcome", x: 0, y: 0, w: 100, h: 40 }]
          : [{ text: "Login", x: 0, y: 0, w: 100, h: 40 }],
      ),
    tapXY: async (_u, x, y, d) => {
      taps.push([x, y, d ?? 0]);
      tapped = true;
      return AXE;
    },
    swipe: async () => AXE,
    typeText: async () => AXE,
    pressKey: async () => AXE,
    launchApp: async () => {},
  };
  return { driver, taps };
}

async function connect() {
  metro = await startFakeMetro({ port: 0 });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", () => ({ result: { value: undefined } }));
  await getRegistry().connect({ port: metro.port });
}

describe("tap", () => {
  it("taps given coordinates without capturing layout (heavy screens must not break x/y taps)", async () => {
    await connect();
    const { driver, taps } = driverThatChangesAfterTap();
    driver.rawLayout = async () => {
      throw new Error("axe timed out after 15000ms");
    };
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "tap", { x: 42, y: 905 });
    expect(taps[0]).toEqual([42, 905, 0]);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("42");
  });

  it("passes duration_ms through for a long press", async () => {
    await connect();
    const { driver, taps } = driverThatChangesAfterTap();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    await callTool(server, "tap", { x: 10, y: 20, duration_ms: 1500 });
    expect(taps[0]).toEqual([10, 20, 1500]);
  });

  it("taps a resolved element's center and returns a layout diff", async () => {
    await connect();
    const { driver, taps } = driverThatChangesAfterTap();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "tap", { text: "Login" });
    expect(taps[0]).toEqual([50, 20, 0]);
    expect(res.content[0].text).toContain("+ Welcome");
    expect(res.content[0].text).toContain("- Login");
  });

  it("errors when no selector is given", async () => {
    await connect();
    const { driver } = driverThatChangesAfterTap();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "tap", {});
    expect(res.isError).toBe(true);
  });
});

describe("tap reporting", () => {
  it("always says where the tap landed", async () => {
    // A bare "(no visible layout change)" made a miss, an unresponsive control
    // and an invisible target indistinguishable.
    await connect();
    const { driver, taps } = driverThatChangesAfterTap();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "tap", { text: "Login" });
    expect(taps[0].slice(0, 2)).toEqual([50, 20]);
    expect(res.content[0].text).toMatch(/Tapped "Login" @50,20\./);
  });

  it("works without a Metro connection (device access needs no debugger)", async () => {
    getRegistry().reset();
    const { driver, taps } = driverThatChangesAfterTap();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "tap", { x: 10, y: 20 });
    expect(res.isError).toBeFalsy();
    expect(taps[0].slice(0, 2)).toEqual([10, 20]);
  });

  it("scales swipes to the screen instead of using fixed coordinates", async () => {
    getRegistry().reset();
    const swipes: number[][] = [];
    const { driver } = driverThatChangesAfterTap();
    const d: DeviceDriver = {
      ...driver,
      swipe: async (_u, x1, y1, x2, y2) => {
        swipes.push([x1, y1, x2, y2]);
        return AXE;
      },
      screenSize: async () => ({ w: 1080, h: 2400 }),
    };
    const server = makeServer();
    registerInteractionTools(server, { drivers: [d] });
    await callTool(server, "swipe", { direction: "up" });
    expect(swipes[0][0]).toBe(540);
    expect(swipes[0][1]).toBeGreaterThan(swipes[0][3]);
  });
});

describe("timeout outcome", () => {
  const els = [{ text: "Go", testID: undefined, type: "RCTView", x: 0, y: 0, w: 10, h: 10 }];
  const moved = [{ text: "Go", testID: undefined, type: "RCTView", x: 0, y: 50, w: 10, h: 10 }];

  function driverThatTimesOut(layouts: any[][]) {
    let n = 0;
    return {
      platform: "ios" as const,
      rawLayout: async () => axeLayout(layouts[Math.min(n++, layouts.length - 1)]),
      tapXY: async () => {
        throw new DriverError("axe tap timed out after 90000ms (killed).");
      },
    } as any;
  }

  it("reports that the screen changed, so the tap probably landed", async () => {
    const driver = driverThatTimesOut([els, moved]);
    await expect(tapInternal(driver, "U", { text: "Go" })).rejects.toThrow(/screen DID change/);
  });

  it("reports that the screen did not change, so the tap probably did not land", async () => {
    const driver = driverThatTimesOut([els, els]);
    await expect(tapInternal(driver, "U", { text: "Go" })).rejects.toThrow(/did NOT change/);
  });

  it("says so when the layout cannot be read at all", async () => {
    let n = 0;
    const driver = {
      platform: "ios" as const,
      rawLayout: async () => {
        if (n++ === 0) return axeLayout(els);
        throw new Error("axe unavailable");
      },
      tapXY: async () => {
        throw new DriverError("axe tap timed out after 90000ms (killed).");
      },
    } as any;
    await expect(tapInternal(driver, "U", { text: "Go" })).rejects.toThrow(/whether the action landed is unknown/);
  });

  it("leaves non-timeout driver errors alone", async () => {
    const driver = {
      platform: "ios" as const,
      rawLayout: async () => axeLayout(els),
      tapXY: async () => {
        throw new DriverError("axe failed: no such simulator");
      },
    } as any;
    await expect(tapInternal(driver, "U", { text: "Go" })).rejects.toThrow(/no such simulator/);
  });
});

describe("scroll_to", () => {
  /**
   * One row that is off-screen until `visible` says otherwise. The predicate is
   * evaluated per layout capture, so a test can make the row appear after N
   * swipes, after the first capture (the JS path), or never.
   */
  function rowDriver(visible: (s: { swipes: number; layouts: number }) => boolean) {
    const swipes: number[][] = [];
    let layouts = 0;
    const driver = {
      platform: "ios" as const,
      listDevices: async () => [{ platform: "ios", udid: "u", name: "n", booted: true }],
      screenshotPng: async () => Buffer.from(""),
      screenSize: async () => ({ w: 400, h: 800 }),
      rawLayout: async () =>
        axeLayout([
          { text: "Header", x: 0, y: 0, w: 400, h: 40 },
          visible({ swipes: swipes.length, layouts: layouts++ })
            ? { text: "Row 42", x: 0, y: 300, w: 400, h: 40 }
            : { text: "Row 42", x: 0, y: 2400, w: 400, h: 40, offscreen: true },
        ]),
      tapXY: async () => AXE,
      swipe: async (_u: string, x1: number, y1: number, x2: number, y2: number) => {
        swipes.push([x1, y1, x2, y2]);
        return AXE;
      },
      typeText: async () => AXE,
      pressKey: async () => AXE,
      launchApp: async () => {},
    } as any as DeviceDriver;
    return { driver, swipes };
  }

  /** Only the scroll expression is answered from JS; the layout stays on the driver. */
  async function connectWithScroll(result: ScrollResult) {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p: any) =>
      String(p.expression).includes("scrollToOffset")
        ? evalEnvelope(JSON.stringify(result))
        : evalEnvelope(undefined),
    );
    await getRegistry().connect({ port: metro.port });
  }

  it("returns early, without scrolling, when the element is already visible", async () => {
    await connect();
    const { driver, swipes } = rowDriver(() => true);
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "scroll_to", { text: "Row 42" });
    expect(res.content[0].text).toContain("already visible");
    expect(res.content[0].text).toContain("(input: none — already visible)");
    expect(swipes).toHaveLength(0);
  });

  it("swipes until the element becomes visible and says how many it took", async () => {
    await connect();
    const { driver, swipes } = rowDriver((s) => s.swipes >= 2);
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "scroll_to", { text: "Row 42", via: "os" });
    expect(swipes).toHaveLength(2);
    expect(swipes[0][1]).toBeGreaterThan(swipes[0][3]); // swiping up reveals what is below
    expect(res.content[0].text).toContain("Swiped up 2×");
    expect(res.content[0].text).toContain("(input: os/axe — requested)");
  });

  it("gives up after max_swipes and says the element never became visible", async () => {
    await connect();
    const { driver, swipes } = rowDriver(() => false);
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "scroll_to", { text: "Row 42", via: "os", max_swipes: 3 });
    expect(swipes).toHaveLength(3);
    expect(res.content[0].text).toMatch(/never became visible after 3 swipes/);
  });

  it("uses the JS path when it works, and never swipes", async () => {
    await connectWithScroll({ scrolled: true, container: "FlatList", method: "scrollToOffset" });
    const { driver, swipes } = rowDriver((s) => s.layouts >= 1);
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "scroll_to", { text: "Row 42" });
    expect(swipes).toHaveLength(0);
    expect(res.content[0].text).toContain("via FlatList.scrollToOffset");
    expect(res.content[0].text).toContain("now visible @200,320");
    expect(res.content[0].text).toContain("(input: js)");
  });

  it("falls back to swipes with the reason in the marker", async () => {
    await connectWithScroll({ scrolled: false, reason: "unrecognised scroll container: CustomPager" });
    const { driver, swipes } = rowDriver((s) => s.swipes >= 1);
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "scroll_to", { text: "Row 42" });
    expect(swipes).toHaveLength(1);
    expect(res.content[0].text).toContain("Swiped up 1×");
    expect(res.content[0].text).toContain("(input: os/axe — unrecognised scroll container: CustomPager)");
  });

  it("names the driver's path and its reason next to the requested one", async () => {
    await connect();
    const { driver, swipes } = rowDriver((s) => s.swipes >= 1);
    const starting = {
      ...driver,
      swipe: async (u: string, x1: number, y1: number, x2: number, y2: number, ms: number) => {
        await driver.swipe(u, x1, y1, x2, y2, ms);
        return { path: "axe" as const, reason: "runner starting" };
      },
    } as DeviceDriver;
    const server = makeServer();
    registerInteractionTools(server, { drivers: [starting] });
    const res = await callTool(server, "scroll_to", { text: "Row 42", via: "os" });
    expect(swipes).toHaveLength(1);
    expect(res.content[0].text).toContain("(input: os/axe — requested; runner starting)");
  });
});

/**
 * Answers Runtime.evaluate from a table of substring -> result. Everything
 * unmatched evaluates to undefined, so a tool that reaches for an expression
 * this test did not script degrades exactly as it would against a stale app.
 */
async function connectWithExprs(table: [string, unknown][]) {
  metro = await startFakeMetro({ port: 0 });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", (p: any) => {
    const expr = String(p.expression);
    for (const [needle, result] of table) {
      if (expr.includes(needle)) return evalEnvelope(JSON.stringify(result));
    }
    return evalEnvelope(undefined);
  });
  await getRegistry().connect({ port: metro.port });
}

function gestureDriver() {
  const swipes: number[][] = [];
  const keys: string[] = [];
  const driver = {
    platform: "ios",
    listDevices: async () => [{ platform: "ios", udid: "u", name: "n", booted: true }],
    screenshotPng: async () => Buffer.from(""),
    screenSize: async () => ({ w: 400, h: 800 }),
    rawLayout: async () => axeLayout([]),
    tapXY: async () => AXE,
    swipe: async (_u: string, x1: number, y1: number, x2: number, y2: number) => {
      swipes.push([x1, y1, x2, y2]);
      return AXE;
    },
    typeText: async () => AXE,
    pressKey: async (_u: string, key: string) => {
      keys.push(key);
      return AXE;
    },
    launchApp: async () => {},
  } as unknown as DeviceDriver;
  return { driver, swipes, keys };
}

describe("swipe", () => {
  const SCROLLED = {
    scrolled: true,
    container: "FlatList",
    method: "scrollToOffset",
    from: 0,
    to: 640,
  };

  it("scrolls the list under the finger instead of a 20s touch", async () => {
    await connectWithExprs([["rne:scrollBy", SCROLLED]]);
    const { driver, swipes } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "swipe", { direction: "up" });
    expect(swipes).toHaveLength(0);
    expect(res.content[0].text).toBe("Scrolled via js: FlatList.scrollToOffset 0 → 640 (input: js)");
  });

  it("falls back to the OS swipe and names the reason", async () => {
    await connectWithExprs([["rne:scrollBy", { scrolled: false, reason: "no scroll container under 200,400" }]]);
    const { driver, swipes } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "swipe", { x1: 200, y1: 400, x2: 200, y2: 100 });
    expect(swipes).toEqual([[200, 400, 200, 100]]);
    expect(res.content[0].text).toContain("(input: os/axe — no scroll container under 200,400)");
  });

  it("via: os swipes without asking the app anything", async () => {
    await connectWithExprs([["rne:scrollBy", SCROLLED]]);
    const { driver, swipes } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "swipe", { direction: "up", via: "os" });
    expect(swipes).toHaveLength(1);
    expect(res.content[0].text).toContain("(input: os/axe)");
  });

  it("via: js refuses when nothing under the start point scrolls", async () => {
    await connectWithExprs([["rne:scrollBy", { scrolled: false, reason: "no scroll container under 200,600" }]]);
    const { driver, swipes } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "swipe", { direction: "up", via: "js" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no scroll container under 200,600/);
    expect(swipes).toHaveLength(0);
  });
});

describe("press_key", () => {
  it("goes back through the navigation container, with no edge swipe", async () => {
    await connectWithExprs([["rne:back", { went: true, source: "fiber" }]]);
    const { driver, keys } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "press_key", { key: "back" });
    expect(keys).toEqual([]);
    expect(res.content[0].text).toBe("Pressed back. (input: js)");
  });

  it("says the navigator is at its root instead of exiting the app", async () => {
    await connectWithExprs([["rne:back", { went: false, definitive: true, reason: "nothing to go back to" }]]);
    const { driver, keys } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "press_key", { key: "back" });
    expect(keys).toEqual([]);
    expect(res.content[0].text).toContain("nothing to go back to");
  });

  it("falls back to the hardware key when no navigator is mounted", async () => {
    await connectWithExprs([["rne:back", { went: false, reason: "no react-navigation container found" }]]);
    const { driver, keys } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "press_key", { key: "back" });
    expect(keys).toEqual(["back"]);
    expect(res.content[0].text).toContain("(input: os/axe — no react-navigation container found)");
  });

  it("home stays on the OS route and says so when js is asked for", async () => {
    await connectWithExprs([]);
    const { driver, keys } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "press_key", { key: "home", via: "js" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/home/);
    expect(keys).toEqual([]);
  });

  it("home names the OS path that pressed it", async () => {
    await connectWithExprs([]);
    const { driver, keys } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "press_key", { key: "home" });
    expect(res.isError).toBeFalsy();
    expect(keys).toEqual(["home"]);
    expect(res.content[0].text).toBe("Pressed home. (input: os/axe)");
  });

  it("enter fires the field's own onSubmitEditing", async () => {
    await connectWithExprs([
      ["rne:submit", { submitted: true, field: 'testID "search"', handlers: ["onSubmitEditing", "onEndEditing"] }],
    ]);
    const { driver } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "press_key", { key: "enter", into: { testID: "search" } });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('testID "search"');
    expect(res.content[0].text).toContain("onSubmitEditing, onEndEditing");
    expect(res.content[0].text).toContain("(input: js)");
  });

  it("enter surfaces a field with no submit handler as a failure, not a shrug", async () => {
    await connectWithExprs([["rne:submit", { submitted: false, reason: "field has no onSubmitEditing handler" }]]);
    const { driver } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "press_key", { key: "enter" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no onSubmitEditing handler/);
  });

  it("enter says it is JS-only when the OS route is asked for", async () => {
    await connectWithExprs([]);
    const { driver } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "press_key", { key: "enter", via: "os" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/JS-only/);
  });
});

describe("type_text submit", () => {
  it("types and then submits the same field in one call", async () => {
    await connectWithExprs([
      ["rne:type", { typed: true, matched: { placeholder: "Search" } }],
      ["rne:read", { found: true, value: "cat" }],
      ["rne:submit", { submitted: true, field: 'placeholder "Search"', handlers: ["onSubmitEditing"] }],
    ]);
    const { driver } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "type_text", {
      text: "cat",
      into: { placeholder: "Search" },
      submit: true,
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Typed 3 chars");
    expect(res.content[0].text).toContain("Submitted");
    expect(res.content[0].text).toContain("onSubmitEditing");
  });

  it("keeps the typing result when the submit has nothing to fire", async () => {
    await connectWithExprs([
      ["rne:type", { typed: true, matched: { placeholder: "Search" } }],
      ["rne:read", { found: true, value: "cat" }],
      ["rne:submit", { submitted: false, reason: "field has no onSubmitEditing handler" }],
    ]);
    const { driver } = gestureDriver();
    const server = makeServer();
    registerInteractionTools(server, { drivers: [driver] });
    const res = await callTool(server, "type_text", { text: "cat", submit: true });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Typed 3 chars");
    expect(res.content[0].text).toMatch(/Not submitted: field has no onSubmitEditing handler/);
  });
});
