import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRecordingTools, resetRecordingState, stopActiveRecording } from "../../src/tools/recording.js";
import { installShutdownHooks } from "../../src/core/shutdown.js";
import { IosDriver } from "../../src/drivers/ios.js";
import { spawnLongRunning } from "../../src/core/exec.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import type { DeviceDriver, RecordingHandle } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";

let dir: string;
beforeEach(() => {
  resetRecordingState();
  dir = mkdtempSync(join(tmpdir(), "rne-rec-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A recorder whose finalize writes the file, as simctl / adb pull do. */
function fakeDriver(handle?: (path: string) => RecordingHandle): { driver: DeviceDriver; finalized: () => boolean } {
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
    recordStart: async (_u: string, path: string) =>
      handle?.(path) ?? {
        finalize: async () => {
          fin = true;
          writeFileSync(path, "movie");
        },
      },
  } as unknown as DeviceDriver;
  return { driver, finalized: () => fin };
}

describe("record_video / stop_recording", () => {
  it("starts, refuses a second start, stops and reports the path", async () => {
    const { driver, finalized } = fakeDriver();
    const server = makeServer();
    registerRecordingTools(server, { drivers: [driver] });
    const out = join(dir, "rec.mp4");

    const start = await callTool(server, "record_video", { output_path: out });
    expect(start.content[0].text).toContain(out);

    const dup = await callTool(server, "record_video", {});
    expect(dup.isError).toBe(true);
    expect(dup.content[0].text).toContain(out);

    const stop = await callTool(server, "stop_recording", {});
    expect(finalized()).toBe(true);
    expect(stop.isError).toBeFalsy();
    expect(stop.content[0].text).toContain(out);
  });

  it("stop without an active recording errors", async () => {
    const { driver } = fakeDriver();
    const server = makeServer();
    registerRecordingTools(server, { drivers: [driver] });
    const res = await callTool(server, "stop_recording", {});
    expect(res.isError).toBe(true);
  });

  it("defaults the output path to RNE_OUTPUT_DIR", async () => {
    process.env.RNE_OUTPUT_DIR = join(dir, "out");
    try {
      const { driver } = fakeDriver();
      const server = makeServer();
      registerRecordingTools(server, { drivers: [driver] });
      const res = await callTool(server, "record_video", {});
      expect(res.content[0].text).toContain(join(dir, "out", "rne-recording-"));
    } finally {
      delete process.env.RNE_OUTPUT_DIR;
    }
  });

  it("creates a missing output directory instead of letting the recorder die on it", async () => {
    const seen: string[] = [];
    const { driver } = fakeDriver((path) => {
      seen.push(path);
      return { finalize: async () => writeFileSync(path, "movie") };
    });
    const server = makeServer();
    registerRecordingTools(server, { drivers: [driver] });
    const out = join(dir, "a", "b", "clip.mp4");
    const res = await callTool(server, "record_video", { output_path: out });
    expect(res.isError).toBeFalsy();
    expect(existsSync(join(dir, "a", "b"))).toBe(true);
    expect(seen).toEqual([out]);
  });

  it("reports an error, not success, when stopping wrote no file", async () => {
    const { driver } = fakeDriver(() => ({ finalize: async () => {} }));
    const server = makeServer();
    registerRecordingTools(server, { drivers: [driver] });
    await callTool(server, "record_video", { output_path: join(dir, "none.mp4") });
    const stop = await callTool(server, "stop_recording", {});
    expect(stop.isError).toBe(true);
    expect(stop.content[0].text).toMatch(/no file was written/);
  });

  it("keeps a recording whose recorder still runs after a failed stop, so the stop can be retried", async () => {
    let tries = 0;
    const { driver } = fakeDriver((path) => ({
      running: () => true,
      finalize: async () => {
        if (++tries === 1) throw new Error("transient");
        writeFileSync(path, "movie");
      },
    }));
    const server = makeServer();
    registerRecordingTools(server, { drivers: [driver] });
    await callTool(server, "record_video", { output_path: join(dir, "r.mp4") });
    expect((await callTool(server, "stop_recording", {})).isError).toBe(true);
    const retry = await callTool(server, "stop_recording", {});
    expect(retry.isError).toBeFalsy();
    expect(retry.content[0].text).toContain("r.mp4");
  });
});

describe("a recorder that dies after it started (review #1)", () => {
  // Stands in for `xcrun simctl io <udid> recordVideo …` that fails about a
  // second in — a device that went away, a path simctl cannot write.
  const dyingSimctl = () =>
    spawnLongRunning("sh", ["-c", "sleep 0.3; echo 'Recording started' >&2; sleep 0.4; echo 'Error: recording failed' >&2; exit 1"]);
  const fakeRun = async (_cmd: string, args: string[]) => {
    if (args[0] === "simctl" && args[1] === "list") {
      const stdout = JSON.stringify({ devices: { rt: [{ udid: "U1", name: "iPhone X", state: "Booted", isAvailable: true }] } });
      return { stdout, stdoutBuffer: Buffer.from(stdout), stderr: "" };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };
  const noPool = { get: () => undefined, view: () => undefined, markDead() {}, markFailed() {} };

  it("does not wedge record_video and stop_recording, and reports the recorder's own stderr", async () => {
    const driver = new IosDriver(fakeRun as any, dyingSimctl as any, async () => undefined, noPool as any);
    const server = makeServer();
    registerRecordingTools(server, { drivers: [driver] });

    const start = await callTool(server, "record_video", { output_path: join(dir, "x.mp4") });
    expect(start.isError).toBeFalsy();
    await new Promise((r) => setTimeout(r, 900));

    const stop = await callTool(server, "stop_recording", {});
    expect(stop.isError).toBe(true);
    expect(stop.content[0].text).toContain("Error: recording failed");

    // The dead recording is gone: nothing to stop, and a new one may start.
    expect((await callTool(server, "stop_recording", {})).content[0].text).toMatch(/No recording in progress/);
    const again = await callTool(server, "record_video", { output_path: join(dir, "y.mp4") });
    expect(again.content[0].text).not.toMatch(/already in progress/);
    await stopActiveRecording();
  }, 10000);

  it("refuses a recording that fails before simctl ever says it started", async () => {
    const neverStarts = () => spawnLongRunning("sh", ["-c", "sleep 0.7; echo 'Invalid device: U1' >&2; exit 164"]);
    const driver = new IosDriver(fakeRun as any, neverStarts as any, async () => undefined, noPool as any);
    const server = makeServer();
    registerRecordingTools(server, { drivers: [driver] });
    const start = await callTool(server, "record_video", { output_path: join(dir, "x.mp4") });
    expect(start.isError).toBe(true);
    expect(start.content[0].text).toContain("Invalid device");
    expect((await callTool(server, "stop_recording", {})).content[0].text).toMatch(/No recording in progress/);
  });

  it("record_video replaces a recording whose recorder had already exited, saying so", async () => {
    let alive = true;
    const { driver } = fakeDriver((path) => ({ running: () => alive, finalize: async () => writeFileSync(path, "m") }));
    const server = makeServer();
    registerRecordingTools(server, { drivers: [driver] });
    await callTool(server, "record_video", { output_path: join(dir, "first.mp4") });
    alive = false;
    const second = await callTool(server, "record_video", { output_path: join(dir, "second.mp4") });
    expect(second.isError).toBeFalsy();
    expect(second.content[0].text).toContain("second.mp4");
    expect(second.content[0].text).toMatch(/first\.mp4 had already stopped on its own/);
  });
});

describe("session shutdown with a recording in progress (review #2)", () => {
  it("ends the recording (finalize) before the process exits", async () => {
    const { driver, finalized } = fakeDriver();
    const server = makeServer();
    registerRecordingTools(server, { drivers: [driver] });
    await callTool(server, "record_video", { output_path: join(dir, "s.mp4") });

    const handlers: Record<string, () => void> = {};
    let exitCode: number | undefined;
    const proc = {
      on: (ev: string, fn: () => void) => (handlers[ev] = fn),
      exit: (code: number) => (exitCode = code),
      stdin: { on: (ev: string, fn: () => void) => (handlers[`stdin:${ev}`] = fn) },
    };
    const hooks = installShutdownHooks({ pool: { shutdown: async () => {} }, proc, graceMs: 500, log: () => {} });
    await hooks.shutdown("stdin closed", 0);
    expect(finalized()).toBe(true);
    expect(exitCode).toBe(0);
    expect(existsSync(join(dir, "s.mp4"))).toBe(true);
    expect((await callTool(server, "stop_recording", {})).content[0].text).toMatch(/No recording in progress/);
  });

  it("stops a real child recorder with SIGINT", async () => {
    // The recorder exits 0 on SIGINT, as simctl does after writing the movie.
    const recorder = () =>
      spawnLongRunning("sh", ["-c", "trap 'echo finalized >&2; exit 0' INT; echo 'Recording started' >&2; while :; do sleep 0.1; done"]);
    const fakeRun = async () => {
      const stdout = JSON.stringify({ devices: { rt: [{ udid: "U1", name: "iPhone X", state: "Booted" }] } });
      return { stdout, stdoutBuffer: Buffer.from(stdout), stderr: "" };
    };
    const noPool = { get: () => undefined, view: () => undefined, markDead() {}, markFailed() {} };
    let spawned: ReturnType<typeof spawnLongRunning> | undefined;
    const driver = new IosDriver(fakeRun as any, ((...a: any[]) => (spawned = (recorder as any)(...a))) as any, async () => undefined, noPool as any);
    const server = makeServer();
    registerRecordingTools(server, { drivers: [driver] });
    await callTool(server, "record_video", { output_path: join(dir, "c.mp4") });
    expect(spawned!.exited()).toBe(false);
    await stopActiveRecording();
    expect(spawned!.exited()).toBe(true);
    expect(spawned!.stderr()).toContain("finalized");
  });
});
