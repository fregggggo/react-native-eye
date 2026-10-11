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

  it("readFailure never throws and says why", () => {
    const { f, np } = path(backend);
    expect(np.readFailure("S", backend, new NativeCallError("lost", "x"))).toBe("runner dead: x");
    expect(np.readFailure("S", backend, new NativeCallError("rejected", "y"))).toBe("runner rejected: y");
    expect(np.readFailure("S", backend, new Error("z"))).toBe("runner error: z");
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
