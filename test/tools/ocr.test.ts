import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerOcrTools, markInTree, readingOrder } from "../../src/tools/ocr.js";
import { getRegistry } from "../../src/core/registry.js";
import { DriverError } from "../../src/core/errors.js";
import { toElements } from "../../src/layout/elements.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, evalEnvelope, type FakeMetro } from "../helpers/fakeCdp.js";
import type { DeviceDriver } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";
import type { OcrBackend, OcrResult } from "../../src/ocr/backend.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

// Pixels at scale 3 → "Sign in" @187,412 (100,400 174x24), "Forgot password?" @200,470 (80,460 240x20).
const RESULT: OcrResult = {
  width: 1206,
  height: 2622,
  backend: "vision",
  lines: [
    { text: "Sign in", x: 300, y: 1200, w: 522, h: 72, confidence: 0.95 },
    { text: "Forgot password?", x: 240, y: 1380, w: 720, h: 60, confidence: 0.42 },
  ],
};

function fakeOcr(res: OcrResult = RESULT) {
  const seen: { languages?: string[] }[] = [];
  const backend: OcrBackend = {
    name: "vision",
    recognize: async (_path, opts) => {
      seen.push(opts ?? {});
      return res;
    },
  };
  return { backend, seen };
}

function failingOcr(err: Error): OcrBackend {
  return {
    name: "vision",
    recognize: async () => {
      throw err;
    },
  };
}

function ios(extra?: Partial<DeviceDriver>): DeviceDriver {
  return {
    platform: "ios",
    listDevices: async () => [{ platform: "ios", udid: "u", name: "n", booted: true }],
    screenshotPng: async () => Buffer.from("PNG"),
    rawLayout: async () => axeLayout([]),
    tapXY: async () => AXE,
    swipe: async () => AXE,
    typeText: async () => AXE,
    pressKey: async () => AXE,
    launchApp: async () => {},
    screenScale: async () => 3,
    ...extra,
  } as unknown as DeviceDriver;
}

let layoutEvaluations = 0;
async function connectWithJsLayout(result: unknown) {
  metro = await startFakeMetro({ port: 0 });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", (p) => {
    if (String(p.expression).includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) {
      layoutEvaluations++;
      return evalEnvelope(JSON.stringify(result));
    }
    return evalEnvelope(undefined);
  });
  await getRegistry().connect({ port: metro.port });
  layoutEvaluations = 0;
}

const TREE = {
  available: true,
  viewport: { x: 0, y: 0, w: 402, h: 874 },
  els: [{ text: "Sign in", type: "RCTText", x: 80, y: 395, w: 220, h: 40 }],
};

async function read(server: ReturnType<typeof makeServer>, args: any = {}) {
  const res = await callTool(server, "read_screen_text", args);
  return { res, text: res.content[0].text as string };
}

