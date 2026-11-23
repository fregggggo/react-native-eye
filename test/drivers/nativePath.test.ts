import { describe, it, expect } from "vitest";
import { NativePath, fallbackReason } from "../../src/drivers/nativePath.js";
import { NativeCallError, type NativeFailureKind } from "../../src/native/httpClient.js";
import type { NativeBackend } from "../../src/native/nativeBackend.js";
import type { PoolEntryView } from "../../src/native/pool.js";

const backend = { platform: "android" } as unknown as NativeBackend;

function fakePool(b?: NativeBackend, view?: PoolEntryView) {
  const marks: string[] = [];
  return {
    marks,
    pool: {
      get: () => b,
      view: () => view,
      markDead: (p: string, u: string, r: string, from: NativeBackend) => void marks.push(`${from === b ? "" : "WRONG "}dead ${p} ${u} ${r}`),
      markFailed: (p: string, u: string, r: string, from: NativeBackend) => void marks.push(`${from === b ? "" : "WRONG "}failed ${p} ${u} ${r}`),
    },
  };
}

const failWith = (kind: NativeFailureKind, msg = "boom") => async () => {
  throw new NativeCallError(kind, msg);
};

describe("NativePath (android parameters)", () => {
  const path = (b?: NativeBackend, view?: PoolEntryView) => {
    const f = fakePool(b, view);
    return { f, np: new NativePath(f.pool, "android", "Android server", "adb") };
  };

  it("uses the backend and reports os/runner", async () => {
    const { np } = path(backend);
    let used = false;
    expect(await np.gesture("S", "tap", async () => void (used = true), async () => {})).toEqual({ path: "runner" });
    expect(used).toBe(true);
  });

  it("without a backend falls back with the pool's reason and hands it to the fallback", async () => {
    const { np } = path(undefined, { state: "starting" });
    let seen: string | undefined;
    expect(await np.gesture("S", "tap", async () => {}, async (why) => void (seen = why))).toEqual({ path: "adb", reason: "runner starting" });
    expect(seen).toBe("runner starting");
  });

  it("refused: marks dead, falls back", async () => {
    const { f, np } = path(backend);
    expect(await np.gesture("S", "tap", failWith("refused"), async () => {})).toEqual({ path: "adb", reason: "runner dead: boom" });
    expect(f.marks).toEqual(["dead android S boom"]);
  });

  it("unsupported: marks failed, falls back", async () => {
    const { f, np } = path(backend);
    expect(await np.gesture("S", "swipe", failWith("unsupported"), async () => {})).toEqual({ path: "adb", reason: "unsupported: boom" });
    expect(f.marks).toEqual(["failed android S unsupported: boom"]);
  });

  it("lost: marks dead and throws without falling back, naming the Android server", async () => {
    const { f, np } = path(backend);
    let fellBack = false;
    const e = await np.gesture("S", "tap", failWith("lost", "socket hang up"), async () => void (fellBack = true)).catch((x) => x);
    expect(e.message).toBe(
      "Android server connection lost during the tap (socket hang up) — the gesture may not have been delivered — check the screen before retrying.",
    );
    expect(fellBack).toBe(false);
    expect(f.marks).toEqual(["dead android S socket hang up"]);
  });

  it("rejected: throws, no fallback, no mark", async () => {
    const { f, np } = path(backend);
    const e = await np.gesture("S", "back key", failWith("rejected", "unknown key"), async () => {}).catch((x) => x);
    expect(e.message).toBe("Android server refused the back key: unknown key");
    expect(f.marks).toEqual([]);
  });

  it("readFailure never throws and says why", async () => {
    const { f, np } = path(backend);
    expect(await np.readFailure("S", backend, new NativeCallError("lost", "x"))).toBe("runner dead: x");
    expect(await np.readFailure("S", backend, new NativeCallError("rejected", "y"))).toBe("runner rejected: y");
    expect(await np.readFailure("S", backend, new Error("z"))).toBe("runner error: z");
    expect(f.marks).toEqual(["dead android S x"]);
  });

  it("osPath formats the fallback marker", () => {
    const { np } = path();
    expect(np.osPath()).toEqual({ path: "adb" });
    expect(np.osPath("runner starting")).toEqual({ path: "adb", reason: "runner starting" });
  });

  it("fallbackReason is undefined only for the kill switch", () => {
    expect(fallbackReason({ state: "failed", reason: "disabled (RNE_NATIVE_DRIVER=off)" })).toBeUndefined();
    expect(fallbackReason(undefined)).toBe("runner starting");
  });
});

