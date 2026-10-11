import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { toTapUnits, recognizeScreen } from "../../src/ocr/recognize.js";
import type { OcrBackend, OcrResult } from "../../src/ocr/backend.js";
import type { DeviceDriver } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";

const PX = { text: "Sign in", x: 300, y: 1200, w: 522, h: 72, confidence: 0.95 };
const RESULT: OcrResult = { width: 1206, height: 2622, lines: [PX], backend: "vision" };

function driver(extra?: Partial<DeviceDriver>): DeviceDriver {
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
    ...extra,
  } as unknown as DeviceDriver;
}

function backend(o?: { result?: OcrResult; fail?: Error }) {
  const seen: { path?: string; existed?: boolean; opts?: { languages?: string[] } } = {};
  const b: OcrBackend = {
    name: "vision",
    recognize: async (path, opts) => {
      seen.path = path;
      seen.existed = existsSync(path);
      seen.opts = opts;
      if (o?.fail) throw o.fail;
      return o?.result ?? RESULT;
    },
  };
  return { backend: b, seen };
}

describe("toTapUnits", () => {
  it("divides every box by the scale and rounds", () => {
    expect(toTapUnits([PX], 3)[0]).toEqual({ ...PX, x: 100, y: 400, w: 174, h: 24 });
  });

  it("is the identity at scale 1", () => {
    expect(toTapUnits([PX], 1)[0]).toEqual(PX);
  });

  it("treats a non-positive scale as 1", () => {
    expect(toTapUnits([PX], 0)[0]).toEqual(PX);
  });
});

describe("recognizeScreen", () => {
  it("returns point coordinates on an iOS simulator with a known screen scale", async () => {
    const r = await recognizeScreen(driver({ screenScale: async () => 3 }), "u", { backend: backend().backend });
    expect(r.scale).toBe(3);
    expect(r.lines[0]).toMatchObject({ text: "Sign in", x: 100, y: 400, w: 174, h: 24 });
    expect(r.note).toBeUndefined();
    expect(r.width).toBe(1206);
    expect(r.backend).toBe("vision");
    expect(typeof r.ms).toBe("number");
  });

  it("keeps Android pixels as they are", async () => {
    const r = await recognizeScreen(driver({ platform: "android", screenScale: async () => 1 }), "u", {
      backend: backend().backend,
    });
    expect(r.scale).toBe(1);
    expect(r.lines[0]).toEqual(PX);
    expect(r.note).toBeUndefined();
  });

  it("derives the scale from the app viewport when the driver cannot tell", async () => {
    const conn = { evaluate: async () => JSON.stringify({ x: 0, y: 0, w: 402, h: 874 }) };
    const r = await recognizeScreen(driver(), "u", { backend: backend().backend, conn });
    expect(r.scale).toBe(3);
    expect(r.lines[0].x).toBe(100);
    expect(r.note).toMatch(/derived from the app viewport/);
  });

  it("falls back to pixels with a note when nothing knows the scale", async () => {
    const r = await recognizeScreen(driver(), "u", { backend: backend().backend });
    expect(r.scale).toBe(1);
    expect(r.lines[0]).toEqual(PX);
    expect(r.note).toMatch(/scale unknown/);
  });

  it("survives a failing screenScale probe", async () => {
    const r = await recognizeScreen(
      driver({
        screenScale: async () => {
          throw new Error("boom");
        },
      }),
      "u",
      { backend: backend().backend },
    );
    expect(r.scale).toBe(1);
  });

  it("hands the backend a real PNG file and removes it afterwards", async () => {
    const { backend: b, seen } = backend();
    await recognizeScreen(driver({ screenScale: async () => 3 }), "u", { backend: b });
    expect(seen.existed).toBe(true);
    expect(seen.path).toMatch(/rne-ocr-\d+-\d+\.png$/);
    expect(existsSync(seen.path!)).toBe(false);
  });

  it("removes the temp file even when the backend fails", async () => {
    const { backend: b, seen } = backend({ fail: new Error("helper exploded") });
    await expect(recognizeScreen(driver(), "u", { backend: b })).rejects.toThrow(/helper exploded/);
    expect(existsSync(seen.path!)).toBe(false);
  });

  it("passes languages to the backend", async () => {
    const { backend: b, seen } = backend();
    await recognizeScreen(driver({ screenScale: async () => 3 }), "u", { backend: b, languages: ["ru", "en"] });
    expect(seen.opts?.languages).toEqual(["ru", "en"]);
  });
});
