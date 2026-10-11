import { describe, it, expect, beforeEach } from "vitest";
import { registerRecordingTools, resetRecordingState } from "../../src/tools/recording.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import type { DeviceDriver } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";

function fakeDriver(): { driver: DeviceDriver; finalized: () => boolean } {
  let fin = false;
  const driver = {
    platform: "ios",
    listDevices: async () => [{ platform: "ios", udid: "u", name: "n", booted: true }],
    screenshotPng: async () => Buffer.from(""),
    screenshotFile: async () => {},
    rawLayout: async () => axeLayout([]),
    tapXY: async () => AXE,
    swipe: async () => AXE,
    typeText: async () => AXE,
    pressKey: async () => AXE,
    launchApp: async () => {},
    installApp: async () => {},
    recordStart: async () => ({
      finalize: async () => {
        fin = true;
      },
    }),
  } as unknown as DeviceDriver;
  return { driver, finalized: () => fin };
}

describe("record_video / stop_recording", () => {
  beforeEach(() => resetRecordingState());

  it("starts, refuses a second start, stops and reports the path", async () => {
    const { driver, finalized } = fakeDriver();
    const server = makeServer();
    registerRecordingTools(server, { drivers: [driver] });

    const start = await callTool(server, "record_video", { output_path: "/tmp/rec.mp4" });
    expect(start.content[0].text).toContain("/tmp/rec.mp4");

    const dup = await callTool(server, "record_video", {});
    expect(dup.isError).toBe(true);
    expect(dup.content[0].text).toContain("/tmp/rec.mp4");

    const stop = await callTool(server, "stop_recording", {});
    expect(finalized()).toBe(true);
    expect(stop.content[0].text).toContain("/tmp/rec.mp4");
  });

  it("stop without an active recording errors", async () => {
    const { driver } = fakeDriver();
    const server = makeServer();
    registerRecordingTools(server, { drivers: [driver] });
    const res = await callTool(server, "stop_recording", {});
    expect(res.isError).toBe(true);
  });

  it("defaults the output path to RNE_OUTPUT_DIR", async () => {
    process.env.RNE_OUTPUT_DIR = "/tmp/rne-out";
    try {
      const { driver } = fakeDriver();
      const server = makeServer();
      registerRecordingTools(server, { drivers: [driver] });
      const res = await callTool(server, "record_video", {});
      expect(res.content[0].text).toContain("/tmp/rne-out/rne-recording-");
    } finally {
      delete process.env.RNE_OUTPUT_DIR;
    }
  });
});
