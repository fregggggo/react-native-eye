import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { IosDriver, fallbackReason } from "../../src/drivers/ios.js";
import { NativeCallError, type NativeFailureKind } from "../../src/native/httpClient.js";
import type { NativeBackend } from "../../src/native/nativeBackend.js";
import type { PoolEntryView } from "../../src/native/pool.js";
import { osMarker } from "../../src/input/dispatch.js";
import type { OsPath } from "../../src/drivers/types.js";

const ATT = JSON.parse(readFileSync(new URL("../fixtures/xcrunner/att-alert.json", import.meta.url), "utf8"));
const AXE_JSON = JSON.stringify([
  {
    type: "Application",
    AXLabel: "App",
    frame: { x: 0, y: 0, width: 402, height: 874 },
    children: [{ type: "Button", AXLabel: "Axe button", frame: { x: 10, y: 10, width: 50, height: 20 } }],
  },
]);
const PNG_RUNNER = Buffer.from("runner-png");
const PNG_SIMCTL = Buffer.from("simctl-png");
const US = async () => "com.apple.keylayout.US";

function fakeRunner(extra: Record<string, string> = {}) {
  const calls: string[] = [];
  const runner = async (cmd: string, args: string[]) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const hit = Object.keys(extra).find((k) => line.includes(k));
    const stdout = hit ? extra[hit] : line.includes("describe-ui") ? AXE_JSON : "";
    const stdoutBuffer = line.includes("simctl io") ? PNG_SIMCTL : Buffer.from(stdout);
    return { stdout, stdoutBuffer, stderr: "" };
  };
  return { runner: runner as any, calls, axe: () => calls.filter((c) => c.startsWith("axe ")) };
}

type Method = "touch" | "swipe" | "inputText" | "pressKey" | "pressButton" | "hierarchy" | "screenshot";
const MESSAGES: Record<NativeFailureKind, string> = {
  refused: "connect ECONNREFUSED 127.0.0.1:52000",
  lost: "socket hang up",
  unsupported: "XCPointerEventPath",
  rejected: "invalid coordinates",
};

function fakeBackend(fail?: { method: Method; kind: NativeFailureKind }, hierarchy: unknown = ATT) {
  const calls: string[] = [];
  const act =
    (name: Method, result?: () => unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args.filter((a) => a !== undefined)].join(" "));
      if (fail?.method === name) throw new NativeCallError(fail.kind, MESSAGES[fail.kind]);
      return result?.();
    };
  const backend = {
    platform: "ios",
    status: async () => ({ status: "ok", version: "t" }),
    hierarchy: act("hierarchy", () => hierarchy),
    touch: act("touch"),
    swipe: act("swipe"),
    inputText: act("inputText"),
    eraseText: async () => {},
    pressKey: act("pressKey"),
    pressButton: act("pressButton"),
    screenshot: act("screenshot", () => PNG_RUNNER),
    isScreenStatic: async () => true,
    deviceInfo: async () => ({ widthPixels: 1206, heightPixels: 2622 }),
  } as unknown as NativeBackend;
  return { backend, calls };
}

function fakePool(backend?: NativeBackend, view?: PoolEntryView) {
  const marks: string[] = [];
  const pool = {
    get: () => backend,
    view: () => view ?? (backend ? ({ state: "ready" } as PoolEntryView) : undefined),
    // I-1: every report names the backend the failing call used, so the pool
    // can drop reports about a runner it has already replaced. A mark from any
    // other backend shows up in `marks` and fails the test's toEqual.
    markDead: (p: string, u: string, r: string, from: NativeBackend) =>
      void marks.push(`${from === backend ? "" : "WRONG BACKEND "}dead ${p} ${u} ${r}`),
    markFailed: (p: string, u: string, r: string, from: NativeBackend) =>
      void marks.push(`${from === backend ? "" : "WRONG BACKEND "}failed ${p} ${u} ${r}`),
  };
  return { pool, marks };
}

function setup(opts: { backend?: NativeBackend; view?: PoolEntryView; layout?: () => Promise<string | undefined>; extra?: Record<string, string> } = {}) {
  const r = fakeRunner(opts.extra);
  const p = fakePool(opts.backend, opts.view);
  const d = new IosDriver(r.runner, undefined, opts.layout ?? US, p.pool as any);
  return { d, ...r, marks: p.marks };
}

const STARTING: PoolEntryView = { state: "starting" };
const FAILED: PoolEntryView = { state: "failed", reason: "simctl launch: no /status after 20000ms" };
const DEAD: PoolEntryView = { state: "dead", reason: "connect ECONNREFUSED 127.0.0.1:52000" };
const DISABLED: PoolEntryView = { state: "failed", reason: "disabled (RNE_NATIVE_DRIVER=off)" };

