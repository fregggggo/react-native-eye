import { describe, it, expect, vi } from "vitest";
import { AndroidDriver, ANDROID_START_WAIT_MS } from "../../src/drivers/android.js";
import { AndroidServerBackend } from "../../src/native/androidBackend.js";
import { NativeCallError, type NativeFailureKind } from "../../src/native/httpClient.js";
import type { NativeBackend } from "../../src/native/nativeBackend.js";
import { NativePool, type PoolEntryView } from "../../src/native/pool.js";
import type { AndroidServerHandle } from "../../src/native/androidServer.js";
import { osMarker } from "../../src/input/dispatch.js";
import type { OsPath } from "../../src/drivers/types.js";

const S = "emulator-5554";
const SERVER_XML =
  `<hierarchy rotation="0"><node bounds="[0,0][1440,3120]" package="com.app">` +
  `<node text="Server button" resource-id="com.app:id/go" bounds="[100,200][500,300]" package="com.app"/></node></hierarchy>`;
const DUMP_XML = `<hierarchy><node bounds="[0,0][1440,3120]"><node text="Dump button" bounds="[0,0][10,10]"/></node></hierarchy>`;
const EMPTY_XML = `<hierarchy rotation="0"></hierarchy>`;
/** A splash screen: windows, but nothing with text or a testID. */
const UNLABELLED_XML =
  `<hierarchy rotation="0"><node bounds="[0,0][1440,3120]" package="com.app">` +
  `<node class="android.widget.ImageView" bounds="[0,0][1440,3120]" package="com.app"/></node></hierarchy>`;

function fakeRunner(dump = DUMP_XML) {
  const calls: string[] = [];
  const runner = async (cmd: string, args: string[]) => {
    const line = `${cmd} ${args.join(" ")}`;
    calls.push(line);
    const stdout = line.includes("uiautomator dump") ? dump : "";
    const stdoutBuffer = line.includes("screencap") ? Buffer.from("screencap-png") : Buffer.from(stdout);
    return { stdout, stdoutBuffer, stderr: "" };
  };
  return { runner: runner as any, calls };
}

function fakeShell() {
  const cmds: string[] = [];
  return { cmds, shellFor: () => ({ exec: async (cmd: string) => (cmds.push(cmd), "") }) };
}

type Method = "touch" | "swipe" | "inputText" | "pressKey" | "hierarchy" | "screenshot";

/** `alive`: whether /status still answers after the failure (the server holds UiAutomation). */
function fakeBackend(
  fail?: { method: Method; kind: NativeFailureKind },
  hierarchy: unknown = { hierarchy: SERVER_XML },
  alive = true,
) {
  const calls: string[] = [];
  const act = (name: Method, result?: () => unknown) => async (...args: unknown[]) => {
    calls.push([name, ...args.filter((a) => a !== undefined)].join(" "));
    if (fail?.method === name) throw new NativeCallError(fail.kind, `${fail.kind} boom`);
    return result?.();
  };
  const backend = {
    platform: "android",
    hierarchy: act("hierarchy", () => hierarchy),
    touch: act("touch"),
    swipe: act("swipe"),
    inputText: act("inputText"),
    pressKey: act("pressKey"),
    screenshot: act("screenshot", () => Buffer.from("server-png")),
    status: async () => {
      calls.push("status");
      if (!alive) throw new NativeCallError("refused", "status refused");
      return { status: "ok", version: "v" };
    },
  } as unknown as NativeBackend;
  return { backend, calls };
}

function fakePool(backend?: NativeBackend, view?: PoolEntryView) {
  const marks: string[] = [];
  const pool = {
    get: () => backend,
    view: () => view ?? (backend ? ({ state: "ready" } as PoolEntryView) : undefined),
    markDead: (p: string, u: string, r: string, from: NativeBackend) => void marks.push(`${from === backend ? "" : "WRONG BACKEND "}dead ${p} ${u} ${r}`),
    markFailed: (p: string, u: string, r: string, from: NativeBackend) => void marks.push(`${from === backend ? "" : "WRONG BACKEND "}failed ${p} ${u} ${r}`),
  };
  return { pool, marks };
}

