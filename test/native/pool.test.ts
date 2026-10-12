import { describe, it, expect, vi } from "vitest";
import { NativePool, sharedPool, notReadyReason } from "../../src/native/pool.js";
import type { RunnerHandle, StartOptions } from "../../src/native/iosRunner.js";
import type { NativeBackend } from "../../src/native/nativeBackend.js";
import type { AndroidServerHandle, AndroidStartOptions } from "../../src/native/androidServer.js";
import { DriverError } from "../../src/core/errors.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

function handle(port: number, via: RunnerHandle["via"] = "simctl"): RunnerHandle & { stop: ReturnType<typeof vi.fn> } {
  return { port, via, stop: vi.fn(async () => {}) };
}

function fakeBackend(port: number): NativeBackend & { port: number } {
  return { platform: "ios", port } as unknown as NativeBackend & { port: number };
}

function androidHandle(port: number, via: AndroidServerHandle["via"] = "instrument"): AndroidServerHandle & { stop: ReturnType<typeof vi.fn> } {
  return { port, serial: "emulator-5554", socket: "rneye-0123456789abcdef", via, stop: vi.fn(async () => {}) };
}

function makePool(
  opts: {
    startIos?: (udid: string, o: StartOptions) => Promise<RunnerHandle>;
    startAndroid?: (serial: string, o: AndroidStartOptions) => Promise<AndroidServerHandle>;
    releaseAndroid?: (serial: string) => Promise<void>;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  let t = 1_000_000;
  const startIos = vi.fn(opts.startIos ?? (async (_udid: string, _o: StartOptions) => handle(40001)));
  const startAndroid = vi.fn(opts.startAndroid ?? (async (_s: string, _o: AndroidStartOptions) => androidHandle(49424)));
  const makeIosBackend = vi.fn((port: number) => fakeBackend(port));
  const makeAndroidBackend = vi.fn((port: number, serial: string) => ({ platform: "android", port, serial }) as unknown as NativeBackend);
  const releaseAndroid = vi.fn(opts.releaseAndroid ?? (async (_s: string) => {}));
  const pool = new NativePool({
    startIos, makeIosBackend, startAndroid, makeAndroidBackend, releaseAndroid,
    now: () => t, env: opts.env ?? {}, retryAfterMs: 300_000,
  });
  return { pool, startIos, startAndroid, makeIosBackend, makeAndroidBackend, releaseAndroid, advance: (ms: number) => void (t += ms) };
}

describe("NativePool", () => {
  it("warm is single-flight: two concurrent warms start the runner once and share the result", async () => {
    const d = deferred<RunnerHandle>();
    const { pool, startIos } = makePool({ startIos: () => d.promise });
    const a = pool.warm("ios", "SIM-1");
    const b = pool.warm("ios", "SIM-1");
    expect(pool.view("ios", "SIM-1")).toEqual({ state: "starting" });
    d.resolve(handle(40001, "reused"));
    const [va, vb] = await Promise.all([a, b]);
    expect(startIos).toHaveBeenCalledTimes(1);
    expect(startIos).toHaveBeenCalledWith("SIM-1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(va).toEqual(vb);
    expect(va).toMatchObject({ state: "ready", via: "reused" });
  });

  it("passes the app to keep in front to the iOS start, and remembers it for a later re-warm", async () => {
    const { pool, startIos } = makePool();
    await pool.warm("ios", "SIM-1", { foreground: "com.example.app" });
    expect(startIos).toHaveBeenLastCalledWith("SIM-1", expect.objectContaining({ foreground: "com.example.app" }));
    const backend = pool.get("ios", "SIM-1")!;
    pool.markDead("ios", "SIM-1", "refused", backend);
    await pool.settled("ios", "SIM-1");
    expect(startIos).toHaveBeenCalledTimes(2);
    expect(startIos).toHaveBeenLastCalledWith("SIM-1", expect.objectContaining({ foreground: "com.example.app" }));
  });

  it("keys entries by platform and udid", async () => {
    const { pool, startIos } = makePool();
    await Promise.all([pool.warm("ios", "SIM-1"), pool.warm("ios", "SIM-2")]);
    expect(startIos).toHaveBeenCalledTimes(2);
  });

  it("warm on a ready entry does not start again", async () => {
    const { pool, startIos } = makePool();
    await pool.warm("ios", "SIM-1");
    await pool.warm("ios", "SIM-1");
    expect(startIos).toHaveBeenCalledTimes(1);
  });

  it("get() on an absent entry starts a warm in the background and returns undefined", async () => {
    const d = deferred<RunnerHandle>();
    const { pool, startIos } = makePool({ startIos: () => d.promise });
    expect(pool.get("ios", "SIM-1")).toBeUndefined();
    expect(startIos).toHaveBeenCalledTimes(1);
    expect(pool.view("ios", "SIM-1")?.state).toBe("starting");
    expect(pool.get("ios", "SIM-1")).toBeUndefined();
    expect(startIos).toHaveBeenCalledTimes(1);
    d.resolve(handle(40001));
    await flush();
    expect(pool.get("ios", "SIM-1")).toMatchObject({ port: 40001 });
  });

  it("ready: get() returns the backend built for the runner's port; view reports via and start time", async () => {
    const d = deferred<RunnerHandle>();
    const { pool, makeIosBackend, advance } = makePool({ startIos: () => d.promise });
    const p = pool.warm("ios", "SIM-1");
    advance(1234);
    d.resolve(handle(40007, "simctl"));
    expect(await p).toEqual({ state: "ready", via: "simctl", startedMs: 1234 });
    expect(makeIosBackend).toHaveBeenCalledWith(40007);
    expect(pool.get("ios", "SIM-1")).toBe(makeIosBackend.mock.results[0].value);
  });

  it("a failed start records the error message as the reason and does not retry inside the window", async () => {
    const { pool, startIos, advance } = makePool({
      startIos: async () => {
        throw new DriverError("iOS runner not built — manifest missing.", "Run scripts/build-drivers.sh.");
      },
    });
    const v = await pool.warm("ios", "SIM-1");
    expect(v).toEqual({ state: "failed", reason: "iOS runner not built — manifest missing. Run scripts/build-drivers.sh." });
    advance(299_999);
    expect(pool.get("ios", "SIM-1")).toBeUndefined();
    expect(await pool.warm("ios", "SIM-1")).toMatchObject({ state: "failed" });
    expect(startIos).toHaveBeenCalledTimes(1);
    advance(1);
    expect(pool.get("ios", "SIM-1")).toBeUndefined();
    expect(startIos).toHaveBeenCalledTimes(2);
  });

  it("markDead: state dead with the reason, backend withdrawn, re-warm in the background", async () => {
    const handles = [handle(40001), handle(40002)];
    const gate = deferred<void>();
    let n = 0;
    const { pool, startIos } = makePool({
      startIos: async () => {
        const h = handles[n++];
        if (n === 2) await gate.promise;
        return h;
      },
    });
    await pool.warm("ios", "SIM-1");
    const b1 = pool.get("ios", "SIM-1")!;
    expect(b1).toMatchObject({ port: 40001 });

    pool.markDead("ios", "SIM-1", "lost: POST /touch no answer within 5000ms", b1);
    expect(pool.view("ios", "SIM-1")).toEqual({ state: "dead", reason: "lost: POST /touch no answer within 5000ms" });
    expect(pool.get("ios", "SIM-1")).toBeUndefined();
    expect(startIos).toHaveBeenCalledTimes(2);

    gate.resolve();
    await flush();
    expect(pool.view("ios", "SIM-1")?.state).toBe("ready");
    expect(pool.get("ios", "SIM-1")).toMatchObject({ port: 40002 });
    expect(startIos).toHaveBeenCalledTimes(2);
  });

  it("I-1: two markDead calls from the same backend count as one death", async () => {
    const d = deferred<RunnerHandle>();
    let n = 0;
    const { pool, startIos } = makePool({ startIos: async () => (n++ === 0 ? handle(40001) : d.promise) });
    await pool.warm("ios", "SIM-1");
    const b1 = pool.get("ios", "SIM-1")!;
    // observe(): screenshot and layout both fail on the same dead runner.
    pool.markDead("ios", "SIM-1", "refused", b1);
    pool.markDead("ios", "SIM-1", "refused", b1);
    expect(pool.view("ios", "SIM-1")).toEqual({ state: "dead", reason: "refused" });
    expect(startIos).toHaveBeenCalledTimes(2);
    d.resolve(handle(40002));
    await flush();
    expect(pool.view("ios", "SIM-1")?.state).toBe("ready");
    expect(pool.get("ios", "SIM-1")).toMatchObject({ port: 40002 });
  });

  it("I-1: markDead from a replaced backend is ignored — the new runner is not stopped and no death is counted", async () => {
    const xc2 = handle(40002, "xcodebuild");
    let n = 0;
    const { pool, startIos, advance } = makePool({ startIos: async () => (n++ === 0 ? handle(40001) : xc2) });
    await pool.warm("ios", "SIM-1");
    const b1 = pool.get("ios", "SIM-1")!;
    pool.markDead("ios", "SIM-1", "refused", b1);
    await flush();
    await flush();
    const b2 = pool.get("ios", "SIM-1")!;
    expect(b2).toMatchObject({ port: 40002 });
    // Runner 1's death leaves the flap window; a call that started on runner 1 fails late.
    advance(61_000);
    pool.markDead("ios", "SIM-1", "lost", b1);
    pool.markFailed("ios", "SIM-1", "unsupported: X", b1);
    expect(xc2.stop).not.toHaveBeenCalled();
    expect(pool.view("ios", "SIM-1")).toMatchObject({ state: "ready", via: "xcodebuild" });
    expect(pool.get("ios", "SIM-1")).toBe(b2);
    // Runner 2's own death is its first within 60s: had the stale report
    // counted, this would trip the flap rule.
    pool.markDead("ios", "SIM-1", "refused", b2);
    expect(pool.view("ios", "SIM-1")?.state).toBe("dead");
    expect(xc2.stop).toHaveBeenCalledTimes(1);
    expect(startIos).toHaveBeenCalledTimes(3);
  });

  it("I-1: a stale markDead cannot pull a failed entry out of its retry window", async () => {
    const { pool, startIos, advance } = makePool();
    await pool.warm("ios", "SIM-1");
    const b1 = pool.get("ios", "SIM-1")!;
    pool.markDead("ios", "SIM-1", "refused", b1);
    await flush();
    await flush();
    const b2 = pool.get("ios", "SIM-1")!;
    advance(1_000);
    pool.markDead("ios", "SIM-1", "refused", b2);
    expect(pool.view("ios", "SIM-1")?.state).toBe("failed");
    pool.markDead("ios", "SIM-1", "refused", b2);
    pool.markDead("ios", "SIM-1", "refused", b1);
    await flush();
    expect(pool.view("ios", "SIM-1")?.state).toBe("failed");
    expect(startIos).toHaveBeenCalledTimes(2);
  });

  it("markDead stops an xcodebuild-launched runner before re-warming", async () => {
    const xc = handle(40001, "xcodebuild");
    let n = 0;
    const { pool } = makePool({ startIos: async () => (n++ === 0 ? xc : handle(40002)) });
    await pool.warm("ios", "SIM-1");
    pool.markDead("ios", "SIM-1", "lost", pool.get("ios", "SIM-1")!);
    expect(xc.stop).toHaveBeenCalledTimes(1);
    await flush();
  });

  it("markFailed: no retry until retryAfterMs has passed", async () => {
    const { pool, startIos, advance } = makePool();
    await pool.warm("ios", "SIM-1");
    pool.markFailed("ios", "SIM-1", "unsupported: XCPointerEventPath", pool.get("ios", "SIM-1")!);
    expect(pool.view("ios", "SIM-1")).toEqual({ state: "failed", reason: "unsupported: XCPointerEventPath" });
    expect(pool.get("ios", "SIM-1")).toBeUndefined();
    advance(299_999);
    expect(pool.get("ios", "SIM-1")).toBeUndefined();
    expect(startIos).toHaveBeenCalledTimes(1);
    advance(1);
    expect(pool.get("ios", "SIM-1")).toBeUndefined();
    expect(startIos).toHaveBeenCalledTimes(2);
    await flush();
    expect(pool.get("ios", "SIM-1")).toBeDefined();
  });

  it("markFailed with a backend that is not current (here: during a start) is ignored", async () => {
    const d = deferred<RunnerHandle>();
    const { pool, startIos } = makePool({ startIos: () => d.promise });
    const p = pool.warm("ios", "SIM-1");
    pool.markFailed("ios", "SIM-1", "unsupported: XCPointerEventPath", fakeBackend(39999));
    expect(pool.view("ios", "SIM-1")).toEqual({ state: "starting" });
    d.resolve(handle(40001));
    expect(await p).toMatchObject({ state: "ready" });
    expect(startIos).toHaveBeenCalledTimes(1);
  });

  it("M-2: markFailed stops an xcodebuild-launched runner and drops its handle", async () => {
    const xc = handle(40001, "xcodebuild");
    const { pool, advance } = makePool({ startIos: async () => xc });
    await pool.warm("ios", "SIM-1");
    pool.markFailed("ios", "SIM-1", "unsupported: XCPointerEventPath", pool.get("ios", "SIM-1")!);
    expect(xc.stop).toHaveBeenCalledTimes(1);
    // Dropped from the shutdown set too: shutdown does not stop it a second time.
    await pool.shutdown();
    expect(xc.stop).toHaveBeenCalledTimes(1);
    advance(300_000);
  });

  it("RNE_NATIVE_DRIVER=off: every warm fails as disabled, get() is undefined, nothing is started", async () => {
    const { pool, startIos } = makePool({ env: { RNE_NATIVE_DRIVER: "off" } });
    expect(await pool.warm("ios", "SIM-1")).toEqual({ state: "failed", reason: "disabled (RNE_NATIVE_DRIVER=off)" });
    expect(pool.get("ios", "SIM-1")).toBeUndefined();
    expect(await pool.warm("android", "emulator-5554")).toEqual({ state: "failed", reason: "disabled (RNE_NATIVE_DRIVER=off)" });
    expect(startIos).not.toHaveBeenCalled();
  });

  it("android: warms through startAndroid and builds the backend with port and serial", async () => {
    const { pool, startIos, startAndroid, makeAndroidBackend } = makePool();
    expect(await pool.warm("android", "emulator-5554")).toMatchObject({ state: "ready", via: "instrument" });
    expect(startAndroid).toHaveBeenCalledWith("emulator-5554", expect.objectContaining({ signal: expect.any(AbortSignal), onSpawn: expect.any(Function) }));
    expect(makeAndroidBackend).toHaveBeenCalledWith(49424, "emulator-5554");
    expect(pool.get("android", "emulator-5554")).toMatchObject({ platform: "android", port: 49424 });
    expect(startIos).not.toHaveBeenCalled();
  });

  it("android and ios entries for the same id are independent", async () => {
    const { pool, startIos, startAndroid } = makePool();
    await Promise.all([pool.warm("android", "X"), pool.warm("ios", "X")]);
    expect(startIos).toHaveBeenCalledTimes(1);
    expect(startAndroid).toHaveBeenCalledTimes(1);
  });

  it("I3: a failed android start releases any server left holding UiAutomation (not at shutdown, not on iOS)", async () => {
    const boom = async () => {
      throw new DriverError("Installing the RNEye Android server failed: INSTALL_FAILED_USER_RESTRICTED");
    };
    const { pool, releaseAndroid } = makePool({ startAndroid: boom, startIos: boom });
    await pool.warm("android", "S");
    expect(releaseAndroid.mock.calls).toEqual([["S"]]);
    await pool.warm("ios", "SIM-1");
    expect(releaseAndroid).toHaveBeenCalledTimes(1);

    const d = deferred<AndroidServerHandle>();
    const late = makePool({ startAndroid: () => d.promise });
    const w = late.pool.warm("android", "T");
    await late.pool.shutdown();
    d.reject(new DriverError("Android server start on T aborted: the session is shutting down."));
    await w;
    expect(late.releaseAndroid).not.toHaveBeenCalled();
  });

  it("android: a failed start is failed with the lifecycle's message and retried only after the window", async () => {
    const { pool, startAndroid, advance } = makePool({
      startAndroid: async () => {
        throw new DriverError("Android server did not start on S: no answer.", "Input falls back to adb and the server is retried in 5 minutes; …");
      },
    });
    expect(await pool.warm("android", "S")).toMatchObject({ state: "failed", reason: expect.stringMatching(/did not start/) });
    pool.get("android", "S");
    expect(startAndroid).toHaveBeenCalledTimes(1);
    advance(300_000);
    pool.get("android", "S");
    expect(startAndroid).toHaveBeenCalledTimes(2);
  });

  it("android: markDead re-warms without stopping the old server; two deaths in 60 s fail the entry and stop the server (I3)", async () => {
    const hs = [androidHandle(1), androidHandle(2), androidHandle(3)];
    const all = [...hs];
    const { pool, startAndroid } = makePool({ startAndroid: async () => hs.shift()! });
    await pool.warm("android", "S");
    pool.markDead("android", "S", "forward_dead", pool.get("android", "S")!);
    await flush();
    expect(startAndroid).toHaveBeenCalledTimes(2);
    expect(all[0].stop).not.toHaveBeenCalled();
    pool.markDead("android", "S", "forward_dead", pool.get("android", "S")!);
    expect(pool.view("android", "S")).toMatchObject({ state: "failed", reason: expect.stringMatching(/died twice within 60s/) });
    // The flapping server would hold UiAutomation for the whole retry window.
    expect(all[1].stop).toHaveBeenCalledTimes(1);
    expect(all[0].stop).not.toHaveBeenCalled();
    expect(all[2].stop).not.toHaveBeenCalled();
  });

  it("I3: android markFailed stops the server so uiautomator dump works during the retry window", async () => {
    const h = androidHandle(1);
    const { pool } = makePool({ startAndroid: async () => h });
    await pool.warm("android", "S");
    pool.markFailed("android", "S", "unsupported: x", pool.get("android", "S")!);
    expect(pool.view("android", "S")).toMatchObject({ state: "failed", reason: "unsupported: x" });
    expect(h.stop).toHaveBeenCalledTimes(1);
    // A stale second report changes nothing.
    pool.markFailed("android", "S", "unsupported: x", fakeBackend(1));
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it("I3: ios markFailed still leaves a simctl runner running", async () => {
    const h = handle(40001, "simctl");
    const { pool } = makePool({ startIos: async () => h });
    await pool.warm("ios", "SIM-1");
    pool.markFailed("ios", "SIM-1", "unsupported: x", pool.get("ios", "SIM-1")!);
    expect(h.stop).not.toHaveBeenCalled();
  });

  it("android: shutdown leaves a ready server alive but stops a start still in flight", async () => {
    const ready = androidHandle(1);
    const d = deferred<AndroidServerHandle>();
    const inflight = androidHandle(2);
    const { pool } = makePool({
      startAndroid: async (serial, o) => {
        if (serial === "READY") return ready;
        o.onSpawn?.(inflight);
        return d.promise;
      },
    });
    await pool.warm("android", "READY");
    void pool.warm("android", "STARTING");
    await flush();
    await pool.shutdown({ killAfterMs: 1500 });
    expect(ready.stop).not.toHaveBeenCalled();
    expect(inflight.stop).toHaveBeenCalledWith(1500);
    d.reject(new DriverError("Android server start on STARTING aborted: the session is shutting down."));
    await flush();
  });

  it("android: every handle a start spawned is forgotten once it is ready (none stopped at shutdown)", async () => {
    const busy = androidHandle(1);
    const good = androidHandle(2);
    const { pool } = makePool({
      startAndroid: async (_s, o) => {
        o.onSpawn?.(busy); // attempt 1: startAndroidServer stops it itself
        o.onSpawn?.(good);
        return good;
      },
    });
    await pool.warm("android", "S");
    await pool.shutdown();
    expect(busy.stop).not.toHaveBeenCalled();
    expect(good.stop).not.toHaveBeenCalled();
  });

  it("android: RNE_NATIVE_DRIVER=off starts nothing", async () => {
    const { pool, startAndroid } = makePool({ env: { RNE_NATIVE_DRIVER: "off" } });
    await pool.warm("android", "S");
    expect(startAndroid).not.toHaveBeenCalled();
  });

  it("I3: RNE_NATIVE_DRIVER=off releases a server left by an earlier session, once per device, and warm waits for it", async () => {
    const d = deferred<void>();
    const { pool, releaseAndroid, advance } = makePool({ env: { RNE_NATIVE_DRIVER: "off" }, releaseAndroid: () => d.promise });
    let settled = false;
    const w = pool.warm("android", "S").then((v) => ((settled = true), v));
    await flush();
    expect(releaseAndroid).toHaveBeenCalledWith("S");
    expect(settled).toBe(false);
    expect(pool.view("android", "S")).toMatchObject({ state: "failed", reason: "disabled (RNE_NATIVE_DRIVER=off)" });
    d.resolve();
    expect(await w).toEqual({ state: "failed", reason: "disabled (RNE_NATIVE_DRIVER=off)" });
    advance(600_000);
    await pool.warm("android", "S");
    pool.get("android", "S");
    await pool.warm("android", "T");
    expect(releaseAndroid.mock.calls).toEqual([["S"], ["T"]]);
  });

  it("I3: a failing release under RNE_NATIVE_DRIVER=off still reports disabled; iOS releases nothing", async () => {
    const { pool, releaseAndroid } = makePool({ env: { RNE_NATIVE_DRIVER: "off" }, releaseAndroid: async () => { throw new Error("offline"); } });
    expect(await pool.warm("android", "S")).toEqual({ state: "failed", reason: "disabled (RNE_NATIVE_DRIVER=off)" });
    await pool.warm("ios", "SIM-1");
    expect(releaseAndroid).toHaveBeenCalledTimes(1);
  });

  it("view() is undefined for a device never warmed", () => {
    expect(makePool().pool.view("ios", "NOPE")).toBeUndefined();
  });

  it("shutdown stops only xcodebuild-launched runners and leaves simctl/reused ones alive", async () => {
    const byUdid: Record<string, RunnerHandle & { stop: ReturnType<typeof vi.fn> }> = {
      A: handle(1, "xcodebuild"),
      B: handle(2, "simctl"),
      C: handle(3, "reused"),
    };
    const { pool } = makePool({ startIos: async (udid) => byUdid[udid] });
    await Promise.all(["A", "B", "C"].map((u) => pool.warm("ios", u)));
    await pool.shutdown({ killAfterMs: 1500 });
    expect(byUdid.A.stop).toHaveBeenCalledTimes(1);
    // M-1: the SIGKILL deadline reaches the handle.
    expect(byUdid.A.stop).toHaveBeenCalledWith(1500);
    expect(byUdid.B.stop).not.toHaveBeenCalled();
    expect(byUdid.C.stop).not.toHaveBeenCalled();
  });

  it("an xcodebuild runner whose start finishes after shutdown is stopped too", async () => {
    const d = deferred<RunnerHandle>();
    const { pool } = makePool({ startIos: () => d.promise });
    const p = pool.warm("ios", "SIM-1");
    await pool.shutdown();
    const xc = handle(1, "xcodebuild");
    d.resolve(xc);
    await p;
    expect(xc.stop).toHaveBeenCalledTimes(1);
  });

  it("I-2: shutdown stops an xcodebuild child whose start is still in flight, and aborts the start", async () => {
    const xc = handle(1, "xcodebuild");
    let signal: AbortSignal | undefined;
    const { pool } = makePool({
      startIos: (_udid, o) => {
        signal = o.signal;
        o.onSpawn?.(xc);
        return new Promise<RunnerHandle>(() => {}); // still polling /status
      },
    });
    void pool.warm("ios", "SIM-1");
    expect(signal?.aborted).toBe(false);
    await pool.shutdown();
    expect(signal?.aborted).toBe(true);
    expect(xc.stop).toHaveBeenCalledTimes(1);
  });

  it("I-2: a child spawned after shutdown began is stopped at once", async () => {
    const xc = handle(1, "xcodebuild");
    let spawn: (() => void) | undefined;
    const { pool } = makePool({
      startIos: (_udid, o) => {
        spawn = () => o.onSpawn?.(xc);
        return new Promise<RunnerHandle>(() => {});
      },
    });
    void pool.warm("ios", "SIM-1");
    await pool.shutdown();
    spawn!();
    expect(xc.stop).toHaveBeenCalledTimes(1);
  });

  it("I-2: warm() after shutdown starts nothing", async () => {
    const { pool, startIos } = makePool();
    await pool.shutdown();
    expect(await pool.warm("ios", "SIM-1")).toEqual({ state: "failed", reason: "native pool shut down" });
    expect(pool.get("ios", "SIM-1")).toBeUndefined();
    expect(startIos).not.toHaveBeenCalled();
  });

  it("RF-1: two simulators get independent entries and backends", async () => {
    const { pool, startIos } = makePool({ startIos: async (udid) => handle(udid === "SIM-1" ? 40001 : 40002) });
    await pool.warm("ios", "SIM-1");
    await pool.warm("ios", "SIM-2");
    expect(startIos).toHaveBeenCalledTimes(2);
    expect((pool.get("ios", "SIM-1") as any).port).toBe(40001);
    expect((pool.get("ios", "SIM-2") as any).port).toBe(40002);
    pool.markDead("ios", "SIM-1", "refused", pool.get("ios", "SIM-1")!);
    expect(pool.view("ios", "SIM-1")?.state).toBe("dead");
    expect((pool.get("ios", "SIM-2") as any).port).toBe(40002);
  });

  it("RF-2: a runner that dies twice within 60s is marked failed instead of re-warmed again", async () => {
    const { pool, startIos, advance } = makePool();
    await pool.warm("ios", "SIM-1");
    pool.markDead("ios", "SIM-1", "lost: POST /viewHierarchy no answer within 10000ms", pool.get("ios", "SIM-1")!);
    await flush();
    await flush();
    expect(pool.view("ios", "SIM-1")?.state).toBe("ready");
    advance(10_000);
    pool.markDead("ios", "SIM-1", "lost: POST /viewHierarchy no answer within 10000ms", pool.get("ios", "SIM-1")!);
    await flush();
    const v = pool.view("ios", "SIM-1");
    expect(v?.state).toBe("failed");
    expect(v?.reason).toContain("died twice within 60s");
    expect(pool.get("ios", "SIM-1")).toBeUndefined();
    expect(startIos).toHaveBeenCalledTimes(2);
  });

  it("RF-2: deaths more than 60s apart keep re-warming", async () => {
    const { pool, startIos, advance } = makePool();
    await pool.warm("ios", "SIM-1");
    pool.markDead("ios", "SIM-1", "refused", pool.get("ios", "SIM-1")!);
    await flush();
    await flush();
    advance(61_000);
    pool.markDead("ios", "SIM-1", "refused", pool.get("ios", "SIM-1")!);
    await flush();
    await flush();
    expect(pool.view("ios", "SIM-1")?.state).toBe("ready");
    expect(startIos).toHaveBeenCalledTimes(3);
  });

  it("records the disabled state on get(), so a driver can tell 'off' from 'starting'", () => {
    const pool = new NativePool({
      env: { RNE_NATIVE_DRIVER: "off" },
      startIos: async () => {
        throw new Error("must not start");
      },
    });
    expect(pool.get("ios", "U")).toBeUndefined();
    expect(pool.view("ios", "U")).toMatchObject({ state: "failed", reason: "disabled (RNE_NATIVE_DRIVER=off)" });
  });

  it("D22: settled() hands out the start in flight (first start and re-warm alike), nothing otherwise", async () => {
    const first = deferred<AndroidServerHandle>();
    const again = deferred<AndroidServerHandle>();
    const starts = [first, again];
    const { pool } = makePool({ startAndroid: () => starts.shift()!.promise });
    expect(pool.settled("android", "emulator-5554")).toBeUndefined();
    expect(pool.get("android", "emulator-5554")).toBeUndefined();
    const s = pool.settled("android", "emulator-5554");
    expect(s).toBeInstanceOf(Promise);
    first.resolve(androidHandle(49424));
    expect(await s).toMatchObject({ state: "ready" });
    expect(pool.settled("android", "emulator-5554")).toBeUndefined();
    // A re-warm after a death is a start in flight too (the entry stays `dead` meanwhile).
    pool.markDead("android", "emulator-5554", "lost", pool.get("android", "emulator-5554")!);
    const r = pool.settled("android", "emulator-5554");
    expect(pool.view("android", "emulator-5554")?.state).toBe("dead");
    expect(r).toBeInstanceOf(Promise);
    again.reject(new Error("boom"));
    expect(await r).toMatchObject({ state: "failed", reason: "boom" });
  });
});

describe("notReadyReason", () => {
  it("formats the marker reason for every non-ready state", () => {
    expect(notReadyReason(undefined)).toBe("runner starting");
    expect(notReadyReason({ state: "starting" })).toBe("runner starting");
    expect(notReadyReason({ state: "dead", reason: "refused" })).toBe("runner dead: refused");
    expect(notReadyReason({ state: "failed", reason: "Android server not built" })).toBe("runner failed: Android server not built");
  });
});

describe("sharedPool", () => {
  it("is a module singleton", () => {
    expect(sharedPool()).toBe(sharedPool());
    expect(sharedPool()).toBeInstanceOf(NativePool);
  });
});