type Gesture = {
  name: string;
  method: Method;
  run: (d: IosDriver) => Promise<OsPath>;
  runnerCall: string;
  axeCall: string;
};

const GESTURES: Gesture[] = [
  { name: "tapXY", method: "touch", run: (d) => d.tapXY("U", 50, 60), runnerCall: "touch 50 60", axeCall: "axe tap -x 50 -y 60 --udid U" },
  {
    name: "tapXY long press",
    method: "touch",
    run: (d) => d.tapXY("U", 50, 60, 1500),
    runnerCall: "touch 50 60 1500",
    axeCall: "axe touch -x 50 -y 60 --down --up --delay 1.5 --udid U",
  },
  {
    name: "swipe",
    method: "swipe",
    run: (d) => d.swipe("U", 200, 700, 200, 300, 300),
    runnerCall: "swipe 200 700 200 300 300",
    axeCall: "axe swipe --start-x 200 --start-y 700 --end-x 200 --end-y 300 --duration 0.3 --udid U",
  },
  { name: "typeText", method: "inputText", run: (d) => d.typeText("U", "cat"), runnerCall: "inputText cat", axeCall: "axe type cat --udid U" },
  { name: "pressKey home", method: "pressButton", run: (d) => d.pressKey("U", "home"), runnerCall: "pressButton home", axeCall: "axe button home --udid U" },
  {
    name: "pressKey back",
    method: "swipe",
    run: (d) => d.pressKey("U", "back", { viewport: { x: 0, y: 0, w: 440, h: 956 } }),
    runnerCall: "swipe 0 478 198 478 200",
    axeCall: "axe swipe --start-x 0 --start-y 478 --end-x 198 --end-y 478 --duration 0.2 --udid U",
  },
];

describe.each(GESTURES)("IosDriver.$name through the runner", (g) => {
  it("ok → runner, no axe", async () => {
    const b = fakeBackend();
    const { d, axe, marks } = setup({ backend: b.backend });
    const os = await g.run(d);
    expect(os).toEqual({ path: "runner" });
    expect(osMarker(os)).toBe("(input: os/runner)");
    expect(b.calls).toEqual([g.runnerCall]);
    expect(axe()).toEqual([]);
    expect(marks).toEqual([]);
  });

  it("refused → mark dead, run axe, name the reason", async () => {
    const b = fakeBackend({ method: g.method, kind: "refused" });
    const { d, axe, marks } = setup({ backend: b.backend });
    const os = await g.run(d);
    expect(os).toEqual({ path: "axe", reason: "runner dead: connect ECONNREFUSED 127.0.0.1:52000" });
    expect(osMarker(os)).toBe("(input: os/axe — runner dead: connect ECONNREFUSED 127.0.0.1:52000)");
    expect(marks).toEqual(["dead ios U connect ECONNREFUSED 127.0.0.1:52000"]);
    expect(axe()).toEqual([g.axeCall]);
  });

  it("lost → mark dead, never repeat through axe, tell the caller to check the screen", async () => {
    const b = fakeBackend({ method: g.method, kind: "lost" });
    const { d, axe, marks } = setup({ backend: b.backend });
    await expect(g.run(d)).rejects.toThrow(/gesture may not have been delivered — check the screen before retrying/);
    await expect(g.run(d)).rejects.toMatchObject({ name: "DriverError" });
    expect(marks[0]).toBe("dead ios U socket hang up");
    expect(axe()).toEqual([]);
  });

  it("unsupported → mark failed with the symbol, run axe", async () => {
    const b = fakeBackend({ method: g.method, kind: "unsupported" });
    const { d, axe, marks } = setup({ backend: b.backend });
    const os = await g.run(d);
    expect(os).toEqual({ path: "axe", reason: "unsupported: XCPointerEventPath" });
    expect(osMarker(os)).toBe("(input: os/axe — unsupported: XCPointerEventPath)");
    expect(marks).toEqual(["failed ios U unsupported: XCPointerEventPath"]);
    expect(axe()).toEqual([g.axeCall]);
  });

  it("rejected → surface the runner's message, no fallback, no mark", async () => {
    const b = fakeBackend({ method: g.method, kind: "rejected" });
    const { d, axe, marks } = setup({ backend: b.backend });
    await expect(g.run(d)).rejects.toThrow(/iOS runner refused the .+: invalid coordinates/);
    expect(axe()).toEqual([]);
    expect(marks).toEqual([]);
  });

  it.each([
    ["no entry yet", undefined, "runner starting"],
    ["starting", STARTING, "runner starting"],
    ["failed", FAILED, "runner failed: simctl launch: no /status after 20000ms"],
    ["dead", DEAD, "runner dead: connect ECONNREFUSED 127.0.0.1:52000"],
  ] as const)("not ready (%s) → axe, marker names the state", async (_label, view, reason) => {
    const { d, axe } = setup({ view });
    const os = await g.run(d);
    expect(os).toEqual({ path: "axe", reason });
    expect(osMarker(os)).toBe(`(input: os/axe — ${reason})`);
    expect(axe()).toEqual([g.axeCall]);
  });

  it("switched off → axe with the marker exactly as before the runner existed", async () => {
    const { d, axe } = setup({ view: DISABLED });
    const os = await g.run(d);
    expect(os).toEqual({ path: "axe" });
    expect(osMarker(os)).toBe("(input: os/axe)");
    expect(axe()).toEqual([g.axeCall]);
  });
});