function driver(b?: NativeBackend, view?: PoolEntryView, dump?: string) {
  const r = fakeRunner(dump);
  const sh = fakeShell();
  const p = fakePool(b, view);
  return { d: new AndroidDriver(r.runner, undefined, sh.shellFor, p.pool), runner: r, shell: sh, marks: p.marks };
}

const GESTURES: { name: string; method: Method; call: (d: AndroidDriver) => Promise<OsPath>; runner: string; adb: string }[] = [
  { name: "tap", method: "touch", call: (d) => d.tapXY(S, 10, 20), runner: "touch 10 20", adb: "input 'tap' '10' '20'" },
  { name: "long press", method: "touch", call: (d) => d.tapXY(S, 10, 20, 800), runner: "touch 10 20 800", adb: "input 'swipe' '10' '20' '10' '20' '800'" },
  { name: "swipe", method: "swipe", call: (d) => d.swipe(S, 1, 2, 3, 4, 300), runner: "swipe 1 2 3 4 300", adb: "input 'swipe' '1' '2' '3' '4' '300'" },
  { name: "type_text", method: "inputText", call: (d) => d.typeText(S, "hi"), runner: "inputText hi", adb: "input 'text' 'hi'" },
  { name: "back key", method: "pressKey", call: (d) => d.pressKey(S, "back"), runner: "pressKey back", adb: "input 'keyevent' '4'" },
  { name: "home key", method: "pressKey", call: (d) => d.pressKey(S, "home"), runner: "pressKey home", adb: "input 'keyevent' '3'" },
];

