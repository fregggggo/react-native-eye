import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerLayoutTools, captureLayoutWithSource, layoutMarker } from "../../src/tools/layout.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, evalEnvelope, type FakeMetro } from "../helpers/fakeCdp.js";
import type { DeviceDriver, OsPath } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";
import { DriverError } from "../../src/core/errors.js";
import { UIAUTOMATOR_JS_RECOMMENDATION } from "../../src/drivers/android.js";
import { resetAppSpaceCache } from "../../src/layout/appSpace.js";
import { isVisible } from "../../src/layout/elements.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

function driverWith(raw: any[]): DeviceDriver {
  return {
    platform: "ios",
    listDevices: async () => [{ platform: "ios", udid: "u", name: "n", booted: true }],
    screenshotPng: async () => Buffer.from("PNG"),
    rawLayout: async () => axeLayout(raw),
    tapXY: async () => AXE,
    swipe: async () => AXE,
    typeText: async () => AXE,
    pressKey: async () => AXE,
    launchApp: async () => {},
  };
}

async function connect() {
  metro = await startFakeMetro({ port: 0 });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", () => ({ result: { value: undefined } }));
  await getRegistry().connect({ port: metro.port });
}

describe("get_layout", () => {
  it("renders a compact layout using an injected driver", async () => {
    await connect();
    const server = makeServer();
    registerLayoutTools(server, { drivers: [driverWith([{ text: "Login", x: 0, y: 0, w: 100, h: 40 }])] });
    const res = await callTool(server, "get_layout", {});
    expect(res.content[0].text).toContain("Login @50,20");
  });

  const fixture = [
    { text: "Login", testID: "login-btn", type: "Button", x: 0, y: 0, w: 100, h: 40 },
    { text: "Email", type: "TextField", x: 0, y: 100, w: 200, h: 40 },
  ];

  it("filters with search", async () => {
    await connect();
    const server = makeServer();
    registerLayoutTools(server, { drivers: [driverWith(fixture)] });
    const res = await callTool(server, "get_layout", { search: ["login"] });
    expect(res.content[0].text).toContain("Login");
    expect(res.content[0].text).not.toContain("Email");
  });

  it("returns the element at a point with its frame", async () => {
    await connect();
    const server = makeServer();
    registerLayoutTools(server, { drivers: [driverWith(fixture)] });
    const res = await callTool(server, "get_layout", { at: { x: 50, y: 20 } });
    expect(res.content[0].text).toContain("Login");
    expect(res.content[0].text).toContain("(0,0 100x40)");
  });

  it("reports no element at an empty point", async () => {
    await connect();
    const server = makeServer();
    registerLayoutTools(server, { drivers: [driverWith(fixture)] });
    const res = await callTool(server, "get_layout", { at: { x: 999, y: 999 } });
    expect(res.content[0].text).toContain("No element at (999, 999)");
  });

  it("rejects search combined with at", async () => {
    await connect();
    const server = makeServer();
    registerLayoutTools(server, { drivers: [driverWith(fixture)] });
    const res = await callTool(server, "get_layout", { search: ["x"], at: { x: 1, y: 1 } });
    expect(res.isError).toBe(true);
  });

  it("appends the layout source marker", async () => {
    await connect();
    const server = makeServer();
    registerLayoutTools(server, { drivers: [driverWith([{ text: "Login", x: 0, y: 0, w: 100, h: 40 }])] });
    const res = await callTool(server, "get_layout", {});
    expect(res.content[0].text).toMatch(/\(layout: (js|os)/);
  });

  it("lists a searched-for element even when it is covered", async () => {
    await connect();
    const server = makeServer();
    registerLayoutTools(server, {
      drivers: [driverWith([{ testID: "extra-icon-play-square-bold", x: 40, y: 810, w: 24, h: 24, hidden: true }])],
    });
    const res = await callTool(server, "get_layout", { search: ["extra-icon"] });
    // Field test D8: the answer to an explicit search was "(+1 on hidden
    // screens/covered: extra-icon-play-square-bold)".
    expect(res.content[0].text).toContain("extra-icon-play-square-bold @52,822");
  });

  it("says no matching elements, actionably, when a search finds nothing", async () => {
    await connect();
    const server = makeServer();
    registerLayoutTools(server, { drivers: [driverWith(fixture)] });
    const res = await callTool(server, "get_layout", { search: ["zzz-does-not-exist"] });
    expect(res.content[0].text).toContain("(no matching elements)");
  });
});

describe("captureLayoutWithSource", () => {
  const jsEls = [{ text: "FastLogin", type: "RCTText", x: 0, y: 0, w: 50, h: 20 }];

  it("prefers the JS path when the conn returns elements", async () => {
    const conn = { evaluate: async () => JSON.stringify({ available: true, els: jsEls }) };
    const { els, source } = await captureLayoutWithSource(
      driverWith([{ text: "OsLogin", x: 0, y: 0, w: 1, h: 1 }]),
      "u",
      { conn },
    );
    expect(source).toBe("js");
    expect(els[0].text).toBe("FastLogin");
    expect(els[0].cx).toBe(25);
  });

  it("carries the overlay flag into the note so get_layout and observe both say what covers the screen (D12)", async () => {
    const conn = {
      evaluate: async () =>
        JSON.stringify({ available: true, els: jsEls, overlay: true }),
    };
    const { note } = await captureLayoutWithSource(driverWith([]), "u", { conn });
    expect(note).toMatch(/LogBox redbox covers the screen — everything under it is marked covered/);
  });

  it("falls back to the driver when the hook is unavailable", async () => {
    const conn = { evaluate: async () => JSON.stringify({ available: false }) };
    const { els, source } = await captureLayoutWithSource(
      driverWith([{ text: "OsLogin", x: 0, y: 0, w: 1, h: 1 }]),
      "u",
      { conn },
    );
    expect(source).toBe("os");
    expect(els[0].text).toBe("OsLogin");
  });

  it("falls back when evaluate throws", async () => {
    const conn = { evaluate: async () => { throw new Error("no runtime"); } };
    const { source } = await captureLayoutWithSource(
      driverWith([{ text: "X", x: 0, y: 0, w: 1, h: 1 }]),
      "u",
      { conn },
    );
    expect(source).toBe("os");
  });

  it("source: os skips the conn entirely", async () => {
    let evals = 0;
    const conn = { evaluate: async () => { evals++; return "{}"; } };
    await captureLayoutWithSource(driverWith([{ text: "X", x: 0, y: 0, w: 1, h: 1 }]), "u", {
      conn,
      source: "os",
    });
    expect(evals).toBe(0);
  });

  it("source: js errors instead of falling back", async () => {
    const conn = { evaluate: async () => JSON.stringify({ available: false }) };
    await expect(captureLayoutWithSource(driverWith([]), "u", { conn, source: "js" })).rejects.toThrow(
      /JS layout unavailable/,
    );
  });

  it("names both failures when the JS path finds nothing and the OS capture also fails, without recommending the JS path that already failed", async () => {
    const conn = { evaluate: async () => JSON.stringify({ available: false, error: "no measurable elements" }) };
    const driver: DeviceDriver = {
      ...driverWith([]),
      rawLayout: async () => {
        // Same shape `AndroidDriver.rawLayout` actually throws: a diagnosis
        // plus the "use source:\"js\"" recommendation, built from the same
        // exported constant, so this fixture cannot drift from production
        // wording — and so the "does not recommend source:\"js\"" assertion
        // below is checking something real, not a fixture that conveniently
        // never had the clause to begin with.
        throw new DriverError(
          "uiautomator returned no view hierarchy: ERROR: could not get idle state.",
          UIAUTOMATOR_JS_RECOMMENDATION,
        );
      },
    };
    // "auto" is the default: the JS path already failed (recorded as `note`),
    // then the OS path (rawLayout) also throws. Losing the JS reason here means
    // the caller only ever learns half of what went wrong on a screen where
    // both capture paths failed.
    let err: unknown;
    try {
      await captureLayoutWithSource(driver, "u", { conn });
    } catch (e) {
      err = e;
    }
    const message = err instanceof Error ? err.message : String(err);
    expect(message).toMatch(/no measurable elements/);
    expect(message).toMatch(/could not get idle state/);
    // The JS path is exactly what just failed (that's what `note` says) — an
    // agent told to retry it here would loop forever.
    expect(message).not.toMatch(/source:"js"/);
  });

  it("source: os propagates the driver's own error unchanged, with no JS clause bolted on", async () => {
    const driver: DeviceDriver = {
      ...driverWith([]),
      rawLayout: async () => {
        throw new DriverError("uiautomator returned no view hierarchy: ERROR: could not get idle state.");
      },
    };
    // source: os never runs the JS path, so there is no note to fold in — the
    // driver's error must reach the caller exactly as thrown.
    await expect(captureLayoutWithSource(driver, "u", { source: "os" })).rejects.toMatchObject({
      name: "DriverError",
      message: "uiautomator returned no view hierarchy: ERROR: could not get idle state.",
    });
  });
});

// D38. The values are the ones the device produced: scale 3.5, origin (0,144),
// the inspector's Dismiss at [0,778.3,205.7,48] dp → @360,2952 px, a full-screen
// inspector surface that measures the same whether or not its dialog is shown.
describe("LogBox overlay verdict is checked against the OS window list (D38)", () => {
  beforeEach(() => resetAppSpaceCache());

  const overlayEls = [
    { text: "For You", type: "RCTText", x: 130.9, y: 10.9, w: 71.4, h: 21.1, hidden: true, hiddenBy: "covered", beneath: "visible" },
    { text: "Other tab", type: "RCTText", x: 100, y: 300, w: 80, h: 20, hidden: true, hiddenBy: "covered", beneath: "inactive-screen" },
    { testID: "tab-icon", type: "RCTView", x: 118.9, y: 774.3, w: 24, h: 24, hidden: true, hiddenBy: "covered", beneath: "covered" },
    { text: "LogBox fatal: rne-d38", type: "RCTView", x: 10, y: 753.7, w: 391.4, h: 48, hidden: true, hiddenBy: "covered", beneath: "visible" },
    { text: "Dismiss", type: "RCTText", x: 0, y: 778.3, w: 205.7, h: 48, overlay: true },
  ];
  const payload = {
    available: true,
    overlay: true,
    viewport: { x: 0, y: -41.1, w: 411.4, h: 891.4 },
    toasts: [{ x: 10, y: 753.7, w: 391.4, h: 48, text: "LogBox fatal: rne-d38", covers: 1 }],
    els: overlayEls,
  };
  const conn = (p: any = payload) => ({ evaluate: async () => JSON.stringify(p) });

  function android(state: () => { x: number; y: number; overlayWindow?: boolean } | undefined) {
    let reads = 0;
    const d = {
      ...driverWith([]),
      platform: "android",
      pointScale: async () => 3.5,
      appOrigin: async () => {
        reads++;
        return state();
      },
    } as unknown as DeviceDriver;
    return { d, reads: () => reads };
  }
  const byLabel = (els: any[]) => Object.fromEntries(els.map((e) => [e.text ?? e.testID, e]));

  it("withdraws the verdict when the OS shows no dialog window: the app is reachable, the inspector is not", async () => {
    const { d } = android(() => ({ x: 0, y: 144, overlayWindow: false }));
    const { els, note } = await captureLayoutWithSource(d, "emu", { conn: conn(), source: "js" });
    const t = byLabel(els);
    expect(isVisible(t["For You"])).toBe(true);
    expect(t["For You"].hiddenBy).toBeUndefined();
    // What was hidden for its own reasons stays hidden for those reasons.
    expect(t["Other tab"]).toMatchObject({ hidden: true, hiddenBy: "inactive-screen" });
    expect(t["tab-icon"]).toMatchObject({ hidden: true, hiddenBy: "covered" });
    expect(isVisible(t["LogBox fatal: rne-d38"])).toBe(true);
    // The inspector's buttons are in a window that is not there: an OS tap at
    // @360,2952 would land on the app under it.
    expect(t["Dismiss"]).toMatchObject({ hidden: true, hiddenBy: "window", cx: 360, cy: 2952 });
    expect(note).not.toMatch(/redbox covers the screen/);
    expect(note).toMatch(/LogBox inspector is open in the JS state but its window is not on screen/);
    expect(els.some((e: any) => "beneath" in e)).toBe(false);
  });

  it("then names the toast, which is what is really on screen", async () => {
    const { d } = android(() => ({ x: 0, y: 144, overlayWindow: false }));
    const { note } = await captureLayoutWithSource(d, "emu", { conn: conn(), source: "js" });
    expect(note).toMatch(/a LogBox toast is on screen @720,2866/);
    expect(note).toMatch(/1 element under it is marked covered/);
    expect(note).toMatch(/tap "Dismiss LogBox toast" to close it/);
  });

  it("keeps the verdict when the OS confirms a dialog window (D12)", async () => {
    const { d } = android(() => ({ x: 0, y: 144, overlayWindow: true }));
    const { els, note } = await captureLayoutWithSource(d, "emu", { conn: conn(), source: "js" });
    const t = byLabel(els);
    expect(t["For You"]).toMatchObject({ hidden: true, hiddenBy: "covered" });
    expect(isVisible(t["Dismiss"])).toBe(true);
    expect(note).toMatch(/LogBox redbox covers the screen — everything under it is marked covered/);
    // The toast is under the redbox: not worth a second note.
    expect(note).not.toMatch(/toast/);
  });

  it("keeps the verdict when the OS cannot say (no flag, failed read, or a driver without appOrigin)", async () => {
    for (const d of [
      android(() => ({ x: 0, y: 144 })).d,
      android(() => undefined).d,
      android(() => {
        throw new Error("adb died");
      }).d,
      driverWith([]),
    ]) {
      resetAppSpaceCache();
      const { els, note } = await captureLayoutWithSource(d, "emu", { conn: conn(), source: "js" });
      expect(byLabel(els)["For You"]).toMatchObject({ hidden: true, hiddenBy: "covered" });
      expect(note).toMatch(/LogBox redbox covers the screen/);
    }
  });

  it("asks the OS once per capture, and only when the JS verdict is overlay", async () => {
    const plain = { ...payload, overlay: false, toasts: undefined, els: [{ text: "For You", x: 130.9, y: 10.9, w: 71.4, h: 21.1 }] };
    const { d, reads } = android(() => ({ x: 0, y: 144, overlayWindow: false }));
    await captureLayoutWithSource(d, "emu", { conn: conn(plain), source: "js" });
    await captureLayoutWithSource(d, "emu", { conn: conn(plain), source: "js" });
    expect(reads()).toBe(1); // the origin read, cached — the common path pays nothing extra
    await captureLayoutWithSource(d, "emu", { conn: conn(), source: "js" });
    expect(reads()).toBe(2); // exactly one fresh read for the overlay verdict
  });

  it("reports a toast on its own, in screen units (D34)", async () => {
    const toastOnly = {
      ...payload,
      overlay: false,
      toasts: [{ x: 10, y: 753.7, w: 391.4, h: 48, text: "LogBox fatal: rne-d38", covers: 9 }],
      els: [{ text: "LogBox fatal: rne-d38", type: "RCTView", x: 10, y: 753.7, w: 391.4, h: 48 }],
    };
    const { d } = android(() => ({ x: 0, y: 144, overlayWindow: false }));
    const { note } = await captureLayoutWithSource(d, "emu", { conn: conn(toastOnly), source: "js" });
    expect(note).toBe(
      'a LogBox toast is on screen @720,2866 (35,2782 1370x168: "LogBox fatal: rne-d38") — 9 elements under it are marked covered; tap "Dismiss LogBox toast" to close it',
    );
  });
});

describe("JS layout diagnostics", () => {
  async function connectWithJsLayout(result: unknown) {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) =>
      String(p.expression).includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")
        ? evalEnvelope(JSON.stringify(result))
        : evalEnvelope(undefined),
    );
    await getRegistry().connect({ port: metro.port });
  }

  it("says why the JS path was skipped instead of hiding it behind a fixed string", async () => {
    await connectWithJsLayout({ available: false, error: "walked 7675 fibers, 0 measurable host components" });
    const server = makeServer();
    registerLayoutTools(server, { drivers: [driverWith([{ text: "Fallback", x: 0, y: 0, w: 10, h: 10 }])] });
    const res = await callTool(server, "get_layout", {});
    expect(res.content[0].text).toContain("layout: os");
    expect(res.content[0].text).toContain("0 measurable host components");
  });

  it("uses the JS result when it has elements", async () => {
    await connectWithJsLayout({
      available: true,
      viewport: { x: 0, y: 0, w: 400, h: 800 },
      els: [{ text: "From JS", x: 0, y: 0, w: 100, h: 40 }],
    });
    const server = makeServer();
    registerLayoutTools(server, { drivers: [driverWith([])] });
    const res = await callTool(server, "get_layout", {});
    expect(res.content[0].text).toContain("From JS @50,20");
    expect(res.content[0].text).toContain("(layout: js)");
  });

  it("scales JS coordinates into the driver's units (Android dp → px)", async () => {
    await connectWithJsLayout({
      available: true,
      viewport: { x: 0, y: 0, w: 400, h: 800 },
      els: [{ text: "Button", x: 10, y: 20, w: 100, h: 40 }],
    });
    const android: DeviceDriver = {
      ...driverWith([]),
      platform: "android",
      pointScale: async () => 2.625,
    };
    const server = makeServer();
    registerLayoutTools(server, { drivers: [android] });
    const res = await callTool(server, "get_layout", {});
    // centre of (10,20 100x40) in dp = (60,40) → ×2.625 = (157,105) in px
    expect(res.content[0].text).toContain("Button @158,105");
  });
});