// The iOS runner comes up in front of the app: an axe gesture sent during the
// start lands on the runner, not the app, and is reported as delivered.
describe("NativePath with a start wait (iOS)", () => {
  it("waits for a start in flight, then uses the runner", async () => {
    let ready: NativeBackend | undefined;
    let finish!: () => void;
    const inflight = new Promise<PoolEntryView>((r) => (finish = () => r({ state: "ready", via: "simctl" })));
    const pool = {
      get: () => ready,
      view: (): PoolEntryView => (ready ? { state: "ready", via: "simctl" } : { state: "starting" }),
      markDead: () => {},
      markFailed: () => {},
      settled: () => (ready ? undefined : inflight),
    };
    const np = new NativePath(pool, "ios", "iOS runner", "axe", 1_000);
    let fellBack = false;
    const res = np.gesture("U", "tap", async () => {}, async () => void (fellBack = true));
    ready = { platform: "ios" } as unknown as NativeBackend;
    finish();
    expect(await res).toEqual({ path: "runner" });
    expect(fellBack).toBe(false);
  });

  it("falls back as before when the start is still in flight after the wait", async () => {
    const pool = {
      get: () => undefined,
      view: (): PoolEntryView => ({ state: "starting" }),
      markDead: () => {},
      markFailed: () => {},
      settled: () => new Promise<PoolEntryView>(() => {}),
    };
    const np = new NativePath(pool, "ios", "iOS runner", "axe", 10);
    expect(await np.gesture("U", "tap", async () => {}, async () => {})).toEqual({ path: "axe", reason: "runner starting" });
  });
});

// Review #4 / field test 3: a 10.5 s hierarchy timeout on a screen playing
// video, with the server alive throughout. Two of those in a minute flapped
// the pool to failed and force-stopped the server.
describe("NativePath — a timeout from a runner that still answers /status is slow, not dead", () => {
  const timeout = () => new NativeCallError("lost", "GET /hierarchy timed out after 10000ms", undefined, "timeout");
  const withStatus = (alive: boolean) => {
    let probes = 0;
    const b = {
      platform: "android",
      status: async () => {
        probes++;
        if (!alive) throw new NativeCallError("refused", "ECONNREFUSED");
        return { version: "x" };
      },
    } as unknown as NativeBackend;
    return { b, probes: () => probes };
  };
  const path = (b: NativeBackend) => {
    const f = fakePool(b);
    return { f, np: new NativePath(f.pool, "android", "Android server", "adb") };
  };

  it("a read: falls back without marking the runner dead", async () => {
    const { b, probes } = withStatus(true);
    const { f, np } = path(b);
    expect(await np.readFailure("S", b, timeout())).toBe("runner slow: GET /hierarchy timed out after 10000ms");
    expect(await np.readFailure("S", b, timeout())).toMatch(/^runner slow/);
    expect(f.marks).toEqual([]);
    expect(probes()).toBe(2);
  });

  it("a read: still dead when /status does not answer either", async () => {
    const { b } = withStatus(false);
    const { f, np } = path(b);
    expect(await np.readFailure("S", b, timeout())).toMatch(/^runner dead/);
    expect(f.marks).toEqual(["dead android S GET /hierarchy timed out after 10000ms"]);
  });

  it("excuses at most 3 timeouts a minute: a route stuck for good still counts as dead", async () => {
    const { b } = withStatus(true);
    const { f, np } = path(b);
    for (let i = 0; i < 3; i++) expect(await np.readFailure("S", b, timeout())).toMatch(/^runner slow/);
    expect(await np.readFailure("S", b, timeout())).toMatch(/^runner dead/);
    expect(f.marks).toHaveLength(1);
  });

  it("a refused or non-timeout loss is not excused, and /status is not asked", async () => {
    const { b, probes } = withStatus(true);
    const { f, np } = path(b);
    expect(await np.readFailure("S", b, new NativeCallError("lost", "socket hang up"))).toMatch(/^runner dead/);
    expect(await np.readFailure("S", b, new NativeCallError("refused", "ECONNREFUSED"))).toMatch(/^runner dead/);
    expect(probes()).toBe(0);
    expect(f.marks).toHaveLength(2);
  });

  it("a gesture: throws (delivery unknown) but leaves the runner alone", async () => {
    const { b } = withStatus(true);
    const { f, np } = path(b);
    let fellBack = false;
    const e = await np
      .gesture("S", "tap", async () => {
        throw timeout();
      }, async () => void (fellBack = true))
      .catch((x) => x);
    expect(e.message).toMatch(/did not finish the tap in time .* but is still running/);
    expect(fellBack).toBe(false);
    expect(f.marks).toEqual([]);
  });
});