describe("IosDriver.typeText guards only the axe branch", () => {
  it("types Cyrillic through the runner under a Russian host layout without reading the layout", async () => {
    let reads = 0;
    const b = fakeBackend();
    const { d, calls } = setup({
      backend: b.backend,
      layout: async () => {
        reads++;
        return "com.apple.keylayout.RussianWin";
      },
    });
    expect(await d.typeText("U", "привет 🎉")).toEqual({ path: "runner" });
    expect(b.calls).toEqual(["inputText привет 🎉"]);
    expect(reads).toBe(0);
    expect(calls).toEqual([]);
  });

  it("refuses non-ASCII once the runner refused the connection and axe would have to type it", async () => {
    const b = fakeBackend({ method: "inputText", kind: "refused" });
    const { d, axe, marks } = setup({ backend: b.backend });
    await expect(d.typeText("U", "привет")).rejects.toThrow(/cannot type non-ASCII characters/);
    expect(marks).toEqual(["dead ios U connect ECONNREFUSED 127.0.0.1:52000"]);
    expect(axe()).toEqual([]);
  });

  it("refuses a transliterating host layout while the runner is not ready", async () => {
    const { d, axe } = setup({ view: STARTING, layout: async () => "com.apple.keylayout.RussianWin" });
    await expect(d.typeText("U", "cat")).rejects.toThrow(/RussianWin/);
    expect(axe()).toEqual([]);
  });
});