describe("captureLayoutWithSource: OS path provenance", () => {
  const els = [{ text: "X", x: 0, y: 0, w: 1, h: 1 }];
  function driverOs(os: OsPath): DeviceDriver {
    return { ...driverWith([]), rawLayout: async () => ({ els, os }) };
  }

  it("reports source runner when the driver captured through the runner", async () => {
    const out = await captureLayoutWithSource(driverOs({ path: "runner" }), "u", { source: "os" });
    expect(out.source).toBe("runner");
    expect(out.note).toBeUndefined();
    expect(out.els[0].text).toBe("X");
    expect(layoutMarker(out)).toBe("\n(layout: runner)");
  });

  it("puts the driver's fallback reason into the note, keeping source os", async () => {
    const out = await captureLayoutWithSource(driverOs({ path: "axe", reason: "runner starting" }), "u", {
      source: "os",
    });
    expect(out.source).toBe("os");
    expect(out.note).toBe("runner starting");
  });

  it("joins the JS note and the driver's reason, JS first", async () => {
    const conn = { evaluate: async () => JSON.stringify({ available: false, error: "no measurable elements" }) };
    const out = await captureLayoutWithSource(driverOs({ path: "axe", reason: "runner starting" }), "u", { conn });
    expect(out.source).toBe("os");
    expect(out.note).toBe("js layout unavailable: no measurable elements; runner starting");
  });
});