describe("read_screen_text", () => {
  it("lists recognized lines with centre coordinates in tap units", async () => {
    const server = makeServer();
    registerOcrTools(server, { drivers: [ios()], ocr: fakeOcr().backend });
    const { res, text } = await read(server);
    expect(res.isError).toBeFalsy();
    expect(text).toContain("Sign in @187,412\n");
    expect(text).toContain("Forgot password? @200,470 (low confidence)");
    expect(text).toContain("(ocr: vision — 2 lines; scale 3 px/pt; ");
    expect(text).toContain("tree comparison skipped: no Metro connection");
    expect(text).not.toContain("[tree]");
  });

  it("filters lines with search, case-insensitively, without changing the total", async () => {
    const server = makeServer();
    registerOcrTools(server, { drivers: [ios()], ocr: fakeOcr().backend });
    const { text } = await read(server, { search: ["FORGOT"] });
    expect(text).toContain("Forgot password?");
    expect(text).not.toContain("Sign in");
    expect(text).toContain("2 lines");
    const none = await read(server, { search: ["nope"] });
    expect(none.text).toContain('(no text matching "nope")');
  });

  it("marks lines that overlap a matching JS-tree element with [tree]", async () => {
    await connectWithJsLayout(TREE);
    const server = makeServer();
    registerOcrTools(server, { drivers: [ios()], ocr: fakeOcr().backend });
    const { text } = await read(server);
    expect(text).toContain("Sign in @187,412 [tree]");
    expect(text).toContain("Forgot password? @200,470 (low confidence)\n");
    expect(text).toContain("2 lines, 1 in tree");
    expect(text).not.toContain("tree comparison skipped");
  });

  it("does not mark a text match whose box is elsewhere on screen", async () => {
    await connectWithJsLayout({ ...TREE, els: [{ ...TREE.els[0], y: 700 }] });
    const server = makeServer();
    registerOcrTools(server, { drivers: [ios()], ocr: fakeOcr().backend });
    const { text } = await read(server);
    expect(text).not.toContain("[tree]");
    expect(text).toContain("0 in tree");
  });

  it("compare_tree:false skips the layout capture entirely", async () => {
    await connectWithJsLayout(TREE);
    const server = makeServer();
    registerOcrTools(server, { drivers: [ios()], ocr: fakeOcr().backend });
    const { text } = await read(server, { compare_tree: false });
    expect(layoutEvaluations).toBe(0);
    expect(text).not.toContain("in tree");
    expect(text).not.toContain("[tree]");
  });

  it("reports a JS layout failure as a note instead of failing the call", async () => {
    await connectWithJsLayout({ available: false, error: "walked 0 fibers" });
    const server = makeServer();
    registerOcrTools(server, { drivers: [ios()], ocr: fakeOcr().backend });
    const { res, text } = await read(server);
    expect(res.isError).toBeFalsy();
    expect(text).toContain("Sign in @187,412");
    expect(text).toContain("tree comparison skipped: JS layout unavailable: walked 0 fibers");
  });

  it("says so when nothing was recognized", async () => {
    const server = makeServer();
    registerOcrTools(server, { drivers: [ios()], ocr: fakeOcr({ ...RESULT, lines: [] }).backend });
    const { text } = await read(server);
    expect(text).toContain("(no text recognized)");
    expect(text).toContain("0 lines");
  });

  it("passes languages to the backend", async () => {
    const { backend, seen } = fakeOcr();
    const server = makeServer();
    registerOcrTools(server, { drivers: [ios()], ocr: backend });
    await read(server, { languages: ["de", "en"] });
    expect(seen[0].languages).toEqual(["de", "en"]);
  });

  it("turns a backend failure into a tool error", async () => {
    const server = makeServer();
    registerOcrTools(server, { drivers: [ios()], ocr: failingOcr(new DriverError("OCR helper failed to compile: boom")) });
    const { res, text } = await read(server);
    expect(res.isError).toBe(true);
    expect(text).toMatch(/^Driver error: OCR helper failed to compile/);
  });
});

describe("markInTree", () => {
  const line = { text: "Sign in", x: 100, y: 400, w: 174, h: 24, confidence: 1 };
  const el = (over: Record<string, unknown>) => toElements([{ text: "Sign in", x: 80, y: 395, w: 220, h: 40, ...over }]);

  it("matches substrings in either direction", () => {
    expect(markInTree([{ ...line, text: "Sign" }], el({}))).toEqual([true]);
    expect(markInTree([{ ...line, text: "sign in to continue" }], el({}))).toEqual([true]);
  });

  it("ignores hidden, off-screen and container elements", () => {
    expect(markInTree([line], el({ hidden: true }))).toEqual([false]);
    expect(markInTree([line], el({ offscreen: true }))).toEqual([false]);
    expect(markInTree([line], el({ container: true }))).toEqual([false]);
  });

  it("tests overlap against the visible part of the element", () => {
    expect(markInTree([line], el({ x: 0, y: 0, w: 1000, h: 1000, visible: { x: 900, y: 900, w: 50, h: 50 } }))).toEqual([
      false,
    ]);
  });
});

describe("readingOrder", () => {
  it("sorts rows top to bottom and each row left to right", () => {
    const B = { text: "B", x: 200, y: 100, w: 20, h: 20, confidence: 1 };
    const A = { text: "A", x: 10, y: 105, w: 20, h: 20, confidence: 1 };
    const C = { text: "C", x: 10, y: 300, w: 20, h: 20, confidence: 1 };
    expect(readingOrder([C, B, A]).map((l) => l.text)).toEqual(["A", "B", "C"]);
  });
});