describe("IosDriver.rawLayout through the runner", () => {
  const EMPTY = { axElement: { elementType: 2, frame: { X: 0, Y: 0, Width: 402, Height: 874 }, children: [] }, depth: 1 };

  it("ok → runner elements, no axe", async () => {
    const b = fakeBackend();
    const { d, axe } = setup({ backend: b.backend });
    const { els, os } = await d.rawLayout("U");
    expect(os).toEqual({ path: "runner" });
    expect(els.find((e) => e.text === "Allow")).toMatchObject({ type: "Button", x: 57, y: 577.6666666666667 });
    expect(axe()).toEqual([]);
  });

  it("a hierarchy with no elements falls back once, noted", async () => {
    const b = fakeBackend(undefined, EMPTY);
    const { d, axe, marks } = setup({ backend: b.backend });
    const { els, os } = await d.rawLayout("U");
    expect(os).toEqual({ path: "axe", reason: "runner hierarchy empty" });
    expect(els.map((e) => e.text)).toEqual(["Axe button"]);
    expect(axe()).toEqual(["axe describe-ui --udid U"]);
    expect(marks).toEqual([]);
    expect(b.calls).toEqual(["hierarchy", "hierarchy"]);
  });

  it("empty once (alert just dismissed) → retried on the runner, no axe", async () => {
    const b = fakeBackend();
    const trees = [EMPTY, ATT];
    (b.backend as { hierarchy: () => Promise<unknown> }).hierarchy = async () => trees.shift();
    const { d, axe } = setup({ backend: b.backend });
    const { els, os } = await d.rawLayout("U");
    expect(os).toEqual({ path: "runner" });
    expect(els.length).toBeGreaterThan(0);
    expect(axe()).toEqual([]);
  });

  it.each([
    ["refused", "runner dead: connect ECONNREFUSED 127.0.0.1:52000", ["dead ios U connect ECONNREFUSED 127.0.0.1:52000"]],
    ["lost", "runner dead: socket hang up", ["dead ios U socket hang up"]],
    ["unsupported", "unsupported: XCPointerEventPath", ["failed ios U unsupported: XCPointerEventPath"]],
    ["rejected", "runner rejected: invalid coordinates", []],
  ] as const)("%s → axe once, reason noted", async (kind, reason, wantMarks) => {
    const b = fakeBackend({ method: "hierarchy", kind });
    const { d, axe, marks } = setup({ backend: b.backend });
    const { els, os } = await d.rawLayout("U");
    expect(os).toEqual({ path: "axe", reason });
    expect(els.map((e) => e.text)).toEqual(["Axe button"]);
    expect(axe()).toEqual(["axe describe-ui --udid U"]);
    expect(marks).toEqual(wantMarks);
  });

  it.each([
    ["starting", STARTING, { path: "axe", reason: "runner starting" }],
    ["failed", FAILED, { path: "axe", reason: "runner failed: simctl launch: no /status after 20000ms" }],
    ["off", DISABLED, { path: "axe" }],
  ] as const)("not ready (%s) → axe", async (_l, view, os) => {
    const { d, axe } = setup({ view });
    expect((await d.rawLayout("U")).os).toEqual(os);
    expect(axe()).toEqual(["axe describe-ui --udid U"]);
  });

  it("clips to the simulator's screen size when the hierarchy carries no Application or Window", async () => {
    const typeId = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
    const extra = {
      "simctl list devices --json": JSON.stringify({
        devices: { r: [{ udid: "VP-1", name: "iPhone 17 Pro", state: "Booted", deviceTypeIdentifier: typeId }] },
      }),
      "simctl list devicetypes --json": JSON.stringify({ devicetypes: [{ identifier: typeId, bundlePath: "/x.simdevicetype" }] }),
      "plutil -convert json": JSON.stringify({ mainScreenScale: 3, mainScreenWidth: 1206, mainScreenHeight: 2622 }),
    };
    const bare = { axElement: { elementType: 0, children: [{ elementType: 9, label: "Far", frame: { X: 0, Y: 2000, Width: 50, Height: 20 } }] }, depth: 2 };
    const b = fakeBackend(undefined, bare);
    const { d } = setup({ backend: b.backend, extra });
    const { els, os } = await d.rawLayout("VP-1");
    expect(os).toEqual({ path: "runner" });
    expect(els[0]).toMatchObject({ text: "Far", offscreen: true });
  });
});

describe("IosDriver.screenshotPng through the runner", () => {
  it("ok → the runner's PNG, no simctl", async () => {
    const b = fakeBackend();
    const { d, calls } = setup({ backend: b.backend });
    expect(await d.screenshotPng("U")).toBe(PNG_RUNNER);
    expect(calls).toEqual([]);
  });

  it.each([
    ["refused", ["dead ios U connect ECONNREFUSED 127.0.0.1:52000"]],
    ["lost", ["dead ios U socket hang up"]],
    ["unsupported", ["failed ios U unsupported: XCPointerEventPath"]],
    ["rejected", []],
  ] as const)("%s → simctl, silently", async (kind, wantMarks) => {
    const b = fakeBackend({ method: "screenshot", kind });
    const { d, calls, marks } = setup({ backend: b.backend });
    expect(await d.screenshotPng("U")).toBe(PNG_SIMCTL);
    expect(calls).toEqual(["xcrun simctl io U screenshot --type=png -"]);
    expect(marks).toEqual(wantMarks);
  });

  it.each([["starting", STARTING], ["failed", FAILED], ["off", DISABLED]] as const)("not ready (%s) → simctl", async (_l, view) => {
    const { d, calls } = setup({ view });
    expect(await d.screenshotPng("U")).toBe(PNG_SIMCTL);
    expect(calls).toEqual(["xcrun simctl io U screenshot --type=png -"]);
  });
});

describe("fallbackReason", () => {
  it("is the pool's notReadyReason, except silent when the user switched the runner off", () => {
    expect(fallbackReason(undefined)).toBe("runner starting");
    expect(fallbackReason(STARTING)).toBe("runner starting");
    expect(fallbackReason(FAILED)).toBe("runner failed: simctl launch: no /status after 20000ms");
    expect(fallbackReason(DEAD)).toBe("runner dead: connect ECONNREFUSED 127.0.0.1:52000");
    expect(fallbackReason(DISABLED)).toBeUndefined();
  });
});

describe("IosDriver runner coordinates", () => {
  it("RF-4: tap coordinates reach the runner unchanged (its frames are already screen-oriented, e.g. landscape)", async () => {
    const { backend, calls } = fakeBackend();
    const { d } = setup({ backend });
    await d.tapXY("SIM-1", 800.5, 120.25);
    expect(calls).toEqual(["touch 800.5 120.25"]);
  });
});
