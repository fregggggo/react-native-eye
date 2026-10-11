import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registerScreenshotTools,
  MAX_IMAGE_DIMENSION_PX,
  MAX_IMAGE_BASE64_BYTES,
  __resetDownscalerAvailabilityForTests,
} from "../../src/tools/screenshot.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, type FakeMetro } from "../helpers/fakeCdp.js";
import type { DeviceDriver } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";

let metro: FakeMetro;
beforeEach(() => {
  getRegistry().reset();
  __resetDownscalerAvailabilityForTests();
});
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

function makePngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

async function writeFakeOutput(path: string, data: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, Buffer.from(data));
}

const driver = {
  platform: "ios",
  listDevices: async () => [{ platform: "ios", udid: "u", name: "n", booted: true }],
  screenshotPng: async () => Buffer.from("PNGDATA"),
  screenshotFile: async () => {},
  rawLayout: async () => axeLayout([]),
  tapXY: async () => AXE,
  swipe: async () => AXE,
  typeText: async () => AXE,
  pressKey: async () => AXE,
  launchApp: async () => {},
  installApp: async () => {},
  recordStart: async () => ({ finalize: async () => {} }),
} as unknown as DeviceDriver;

async function connect() {
  metro = await startFakeMetro({ port: 0 });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", () => ({ result: { value: undefined } }));
  await getRegistry().connect({ port: metro.port });
}

