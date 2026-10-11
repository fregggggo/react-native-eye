import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runFlowInternal, formatStepLine } from "../../src/composite/runFlow.js";
import { getRegistry } from "../../src/core/registry.js";
import { startFakeMetro, type FakeMetro } from "../helpers/fakeCdp.js";
import type { DeviceDriver } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

function scriptedDriver(
  screens: Record<string, any[]>,
  order: string[],
): { driver: DeviceDriver; taps: number[][] } {
  let idx = 0;
  const taps: number[][] = [];
  const cur = () => screens[order[Math.min(idx, order.length - 1)]];
  const driver: DeviceDriver = {
    platform: "ios",
    listDevices: async () => [{ platform: "ios", udid: "u", name: "n", booted: true }],
    screenshotPng: async () => Buffer.from(""),
    rawLayout: async () => axeLayout(cur()),
    tapXY: async (_u, x, y) => {
      taps.push([x, y]);
      idx++;
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

function makeDeps() {
  let t = 0;
  return { sleep: async () => {}, now: () => (t += 50) };
}

describe("run_flow", () => {
  it("runs steps and reports all ok", async () => {
    await connect();
    const { driver, taps } = scriptedDriver(
      {
        login: [{ text: "Login", x: 0, y: 0, w: 100, h: 40 }],
        home: [{ text: "Welcome", x: 0, y: 0, w: 100, h: 40 }],
      },
      ["login", "home", "home"],
    );
    const out = await runFlowInternal(
      [{ tap: { text: "Login" } }, { expect: { text: "Welcome" } }],
      { drivers: [driver] },
      makeDeps(),
    );
    expect(out.aborted).toBeUndefined();
    expect(out.results.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(taps[0]).toEqual([50, 20]);
  });

  it("stops at the first failed expect and returns observe content", async () => {
    await connect();
    const { driver } = scriptedDriver(
      { login: [{ text: "Login", x: 0, y: 0, w: 100, h: 40 }] },
      ["login", "login", "login"],
    );
    const out = await runFlowInternal(
      [{ tap: { text: "Login" } }, { expect: { text: "Welcome" } }],
      { drivers: [driver] },
      makeDeps(),
    );
    expect(out.results[1].status).toBe("failed");
    expect(out.observeContent.some((c: any) => c.type === "text")).toBe(true);
  });

  it("reuses the settle snapshot for a following expect (no extra capture)", async () => {
    await connect();
    let captures = 0;
    const driver: DeviceDriver = {
      platform: "ios",
      listDevices: async () => [{ platform: "ios", udid: "u", name: "n", booted: true }],
      screenshotPng: async () => Buffer.from(""),
      rawLayout: async () => {
        captures++;
        return axeLayout([{ text: "Welcome", x: 0, y: 0, w: 100, h: 40 }]);
      },
      tapXY: async () => AXE,
      swipe: async () => AXE,
      typeText: async () => AXE,
      pressKey: async () => AXE,
      launchApp: async () => {},
    } as unknown as DeviceDriver;
    const out = await runFlowInternal(
      [{ tap: { x: 1, y: 2 } }, { expect: { text: "Welcome" } }],
      { drivers: [driver] },
      makeDeps(),
    );
    expect(out.results.every((r) => r.status === "ok")).toBe(true);
    // tap by coordinates: no resolve capture; settle captures once (JS settle
    // path); expect reuses the settle snapshot — no extra capture.
    expect(captures).toBeLessThanOrEqual(2);
  });

  it("aborts mid-flow when a new error appears", async () => {
    await connect();
    const { driver } = scriptedDriver(
      { login: [{ text: "Login", x: 0, y: 0, w: 100, h: 40 }] },
      ["login", "login", "login"],
    );
    // Inject an error into the connection buffer between steps by wrapping tapXY.
    const conn = getRegistry().active();
    const orig = driver.tapXY;
    driver.tapXY = async (u, x, y) => {
      const os = await orig(u, x, y);
      conn.errors.push({ seq: 1, kind: "redbox", text: "Render error: boom", timestamp: 1 });
      return os;
    };
    const out = await runFlowInternal(
      [{ tap: { text: "Login" } }, { expect: { text: "Anything" } }],
      { drivers: [driver] },
      makeDeps(),
    );
    expect(out.aborted).toContain("boom");
  });

  // The redbox LogBox swallows never reaches CDP, so the flow used to keep
  // tapping a screen covered by it — and an `expect` even matched the redbox's
  // own text (field test D3).
  it("aborts on a redbox that only exists in the app's own buffer", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    let thrown = false;
    metro.setHandler("Runtime.evaluate", (p) => {
      if (String(p.expression).includes("__RNE_ERR__") && thrown) {
        return {
          result: {
            value: JSON.stringify([
              { seq: 1, kind: "redbox", text: "Error: rne-uncaught-probe", timestamp: Date.now() },
            ]),
          },
        };
      }
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    const { driver } = scriptedDriver(
      { login: [{ text: "Login", x: 0, y: 0, w: 100, h: 40 }] },
      ["login", "login", "login"],
    );
    const orig = driver.tapXY;
    driver.tapXY = async (u, x, y) => {
      const os = await orig(u, x, y);
      thrown = true;
      return os;
    };
    const out = await runFlowInternal(
      [{ tap: { text: "Login" } }, { expect: { text: "Login" } }],
      { drivers: [driver] },
      makeDeps(),
    );
    expect(out.aborted).toContain("rne-uncaught-probe");
    expect(out.results.some((r) => r.status === "aborted")).toBe(true);
  });
});

describe("run_flow trailing snapshot", () => {
  const home = [{ text: "Home", x: 0, y: 0, w: 100, h: 40 }];
  const only = () => scriptedDriver({ a: home }, ["a"]).driver;

  it("skips the layout dump on a clean run but keeps the screenshot", async () => {
    // A one-step expect used to come back with a few hundred layout lines.
    await connect();
    const res = await runFlowInternal([{ expect: { text: "Home" } }], { drivers: [only()] });
    const text = res.observeContent.find((c: any) => c.type === "text")?.text ?? "";
    expect(res.results[0].status).toBe("ok");
    expect(res.observeContent.some((c: any) => c.type === "image")).toBe(true);
    expect(text).not.toContain("LAYOUT");
    expect(text).toContain("LOGS");
  });

  it("includes the full layout when the flow failed", async () => {
    await connect();
    const res = await runFlowInternal([{ expect: { text: "Nope" } }], { drivers: [only()] });
    const text = res.observeContent.find((c: any) => c.type === "text")?.text ?? "";
    expect(res.results[0].status).toBe("failed");
    expect(text).toContain("LAYOUT");
  });

  it("returns nothing extra with observe:none", async () => {
    await connect();
    const res = await runFlowInternal([{ expect: { text: "Home" } }], { drivers: [only()], observe: "none" });
    expect(res.observeContent).toEqual([]);
  });

  it("always includes the layout with observe:full", async () => {
    await connect();
    const res = await runFlowInternal([{ expect: { text: "Home" } }], { drivers: [only()], observe: "full" });
    const text = res.observeContent.find((c: any) => c.type === "text")?.text ?? "";
    expect(text).toContain("LAYOUT");
  });
});

describe("run_flow input path", () => {
  const screen = { a: [{ text: "Go", x: 0, y: 0, w: 100, h: 40 }] };

  // The dispatchers are injected, so these tests exercise the flow's own logic —
  // via precedence, the report marker, the snapshot cache — without a simulator.
  // Both driver input methods throw: nothing here may reach the OS path.
  function noOsDriver(): DeviceDriver {
    const { driver } = scriptedDriver(screen, ["a"]);
    driver.tapXY = async () => {
      throw new Error("the OS touch path must not be reached");
    };
    driver.typeText = async () => {
      throw new Error("the OS touch path must not be reached");
    };
    return driver;
  }

  it("lets a step's own via win over the flow-level default", async () => {
    await connect();
    const seen: string[] = [];
    const out = await runFlowInternal(
      [{ tap: { text: "Go", via: "js" } }, { type: { text: "hi", via: "os" } }],
      { drivers: [noOsDriver()], via: "auto" },
      {
        ...makeDeps(),
        dispatchTap: async (a: any) => {
          seen.push(`tap:${a.via}`);
          return { marker: `(input: ${a.via})` };
        },
        dispatchType: async (a: any) => {
          seen.push(`type:${a.via}`);
          return { marker: `(input: ${a.via})` };
        },
      },
    );
    expect(out.results.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(seen).toEqual(["tap:js", "type:os"]);
  });

  it("applies the flow-level via to a step that does not name one", async () => {
    // The point of the flow-level default: a six-step flow says "all of this
    // goes through JS" once instead of six times.
    await connect();
    const seen: string[] = [];
    const out = await runFlowInternal(
      [{ tap: { text: "Go" } }, { type: { text: "hi" } }],
      { drivers: [noOsDriver()], via: "js" },
      {
        ...makeDeps(),
        dispatchTap: async (a: any) => {
          seen.push(a.via);
          return { marker: "(input: js)" };
        },
        dispatchType: async (a: any) => {
          seen.push(a.via);
          return { marker: "(input: js)" };
        },
      },
    );
    expect(out.results.map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(seen).toEqual(["js", "js"]);
  });

  it("defaults to auto when neither the step nor the flow names a path", async () => {
    await connect();
    const seen: string[] = [];
    await runFlowInternal(
      [{ tap: { text: "Go" } }],
      { drivers: [noOsDriver()] },
      {
        ...makeDeps(),
        dispatchTap: async (a: any) => {
          seen.push(a.via);
          return { marker: "(input: js)" };
        },
      },
    );
    expect(seen).toEqual(["auto"]);
  });

  it("names the input path on the step's report line", async () => {
    await connect();
    const js = await runFlowInternal(
      [{ tap: { text: "Go", via: "js" } }],
      { drivers: [noOsDriver()] },
      { ...makeDeps(), dispatchTap: async () => ({ marker: "(input: js)" }) },
    );
    expect(js.results[0].input).toBe("(input: js)");
    expect(formatStepLine(js.results[0])).toBe(`1. ${js.results[0].step} — ok (input: js)`);

    // A fallback must carry its reason all the way to the line the agent reads.
    const os = await runFlowInternal(
      [{ tap: { text: "Go" } }],
      { drivers: [noOsDriver()] },
      {
        ...makeDeps(),
        dispatchTap: async () => ({ marker: "(input: os — no press handler in ancestry)" }),
      },
    );
    expect(formatStepLine(os.results[0])).toContain("(input: os — no press handler in ancestry)");
  });

  it("invalidates the layout snapshot after a JS press, not only after an OS touch", async () => {
    // A JS press mutates the screen exactly as a touch does, and it is a new code
    // path into the same cache. If the pre-press snapshot survived the press, the
    // third step would assert against the login screen and fail.
    await connect();
    let pressed = false;
    let capturesAfterPress = 0;
    const driver = {
      platform: "ios",
      listDevices: async () => [{ platform: "ios", udid: "u", name: "n", booted: true }],
      screenshotPng: async () => Buffer.from(""),
      rawLayout: async () => {
        if (pressed) capturesAfterPress++;
        return axeLayout(
          pressed
            ? [{ text: "Welcome", x: 0, y: 0, w: 100, h: 40 }]
            : [{ text: "Login", x: 0, y: 0, w: 100, h: 40 }],
        );
      },
      tapXY: async () => {
        throw new Error("a JS press must not reach the driver");
      },
      swipe: async () => AXE,
      typeText: async () => AXE,
      pressKey: async () => AXE,
      launchApp: async () => {},
    } as unknown as DeviceDriver;

    const out = await runFlowInternal(
      [{ expect: { text: "Login" } }, { tap: { text: "Login", via: "js" } }, { expect: { text: "Welcome" } }],
      { drivers: [driver] },
      {
        ...makeDeps(),
        dispatchTap: async () => {
          pressed = true;
          return { marker: "(input: js)" };
        },
      },
    );
    expect(out.results.map((r) => r.status)).toEqual(["ok", "ok", "ok"]);
    expect(capturesAfterPress).toBeGreaterThan(0);
  });
});

describe("wait_for budget", () => {
  it("honours timeout_ms, so the poll loop stops when the caller says it should", async () => {
    await connect();
    let captures = 0;
    const driver: DeviceDriver = {
      platform: "ios",
      listDevices: async () => [{ platform: "ios", udid: "u", name: "n", booted: true }],
      screenshotPng: async () => Buffer.from(""),
      rawLayout: async () => {
        captures++;
        return axeLayout([{ text: "Still loading", x: 0, y: 0, w: 100, h: 40 }]);
      },
      tapXY: async () => AXE,
      swipe: async () => AXE,
      typeText: async () => AXE,
      pressKey: async () => AXE,
      launchApp: async () => {},
    } as unknown as DeviceDriver;

    // The fake clock advances 50ms per read, so an ignored timeout_ms would
    // fall back to the 3000ms default and poll ~60 times before giving up.
    const out = await runFlowInternal(
      [{ wait_for: { text: "Never appears", timeout_ms: 0 } } as any],
      { drivers: [driver] },
      makeDeps(),
    );
    expect(out.results[0].status).toBe("failed");
    expect(captures).toBeLessThan(5);
  });
});

describe("run_flow swipe step", () => {
  it("reports which OS path delivered the swipe", async () => {
    await connect();
    const swipes: number[][] = [];
    const { driver } = scriptedDriver({ a: [{ text: "Feed", x: 0, y: 0, w: 100, h: 40 }] }, ["a"]);
    driver.swipe = async (_u, x1, y1, x2, y2) => {
      swipes.push([x1, y1, x2, y2]);
      return AXE;
    };
    const out = await runFlowInternal(
      [{ swipe: { x1: 200, y1: 600, x2: 200, y2: 200 } } as any],
      { drivers: [driver], observe: "none" },
      makeDeps(),
    );
    expect(swipes).toEqual([[200, 600, 200, 200]]);
    expect(out.results[0].status).toBe("ok");
    expect(out.results[0].input).toBe("(input: os/axe)");
    expect(formatStepLine(out.results[0])).toBe(`1. ${out.results[0].step} — ok (input: os/axe)`);
  });

  it("carries the driver's reason for not using the runner", async () => {
    await connect();
    const { driver } = scriptedDriver({ a: [{ text: "Feed", x: 0, y: 0, w: 100, h: 40 }] }, ["a"]);
    driver.swipe = async () => ({ path: "axe", reason: "runner starting" });
    const out = await runFlowInternal(
      [{ swipe: { x1: 200, y1: 600, x2: 200, y2: 200 } } as any],
      { drivers: [driver], observe: "none" },
      makeDeps(),
    );
    expect(out.results[0].input).toBe("(input: os/axe — runner starting)");
  });
});