describe("AndroidDriver with the on-device server", () => {
  for (const g of GESTURES) {
    describe(g.name, () => {
      it("goes through the server when it is ready", async () => {
        const b = fakeBackend();
        const t = driver(b.backend);
        expect(await g.call(t.d)).toEqual({ path: "runner" });
        expect(b.calls).toEqual([g.runner]);
        expect(t.shell.cmds).toEqual([]);
      });

      it("falls back to adb with the pool's reason while the server starts", async () => {
        const t = driver(undefined, { state: "starting" });
        const os = await g.call(t.d);
        expect(os).toEqual({ path: "adb", reason: "runner starting" });
        expect(osMarker(os)).toBe("(input: os/adb — runner starting)");
        expect(t.shell.cmds).toEqual([g.adb]);
      });

      it("refused: marks dead and falls back once", async () => {
        const b = fakeBackend({ method: g.method, kind: "refused" });
        const t = driver(b.backend);
        expect(await g.call(t.d)).toEqual({ path: "adb", reason: "runner dead: refused boom" });
        expect(t.marks).toEqual([`dead android ${S} refused boom`]);
        expect(t.shell.cmds).toEqual([g.adb]);
      });

      it("lost: marks dead, does not repeat through adb", async () => {
        const b = fakeBackend({ method: g.method, kind: "lost" });
        const t = driver(b.backend);
        const e = await g.call(t.d).catch((x) => x);
        expect(e.message).toMatch(/Android server connection lost during the .* may not have been delivered/);
        expect(t.shell.cmds).toEqual([]);
        expect(t.marks).toEqual([`dead android ${S} lost boom`]);
      });

      it("rejected: surfaces the error, no fallback", async () => {
        const b = fakeBackend({ method: g.method, kind: "rejected" });
        const t = driver(b.backend);
        expect((await g.call(t.d).catch((x) => x)).message).toMatch(/^Android server refused the /);
        expect(t.shell.cmds).toEqual([]);
      });

      it("unsupported: marks failed and falls back", async () => {
        const b = fakeBackend({ method: g.method, kind: "unsupported" });
        const t = driver(b.backend);
        expect(await g.call(t.d)).toEqual({ path: "adb", reason: "unsupported: unsupported boom" });
        expect(t.marks).toEqual([`failed android ${S} unsupported: unsupported boom`]);
        expect(t.shell.cmds).toEqual([g.adb]);
      });
    });
  }

  it("types non-ASCII text through the server (IME) and reports os/runner", async () => {
    const b = fakeBackend();
    const t = driver(b.backend);
    expect(await t.d.typeText(S, "こんにちは")).toEqual({ path: "runner" });
    expect(b.calls).toEqual(["inputText こんにちは"]);
  });

  it("refuses non-ASCII text on the adb path and says why the server was not used", async () => {
    const t = driver(undefined, { state: "failed", reason: "Android server not built — …" });
    const e = await t.d.typeText(S, "こんにちは").catch((x) => x);
    expect(e.message).toMatch(/non-ASCII/);
    expect(e.message).toContain("runner failed: Android server not built");
    expect(t.shell.cmds).toEqual([]);
  });

  it("layout comes from the server's hierarchy", async () => {
    const b = fakeBackend();
    const t = driver(b.backend);
    const { els, os } = await t.d.rawLayout(S);
    expect(os).toEqual({ path: "runner" });
    expect(els.map((e) => e.text)).toEqual(["Server button"]);
    expect(t.runner.calls.some((c) => c.includes("uiautomator"))).toBe(false);
  });

  it("a screen with nothing labelled is an empty layout from the server, not a reason to dump", async () => {
    const b = fakeBackend(undefined, { hierarchy: UNLABELLED_XML });
    const t = driver(b.backend);
    expect(await t.d.rawLayout(S)).toEqual({ els: [], os: { path: "runner" } });
    expect(b.calls).toEqual(["hierarchy"]);
    expect(t.runner.calls.some((c) => c.includes("uiautomator"))).toBe(false);
  });

  it("a hierarchy without a single node is retried once, then reported as an empty screen", async () => {
    const b = fakeBackend(undefined, { hierarchy: EMPTY_XML });
    const t = driver(b.backend);
    expect(await t.d.rawLayout(S)).toEqual({ els: [], os: { path: "runner" } });
    expect(b.calls).toEqual(["hierarchy", "hierarchy"]);
    expect(t.runner.calls.some((c) => c.includes("uiautomator"))).toBe(false);
  });

  it("a lost hierarchy read while /status still answers: marks dead, no futile dump, says why", async () => {
    const b = fakeBackend({ method: "hierarchy", kind: "lost" });
    const t = driver(b.backend);
    const e = await t.d.rawLayout(S).catch((x) => x);
    expect(e.message).toMatch(/Android server could not read the view hierarchy \(runner dead: lost boom\)/);
    expect(e.message).toMatch(/uiautomator dump` cannot either/);
    expect(e.recommendation).toContain('source:"js"');
    expect(t.marks).toEqual([`dead android ${S} lost boom`]);
    expect(b.calls).toEqual(["hierarchy", "status"]);
    expect(t.runner.calls).toEqual([]);
  });

  it("a lost hierarchy read with the server gone falls back to uiautomator dump (reads are safe to repeat)", async () => {
    const b = fakeBackend({ method: "hierarchy", kind: "lost" }, undefined, false);
    const t = driver(b.backend);
    const { els, os } = await t.d.rawLayout(S);
    expect(os).toEqual({ path: "adb", reason: "runner dead: lost boom" });
    expect(els.map((e) => e.text)).toEqual(["Dump button"]);
    expect(t.marks).toEqual([`dead android ${S} lost boom`]);
  });

  it("a hierarchy answer without a string is the server's error, not an empty screen", async () => {
    const b = fakeBackend(undefined, { nope: 1 });
    const t = driver(b.backend);
    const e = await t.d.rawLayout(S).catch((x) => x);
    expect(e.message).toMatch(/runner rejected: its \/viewHierarchy answer carries no hierarchy/);
    expect(t.runner.calls).toEqual([]);
  });

  it("screenshot comes from the server, falls back to screencap silently", async () => {
    const ok = driver(fakeBackend().backend);
    expect((await ok.d.screenshotPng(S)).toString()).toBe("server-png");
    const bad = driver(fakeBackend({ method: "screenshot", kind: "refused" }).backend);
    expect((await bad.d.screenshotPng(S)).toString()).toBe("screencap-png");
    expect(bad.marks).toEqual([`dead android ${S} refused boom`]);
  });

  it("with the kill switch the markers are exactly today's", async () => {
    const t = driver(undefined, { state: "failed", reason: "disabled (RNE_NATIVE_DRIVER=off)" });
    expect(await t.d.tapXY(S, 1, 2)).toEqual({ path: "adb" });
    expect((await t.d.rawLayout(S)).os).toEqual({ path: "adb" });
  });

  for (const [kind, reason, mark] of [
    ["refused", "runner dead: refused boom", `dead android ${S} refused boom`],
    ["rejected", "runner rejected: rejected boom", undefined],
    ["unsupported", "unsupported: unsupported boom", `failed android ${S} unsupported: unsupported boom`],
  ] as const) {
    it(`rawLayout: ${kind} with the server gone falls back to uiautomator dump once and says why`, async () => {
      const b = fakeBackend({ method: "hierarchy", kind }, undefined, false);
      const t = driver(b.backend);
      const { els, os } = await t.d.rawLayout(S);
      expect(os).toEqual({ path: "adb", reason });
      expect(els.map((e) => e.text)).toEqual(["Dump button"]);
      // refused already says the server is gone: no /status probe.
      expect(b.calls).toEqual(kind === "refused" ? ["hierarchy"] : ["hierarchy", "status"]);
      expect(t.marks).toEqual(mark ? [mark] : []);
    });

    if (kind !== "refused") {
      it(`rawLayout: ${kind} while the server still answers /status surfaces an error instead of a futile dump`, async () => {
        const b = fakeBackend({ method: "hierarchy", kind });
        const t = driver(b.backend);
        const e = await t.d.rawLayout(S).catch((x) => x);
        expect(e.message).toContain(`could not read the view hierarchy (${reason})`);
        expect(t.runner.calls).toEqual([]);
        expect(t.marks).toEqual(mark ? [mark] : []);
      });
    }

    it(`screenshotPng: ${kind} falls back to screencap`, async () => {
      const t = driver(fakeBackend({ method: "screenshot", kind }).backend);
      expect((await t.d.screenshotPng(S)).toString()).toBe("screencap-png");
      expect(t.marks).toEqual(mark ? [mark] : []);
    });
  }

  it("a dump killed because a server still holds UiAutomation says so, names the release command, and is not retried", async () => {
    const t = driver(undefined, { state: "dead", reason: "lost boom" }, "Killed \n");
    const e = await t.d.rawLayout(S).catch((x) => x);
    // Plainly: why our server was not used, and what the fallback itself said.
    expect(e.message.startsWith(
      `The RNEye Android server was not available (runner dead: lost boom), and the fallback \`uiautomator dump\` failed too (Killed): ` +
        `another process holds UiAutomation on ${S}. `,
    )).toBe(true);
    expect(e.message).not.toMatch(/normally the RNEye Android server/);
    expect(e.recommendation).toContain('source:"js"');
    expect(e.recommendation).toContain(`adb -s ${S} shell am force-stop dev.rneye.server`);
    expect(e.recommendation).toMatch(/Maestro, Appium/);
    expect(t.runner.calls.filter((c) => c.includes("uiautomator dump"))).toHaveLength(1);
  });

  it("a dump whose adb call fails with Killed is recognised the same way", async () => {
    const runner = async () => {
      throw new Error("adb failed: Killed");
    };
    const p = fakePool(undefined, { state: "dead", reason: "x" });
    const d = new AndroidDriver(runner as any, undefined, fakeShell().shellFor, p.pool);
    expect((await d.rawLayout(S).catch((x) => x)).message).toMatch(/another process holds UiAutomation/);
  });

  it("the older 'already registered' shape is recognised the same way", async () => {
    const t = driver(undefined, { state: "dead", reason: "x" }, "java.lang.IllegalStateException: UiAutomationService android.accessibilityservice.IAccessibilityServiceClient@1 already registered!\n");
    expect((await t.d.rawLayout(S).catch((x) => x)).message).toMatch(/another process holds UiAutomation/);
  });

  describe("D22: OS layout during a server start", () => {
    /** A pool whose start is in flight: get() is undefined until `settle` makes it ready (or failed). */
    function startingPool(initial: PoolEntryView = { state: "starting" }) {
      let view: PoolEntryView = initial;
      let backend: NativeBackend | undefined;
      let resolve!: (v: PoolEntryView) => void;
      let inflight: Promise<PoolEntryView> | undefined = new Promise<PoolEntryView>((r) => (resolve = r));
      const pool = {
        get: () => backend,
        view: () => view,
        markDead: () => {},
        markFailed: () => {},
        settled: () => inflight,
      };
      const settle = (v: PoolEntryView, b?: NativeBackend) => {
        view = v;
        backend = b;
        inflight = undefined;
        resolve(v);
      };
      return { pool, settle };
    }
    const flushAll = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };

    it("waits for the start instead of racing uiautomator dump against it, then uses the server", async () => {
      const p = startingPool();
      const r = fakeRunner();
      const d = new AndroidDriver(r.runner, undefined, fakeShell().shellFor, p.pool);
      const pending = d.rawLayout(S);
      await flushAll();
      expect(r.calls.filter((c) => c.includes("uiautomator"))).toEqual([]);
      const b = fakeBackend();
      p.settle({ state: "ready", via: "instrument" }, b.backend);
      const { els, os } = await pending;
      expect(os).toEqual({ path: "runner" });
      expect(els.map((e) => e.text)).toEqual(["Server button"]);
      expect(r.calls.some((c) => c.includes("uiautomator"))).toBe(false);
    });

    it("a re-warm after a death is waited for the same way", async () => {
      const p = startingPool({ state: "dead", reason: "lost boom" });
      const r = fakeRunner();
      const d = new AndroidDriver(r.runner, undefined, fakeShell().shellFor, p.pool);
      const pending = d.rawLayout(S);
      await flushAll();
      expect(r.calls).toEqual([]);
      p.settle({ state: "ready", via: "instrument" }, fakeBackend().backend);
      expect((await pending).os).toEqual({ path: "runner" });
    });

    it("falls back to the dump only once the start has failed, naming why", async () => {
      const p = startingPool();
      const r = fakeRunner();
      const d = new AndroidDriver(r.runner, undefined, fakeShell().shellFor, p.pool);
      const pending = d.rawLayout(S);
      await flushAll();
      expect(r.calls).toEqual([]);
      p.settle({ state: "failed", reason: "Android server did not start" });
      const { els, os } = await pending;
      expect(os).toEqual({ path: "adb", reason: "runner failed: Android server did not start" });
      expect(els.map((e) => e.text)).toEqual(["Dump button"]);
    });

    it("a start that outlasts the budget is not raced either: the call says so instead of dumping", async () => {
      vi.useFakeTimers();
      try {
        const p = startingPool();
        const r = fakeRunner();
        const d = new AndroidDriver(r.runner, undefined, fakeShell().shellFor, p.pool);
        const pending = d.rawLayout(S).catch((x) => x);
        await vi.advanceTimersByTimeAsync(ANDROID_START_WAIT_MS + 1);
        const e = await pending;
        expect(e.message).toMatch(/Android server is still starting on emulator-5554/);
        expect(e.message).toMatch(/only one UiAutomation client/);
        expect(e.recommendation).toContain('source:"js"');
        expect(r.calls).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("gestures do not wait for the start: adb input does not touch UiAutomation", async () => {
      const p = startingPool();
      const sh = fakeShell();
      const d = new AndroidDriver(fakeRunner().runner, undefined, sh.shellFor, p.pool);
      expect(await d.tapXY(S, 1, 2)).toEqual({ path: "adb", reason: "runner starting" });
      expect(sh.cmds).toEqual(["input 'tap' '1' '2'"]);
    });
  });

  it("a held dump after a failed start quotes the start's own reason (an external holder), not our server", async () => {
    const reason = "Android server did not start on emulator-5554: another tool holds UiAutomation (uiautomator dump, Maestro, Appium), so the server could not register it (4 attempts).";
    const t = driver(undefined, { state: "failed", reason }, "Killed \n");
    const e = await t.d.rawLayout(S).catch((x) => x);
    expect(e.message).toContain(`was not available (runner failed: ${reason.replace(/\.$/, "")})`);
    expect(e.message).toContain("the fallback `uiautomator dump` failed too (Killed)");
  });

  it("with the kill switch a held dump names no server reason", async () => {
    const t = driver(undefined, { state: "failed", reason: "disabled (RNE_NATIVE_DRIVER=off)" }, "Killed \n");
    const e = await t.d.rawLayout(S).catch((x) => x);
    expect(e.message.startsWith(`uiautomator dump could not run (Killed): another process holds UiAutomation on ${S}. `)).toBe(true);
    expect(e.message).not.toContain("was not available");
  });

  describe("D32: the layout call that discovers the server's death", () => {
    /** A ready pool whose markDead withdraws the backend and starts a re-warm (or fails the entry when `flap`). */
    function dyingPool(first: NativeBackend, opts: { flap?: boolean } = {}) {
      let backend: NativeBackend | undefined = first;
      let view: PoolEntryView = { state: "ready" };
      let resolve!: (v: PoolEntryView) => void;
      let inflight: Promise<PoolEntryView> | undefined;
      const marks: string[] = [];
      const pool = {
        get: () => backend,
        view: () => view,
        markDead: (_p: string, _u: string, reason: string, from: NativeBackend) => {
          if (from !== backend) return;
          marks.push(`dead ${reason}`);
          backend = undefined;
          if (opts.flap) {
            view = { state: "failed", reason: `runner unstable — ${reason} (died twice within 60s)` };
            return;
          }
          view = { state: "dead", reason };
          inflight = new Promise<PoolEntryView>((r) => (resolve = r));
        },
        markFailed: (_p: string, _u: string, reason: string, from: NativeBackend) => {
          if (from !== backend) return;
          marks.push(`failed ${reason}`);
          backend = undefined;
          view = { state: "failed", reason };
        },
        settled: () => inflight,
      };
      const settle = (v: PoolEntryView, b?: NativeBackend) => {
        view = v;
        backend = b;
        inflight = undefined;
        resolve(v);
      };
      return { pool, settle, marks };
    }
    const flushAll = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    for (const kind of ["lost", "refused"] as const) {
      it(`${kind}: waits for the re-warm it caused instead of dumping, then reads from the fresh server`, async () => {
        const old = fakeBackend({ method: "hierarchy", kind }, undefined, false);
        const p = dyingPool(old.backend);
        const r = fakeRunner();
        const d = new AndroidDriver(r.runner, undefined, fakeShell().shellFor, p.pool);
        const pending = d.rawLayout(S);
        await flushAll();
        expect(p.marks).toEqual([`dead ${kind} boom`]);
        expect(r.calls).toEqual([]);
        const fresh = fakeBackend();
        p.settle({ state: "ready", via: "instrument" }, fresh.backend);
        const { els, os } = await pending;
        expect(os).toEqual({ path: "runner" });
        expect(els.map((e) => e.text)).toEqual(["Server button"]);
        expect(fresh.calls).toEqual(["hierarchy"]);
        expect(r.calls).toEqual([]);
      });
    }

    it("dumps only once the restart has failed, and the marker says why the restart failed", async () => {
      const old = fakeBackend({ method: "hierarchy", kind: "lost" }, undefined, false);
      const p = dyingPool(old.backend);
      const r = fakeRunner();
      const d = new AndroidDriver(r.runner, undefined, fakeShell().shellFor, p.pool);
      const pending = d.rawLayout(S);
      await flushAll();
      expect(r.calls).toEqual([]);
      p.settle({ state: "failed", reason: "Android server did not start" });
      const { els, os } = await pending;
      expect(os).toEqual({ path: "adb", reason: "runner failed: Android server did not start" });
      expect(els.map((e) => e.text)).toEqual(["Dump button"]);
    });

    it("a restart that outlasts the budget is not raced: the call says so instead of dumping", async () => {
      vi.useFakeTimers();
      try {
        const old = fakeBackend({ method: "hierarchy", kind: "refused" }, undefined, false);
        const p = dyingPool(old.backend);
        const r = fakeRunner();
        const d = new AndroidDriver(r.runner, undefined, fakeShell().shellFor, p.pool);
        const pending = d.rawLayout(S).catch((x) => x);
        await vi.advanceTimersByTimeAsync(ANDROID_START_WAIT_MS + 1);
        const e = await pending;
        expect(e.message).toMatch(/Android server is still starting on emulator-5554/);
        expect(r.calls).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("a death that starts no re-warm (flap rule) dumps at once, with the pool's reason", async () => {
      const old = fakeBackend({ method: "hierarchy", kind: "refused" }, undefined, false);
      const p = dyingPool(old.backend, { flap: true });
      const r = fakeRunner();
      const d = new AndroidDriver(r.runner, undefined, fakeShell().shellFor, p.pool);
      const { els, os } = await d.rawLayout(S);
      expect(os).toEqual({ path: "adb", reason: "runner failed: runner unstable — refused boom (died twice within 60s)" });
      expect(els.map((e) => e.text)).toEqual(["Dump button"]);
    });

    it("the fresh server failing too is not retried a third time", async () => {
      const old = fakeBackend({ method: "hierarchy", kind: "refused" }, undefined, false);
      const p = dyingPool(old.backend);
      const r = fakeRunner();
      const d = new AndroidDriver(r.runner, undefined, fakeShell().shellFor, p.pool);
      const pending = d.rawLayout(S);
      await flushAll();
      const fresh = fakeBackend({ method: "hierarchy", kind: "refused" }, undefined, false);
      p.settle({ state: "ready", via: "instrument" }, fresh.backend);
      await flushAll();
      expect(fresh.calls).toEqual(["hierarchy"]);
      // The second death re-warms again; that start fails.
      p.settle({ state: "failed", reason: "boom" });
      const { os } = await pending;
      expect(os).toEqual({ path: "adb", reason: "runner failed: boom" });
      expect(p.marks).toEqual(["dead refused boom", "dead refused boom"]);
    });

    it("with the real pool: the death is reported, the re-warm awaited, the fresh server read — no dump", async () => {
      const backends = [fakeBackend({ method: "hierarchy", kind: "refused" }, undefined, false), fakeBackend()];
      const handles: { resolve: (h: AndroidServerHandle) => void }[] = [];
      const startAndroid = vi.fn(() => new Promise<AndroidServerHandle>((resolve) => handles.push({ resolve })));
      const handle = (port: number): AndroidServerHandle => ({ port, serial: S, socket: "rneye-x", via: "instrument", stop: async () => {} });
      const pool = new NativePool({
        startAndroid,
        makeAndroidBackend: (port) => backends[port - 1].backend,
        releaseAndroid: async () => {},
        env: {},
      });
      const warm = pool.warm("android", S);
      handles[0].resolve(handle(1));
      await warm;
      const r = fakeRunner();
      const d = new AndroidDriver(r.runner, undefined, fakeShell().shellFor, pool);
      const pending = d.rawLayout(S);
      await flushAll();
      expect(startAndroid).toHaveBeenCalledTimes(2);
      expect(pool.view("android", S)).toMatchObject({ state: "dead", reason: "refused boom" });
      expect(r.calls).toEqual([]);
      handles[1].resolve(handle(2));
      const { els, os } = await pending;
      expect(os).toEqual({ path: "runner" });
      expect(els.map((e) => e.text)).toEqual(["Server button"]);
      expect(r.calls).toEqual([]);
    });

    it("a lost gesture is still never repeated, re-warm or not", async () => {
      const old = fakeBackend({ method: "touch", kind: "lost" });
      const p = dyingPool(old.backend);
      const sh = fakeShell();
      const d = new AndroidDriver(fakeRunner().runner, undefined, sh.shellFor, p.pool);
      const e = await d.tapXY(S, 1, 2).catch((x) => x);
      expect(e.message).toMatch(/may not have been delivered/);
      expect(sh.cmds).toEqual([]);
      expect(old.calls).toEqual(["touch 1 2"]);
    });
  });

  it("gives the user's keyboard back once per server generation, in the background, whatever the call", async () => {
    const repaired: string[] = [];
    const http = { callJson: async () => ({ hierarchy: SERVER_XML }) as never, callBytes: async () => Buffer.from("png") };
    const server = new AndroidServerBackend(4000, S, http, async () => {}, {
      adb: async () => "",
      repairIme: async (serial) => void repaired.push(serial),
    });
    const p = fakePool(server);
    const r = fakeRunner();
    const sh = fakeShell();
    await new AndroidDriver(r.runner, undefined, sh.shellFor, p.pool).tapXY(S, 1, 2);
    await new AndroidDriver(r.runner, undefined, sh.shellFor, p.pool).rawLayout(S);
    await new AndroidDriver(r.runner, undefined, sh.shellFor, p.pool).screenshotPng(S);
    expect(repaired).toEqual([S]);
    // A replaced server (new generation) repairs again.
    const next = new AndroidServerBackend(4001, S, http, async () => {}, {
      adb: async () => "",
      repairIme: async (serial) => void repaired.push(serial),
    });
    await new AndroidDriver(r.runner, undefined, sh.shellFor, fakePool(next).pool).tapXY(S, 1, 2);
    expect(repaired).toEqual([S, S]);
  });
});