describe("screenshot", () => {
  it("returns a base64 PNG image with full_res", async () => {
    await connect();
    const server = makeServer();
    registerScreenshotTools(server, { drivers: [driver] });
    const res = await callTool(server, "screenshot", { full_res: true });
    expect(res.content[0].type).toBe("image");
    expect(res.content[0].mimeType).toBe("image/png");
    expect(Buffer.from(res.content[0].data, "base64").toString()).toBe("PNGDATA");
  });

  it("compresses inline screenshots to jpeg via sips", async () => {
    await connect();
    const sipsCalls: string[][] = [];
    const runner = (async (cmd: string, args: string[]) => {
      sipsCalls.push([cmd, ...args]);
      const outIdx = args.indexOf("--out");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(args[outIdx + 1], Buffer.from("JPGDATA"));
      return { stdout: "", stdoutBuffer: Buffer.from(""), stderr: "" };
    }) as any;
    const server = makeServer();
    registerScreenshotTools(server, { drivers: [driver], runner });
    const res = await callTool(server, "screenshot", {});
    expect(sipsCalls[0][0]).toBe("sips");
    expect(sipsCalls[0]).toContain("--resampleWidth");
    expect(res.content[0].mimeType).toBe("image/jpeg");
    expect(Buffer.from(res.content[0].data, "base64").toString()).toBe("JPGDATA");
  });

  it("falls back to the original png when sips fails", async () => {
    await connect();
    const runner = (async () => {
      throw new Error("no sips");
    }) as any;
    const server = makeServer();
    registerScreenshotTools(server, { drivers: [driver], runner });
    const res = await callTool(server, "screenshot", {});
    expect(res.content[0].mimeType).toBe("image/png");
    expect(Buffer.from(res.content[0].data, "base64").toString()).toBe("PNGDATA");
  });

  it("with output_path returns the path as text instead of an image", async () => {
    await connect();
    const saved: any[] = [];
    (driver as any).screenshotFile = async (_u: string, p: string, o: any) => {
      saved.push([p, o.format]);
    };
    const server = makeServer();
    registerScreenshotTools(server, { drivers: [driver] });
    const res = await callTool(server, "screenshot", { output_path: "/tmp/x.png" });
    expect(saved[0]).toEqual(["/tmp/x.png", "png"]);
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("/tmp/x.png");
  });

  it("rejects mask on an android target", async () => {
    await connect();
    const android = { ...driver, platform: "android" } as unknown as DeviceDriver;
    const server = makeServer();
    registerScreenshotTools(server, { drivers: [android] });
    const res = await callTool(server, "screenshot", { output_path: "/tmp/x.png", mask: "black" });
    expect(res.isError).toBe(true);
  });

  it("falls back to the next downscaler in the chain when sips fails", async () => {
    await connect();
    const calls: string[] = [];
    const runner = (async (cmd: string, args: string[]) => {
      calls.push(cmd);
      if (cmd === "sips") throw new Error("sips exploded");
      if (cmd === "magick") {
        await writeFakeOutput(args[args.length - 1], "MAGICKDATA");
        return { stdout: "", stdoutBuffer: Buffer.from(""), stderr: "" };
      }
      throw new Error(`unexpected cmd ${cmd}`);
    }) as any;
    const server = makeServer();
    registerScreenshotTools(server, { drivers: [driver], runner });
    const res = await callTool(server, "screenshot", {});
    expect(calls).toEqual(["sips", "magick"]);
    expect(res.content[0].mimeType).toBe("image/jpeg");
    expect(Buffer.from(res.content[0].data, "base64").toString()).toBe("MAGICKDATA");
  });

  it("falls back to the raw png when every downscaler is missing", async () => {
    await connect();
    const calls: string[] = [];
    const runner = (async (cmd: string) => {
      calls.push(cmd);
      throw new Error(`${cmd} not found`);
    }) as any;
    const server = makeServer();
    registerScreenshotTools(server, { drivers: [driver], runner });
    const res = await callTool(server, "screenshot", {});
    expect(calls).toEqual(["sips", "magick", "convert", "ffmpeg"]);
    expect(res.content[0].mimeType).toBe("image/png");
    expect(Buffer.from(res.content[0].data, "base64").toString()).toBe("PNGDATA");
  });

  it("does not re-probe a known-missing downscaler within the same process", async () => {
    await connect();
    const calls: string[] = [];
    const runner = (async (cmd: string) => {
      calls.push(cmd);
      throw new Error(`${cmd} not found`);
    }) as any;
    const server = makeServer();
    registerScreenshotTools(server, { drivers: [driver], runner });
    await callTool(server, "screenshot", {});
    calls.length = 0;
    await callTool(server, "screenshot", {});
    expect(calls).toEqual([]);
  });

  it("skips sips without spawning on non-macOS hosts", async () => {
    await connect();
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    __resetDownscalerAvailabilityForTests();
    try {
      const calls: string[] = [];
      const runner = (async (cmd: string, args: string[]) => {
        calls.push(cmd);
        if (cmd === "magick") {
          await writeFakeOutput(args[args.length - 1], "MAGICKDATA");
          return { stdout: "", stdoutBuffer: Buffer.from(""), stderr: "" };
        }
        throw new Error(`unexpected cmd ${cmd}`);
      }) as any;
      const server = makeServer();
      registerScreenshotTools(server, { drivers: [driver], runner });
      const res = await callTool(server, "screenshot", {});
      expect(calls).toEqual(["magick"]);
      expect(res.content[0].mimeType).toBe("image/jpeg");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
      __resetDownscalerAvailabilityForTests();
    }
  });

  it("raises an actionable error when the screenshot exceeds the byte ceiling", async () => {
    await connect();
    const bigDriver = {
      ...driver,
      screenshotPng: async () => Buffer.alloc(MAX_IMAGE_BASE64_BYTES),
    } as unknown as DeviceDriver;
    const runner = (async () => {
      throw new Error("no compressors available");
    }) as any;
    const server = makeServer();
    registerScreenshotTools(server, { drivers: [bigDriver], runner });
    const res = await callTool(server, "screenshot", {});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("output_path");
  });

  it("respects the byte ceiling for full_res too", async () => {
    await connect();
    const bigDriver = {
      ...driver,
      screenshotPng: async () => Buffer.alloc(MAX_IMAGE_BASE64_BYTES),
    } as unknown as DeviceDriver;
    const server = makeServer();
    registerScreenshotTools(server, { drivers: [bigDriver] });
    const res = await callTool(server, "screenshot", { full_res: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("full_res");
  });

  it("rejects a screenshot over the pixel-dimension ceiling", async () => {
    await connect();
    const hugeDriver = {
      ...driver,
      screenshotPng: async () => makePngHeader(MAX_IMAGE_DIMENSION_PX + 1, 100),
    } as unknown as DeviceDriver;
    const server = makeServer();
    registerScreenshotTools(server, { drivers: [hugeDriver] });
    const res = await callTool(server, "screenshot", { full_res: true });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain(`${MAX_IMAGE_DIMENSION_PX}px`);
  });
});
