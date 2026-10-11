import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerDeviceTools } from "../../src/tools/devices.js";
import { registerErrorTools } from "../../src/tools/errors.js";
import { makeRuntime, type FakeRuntime } from "../helpers/rnRuntime.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, evalEnvelope, noRuntime, type FakeMetro } from "../helpers/fakeCdp.js";
import type { DeviceDriver } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";

let metro: FakeMetro;
let evaluated: string[] = [];
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

const driver: DeviceDriver = {
  platform: "ios",
  listDevices: async () => [
    { platform: "ios", udid: "A", name: "iPhone 15", booted: true },
    { platform: "ios", udid: "B", name: "iPad", booted: false },
  ],
  screenshotPng: async () => Buffer.from(""),
  rawLayout: async () => axeLayout([]),
  tapXY: async () => AXE,
  swipe: async () => AXE,
  typeText: async () => AXE,
  pressKey: async () => AXE,
  launchApp: async () => {},
};

async function connect(opts?: { reloads?: boolean }) {
  metro = await startFakeMetro({ port: 0 });
  evaluated = [];
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  let reloaded = false;
  metro.setHandler("Page.reload", () => {
    reloaded = opts?.reloads !== false;
    return {};
  });
  metro.setHandler("Runtime.evaluate", (p: any) => {
    const expr = String(p.expression);
    evaluated.push(expr);
    // A reloaded runtime has lost every global the previous one set.
    if (expr.includes("typeof globalThis.__RNE_SENTINEL")) return evalEnvelope(reloaded ? "undefined" : "number");
    if (expr.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) return evalEnvelope(true);
    return evalEnvelope(true);
  });
  await getRegistry().connect({ port: metro.port });
}

describe("device tools", () => {
  it("list_devices shows booted marker", async () => {
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver] });
    const res = await callTool(server, "list_devices", {});
    expect(res.content[0].text).toContain("iPhone 15");
    expect(res.content[0].text).toMatch(/booted/i);
  });

  it("reload_app confirms the runtime actually restarted", async () => {
    await connect();
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver] });
    const res = await callTool(server, "reload_app", {});
    expect(res.content[0].text).toMatch(/new JS runtime confirmed/i);
  });

  it("reload_app says so when the old runtime keeps answering", async () => {
    await connect({ reloads: false });
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver] });
    const res = await callTool(server, "reload_app", {});
    expect(res.content[0].text).toMatch(/still answering|may not have reloaded/i);
  }, 20000);

  it("reinstalls the error interceptor in the new runtime, not just the network one", async () => {
    await connect();
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver] });
    const before = evaluated.filter((e) => e.includes("__RNE_ERR_VERSION__")).length;
    await callTool(server, "reload_app", {});
    const after = evaluated.filter((e) => e.includes("__RNE_ERR_VERSION__")).length;
    // Field test D13: get_errors went blind after every reload_app because only
    // the network interceptor was re-evaluated in the new runtime.
    expect(after).toBeGreaterThan(before);
    expect(evaluated.filter((e) => e.includes("__RNE_NET_VERSION__")).length).toBeGreaterThan(1);
  });

  it("waits for the app to render before installing, so the bundle cannot overwrite the hooks", async () => {
    await connect();
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver] });
    await callTool(server, "reload_app", {});
    const readyAt = evaluated.findIndex((e) => e.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__"));
    const netAt = evaluated.map((e, i) => [e, i] as const)
      .filter(([e]) => e.includes("__RNE_NET_VERSION__")).map(([, i]) => i).pop()!;
    expect(readyAt).toBeGreaterThanOrEqual(0);
    expect(netAt).toBeGreaterThan(readyAt);
  });

  // Finding 1 (field test 2 review): installInterceptors() computes a fresh
  // interceptorStatus/errorInterceptorStatus after every reload, but reload_app
  // used to throw that information away and report unconditional success —
  // exactly the "failed capture reports itself as normal" bug this plan exists
  // to close. A CDP hiccup right after reload (evaluate() itself throwing) is
  // swallowed into "failed" by installInterceptors(), so that is what this
  // simulates for the network source.
  it("reload_app surfaces an unhealthy interceptor status left by installInterceptors", async () => {
    await connect();
    metro.setHandler("Runtime.evaluate", (p: any) => {
      const expr = String(p.expression);
      evaluated.push(expr);
      if (expr.includes("typeof globalThis.__RNE_SENTINEL")) return evalEnvelope("undefined");
      if (expr.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) return evalEnvelope(true);
      if (expr.includes("__RNE_NET_VERSION__")) return { result: { value: JSON.stringify({ s: "err", e: "boom" }) } };
      if (expr.includes("__RNE_ERR_VERSION__")) return evalEnvelope("ok");
      return evalEnvelope(true);
    });
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver] });
    const res = await callTool(server, "reload_app", {});
    expect(res.content[0].text).toMatch(/new JS runtime confirmed/i);
    expect(res.content[0].text).toMatch(/network interceptor/i);
    expect(res.content[0].text.toLowerCase()).toContain("failed");
  });

  it("reload_app composes the unhealthy-interceptor note with the readiness-timeout note", async () => {
    await connect();
    metro.setHandler("Runtime.evaluate", (p: any) => {
      const expr = String(p.expression);
      evaluated.push(expr);
      if (expr.includes("typeof globalThis.__RNE_SENTINEL")) return evalEnvelope("undefined");
      // React never confirms a renderer — waitForAppReady must time out.
      if (expr.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) return evalEnvelope(false);
      if (expr.includes("__RNE_NET_VERSION__")) return { result: { value: JSON.stringify({ s: "err", e: "boom" }) } };
      if (expr.includes("__RNE_ERR_VERSION__")) return evalEnvelope("ok");
      return evalEnvelope(true);
    });
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver] });
    const res = await callTool(server, "reload_app", {});
    const msg = res.content[0].text;
    expect(msg).toMatch(/did not confirm a renderer/i);
    expect(msg).toMatch(/network interceptor/i);
    expect(msg.toLowerCase()).toContain("failed");
    // Both facts must be reported — neither should read as if it were the
    // whole story (e.g. no claim of a healthy install once render is admitted
    // to have failed, and vice versa).
    expect(msg).not.toMatch(/^App reloaded \(new JS runtime confirmed\)\.$/);
    // Containing both fragments is not enough: they have to read coherently.
    // The network interceptor came back unhealthy, so the sentence must not
    // also claim network capture was installed — one clause asserting the
    // install while the next says it failed is the contradiction this guards.
    expect(msg).not.toMatch(/network\/error capture was \(re\)installed/);
    expect(msg).toMatch(/error capture was \(re\)installed anyway/);
  }, 10000);

  it("reload_app claims no install at all when both interceptors come back unhealthy", async () => {
    await connect();
    metro.setHandler("Runtime.evaluate", (p: any) => {
      const expr = String(p.expression);
      evaluated.push(expr);
      if (expr.includes("typeof globalThis.__RNE_SENTINEL")) return evalEnvelope("undefined");
      if (expr.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) return evalEnvelope(false);
      if (expr.includes("__RNE_NET_VERSION__")) return { result: { value: JSON.stringify({ s: "err", e: "boom" }) } };
      if (expr.includes("__RNE_ERR_VERSION__")) return { result: { value: JSON.stringify({ s: "err", e: "boom" }) } };
      return evalEnvelope(true);
    });
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver] });
    const msg = (await callTool(server, "reload_app", {})).content[0].text;
    expect(msg).toMatch(/did not confirm a renderer/i);
    expect(msg).not.toMatch(/capture was \(re\)installed/);
    expect(msg).toMatch(/no capture hook came back live/i);
    expect(msg).toMatch(/network interceptor/i);
    expect(msg).toMatch(/error interceptor/i);
  }, 10000);

  it("launch_app passes terminate_running and env through to the driver", async () => {
    const seen: any[] = [];
    const d = {
      ...driver,
      launchApp: async (_u: string, appId: string, o: any) => {
        seen.push([appId, o]);
      },
    } as unknown as DeviceDriver;
    const server = makeServer();
    registerDeviceTools(server, { drivers: [d] });
    await callTool(server, "launch_app", { app_id: "com.x.app", terminate_running: true, env: { FOO: "1" } });
    expect(seen[0]).toEqual(["com.x.app", { terminateRunning: true, env: { FOO: "1" } }]);
  });

  it("install_app rejects a missing path before touching the driver", async () => {
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver] });
    const res = await callTool(server, "install_app", { app_path: "/definitely/not/here.app" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/does not exist/i);
  });

  it("open_simulator runs open -a Simulator via the injected runner", async () => {
    const calls: string[] = [];
    const server = makeServer();
    registerDeviceTools(server, {
      drivers: [driver],
      runner: (async (cmd: string, args: string[]) => {
        calls.push(`${cmd} ${args.join(" ")}`);
        return { stdout: "", stdoutBuffer: Buffer.from(""), stderr: "" };
      }) as any,
    });
    const res = await callTool(server, "open_simulator", {});
    expect(res.isError).toBeFalsy();
    expect(calls).toContain("open -a Simulator");
  });
});

describe("open_url", () => {
  function urlDriver() {
    const seen: { udid: string; url: string }[] = [];
    const d = {
      ...driver,
      openUrl: async (udid: string, url: string) => {
        seen.push({ udid, url });
      },
    } as unknown as DeviceDriver;
    return { seen, d };
  }

  it("passes the url through to the driver", async () => {
    const { seen, d } = urlDriver();
    const server = makeServer();
    registerDeviceTools(server, { drivers: [d] });
    const res = await callTool(server, "open_url", { url: "demo://v/42" });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([{ udid: "A", url: "demo://v/42" }]);
  });

  it("refuses an empty url before touching the driver", async () => {
    const { seen, d } = urlDriver();
    const server = makeServer();
    registerDeviceTools(server, { drivers: [d] });
    const res = await callTool(server, "open_url", { url: "" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe(
      "Provide a URL with a scheme, e.g. myapp://home or an https:// link.",
    );
    expect(seen).toHaveLength(0);
  });

  it("refuses a url with no scheme", async () => {
    const { seen, d } = urlDriver();
    const server = makeServer();
    registerDeviceTools(server, { drivers: [d] });
    const res = await callTool(server, "open_url", { url: "example.com/home" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/URL with a scheme/);
    expect(seen).toHaveLength(0);
  });

  it("accepts any scheme — a custom app scheme is the whole point", async () => {
    const { seen, d } = urlDriver();
    const server = makeServer();
    registerDeviceTools(server, { drivers: [d] });
    const res = await callTool(server, "open_url", { url: "com.my-app.dev+1://deep/link?x=1" });
    expect(res.isError).toBeFalsy();
    expect(seen[0].url).toBe("com.my-app.dev+1://deep/link?x=1");
  });

  it("names the platform when the driver cannot open urls", async () => {
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver] });
    const res = await callTool(server, "open_url", { url: "demo://x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("open_url is not supported on ios.");
  });
});

describe("set_permission", () => {
  function permDriver(platform: "ios" | "android" = "ios") {
    const seen: string[][] = [];
    const d = {
      ...driver,
      platform,
      setPermission: async (udid: string, appId: string, service: string, status: string) => {
        seen.push([udid, appId, service, status]);
      },
    } as unknown as DeviceDriver;
    return { seen, d };
  }

  it("refuses without app_id when no app is connected", async () => {
    const { seen, d } = permDriver();
    const server = makeServer();
    registerDeviceTools(server, { drivers: [d] });
    const res = await callTool(server, "set_permission", { service: "camera", status: "grant" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("No app is connected — pass app_id.");
    expect(seen).toHaveLength(0);
  });

  it("passes an explicit app_id through and warns that a relaunch may be needed", async () => {
    const { seen, d } = permDriver();
    const server = makeServer();
    registerDeviceTools(server, { drivers: [d] });
    const res = await callTool(server, "set_permission", {
      service: "camera",
      status: "grant",
      app_id: "com.x.app",
    });
    expect(res.isError).toBeFalsy();
    expect(seen).toEqual([["A", "com.x.app", "camera", "grant"]]);
    expect(res.content[0].text).toMatch(/Granted camera for com\.x\.app/);
    expect(res.content[0].text).toMatch(/relaunch/i);
  });

  it("says that an Android reset is device-wide", async () => {
    const { d } = permDriver("android");
    const server = makeServer();
    registerDeviceTools(server, { drivers: [d] });
    const res = await callTool(server, "set_permission", {
      service: "camera",
      status: "reset",
      app_id: "com.x.app",
    });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/every app on the device/);
  });

  it("names the platform when the driver cannot set permissions", async () => {
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver] });
    const res = await callTool(server, "set_permission", {
      service: "camera",
      status: "grant",
      app_id: "com.x.app",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("set_permission is not supported on ios.");
  });
});

// Field test D26 (Android, slow emulator): the reload outlived reload_app's
// 6 s liveness guess. The tool said "may not have reloaded" although it had,
// nothing installed the interceptors in the runtime that came up later, and the
// app's own ErrorUtils.setGlobalHandler — run after ours — unplugged the error
// capture, so get_errors stayed empty under a redbox.
describe("reload_app on a slow reload (D26)", () => {
  async function until(cond: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  /**
   * A booted app runtime: RN's error-guard keeps the handler in a private slot
   * and calls that slot directly for an uncaught error, LogBox is the handler
   * InitializeCore installed, and React has registered a renderer.
   */
  function bootRuntime(): FakeRuntime {
    const rt = makeRuntime();
    rt.evaluate(`(function () {
      var slot = function (e) { (globalThis.__LOGBOX__ = globalThis.__LOGBOX__ || []).push(String(e && e.message)); };
      globalThis.ErrorUtils = {
        getGlobalHandler: function () { return slot; },
        setGlobalHandler: function (f) { slot = f; },
        reportFatalError: function (e) { slot(e, true); }
      };
      globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { renderers: new Map([[1, {}]]) };
    })()`);
    return rt;
  }

  /** Fake Metro whose Runtime.evaluate runs in whichever runtime is live. */
  async function appMetro(opts: { newRuntimeAfterMs: number }) {
    metro = await startFakeMetro({ port: 0 });
    let contextId = 1;
    const state: { live: FakeRuntime; next?: FakeRuntime } = { live: bootRuntime() };
    metro.setHandler("Runtime.enable", () => {
      metro.emit("Runtime.executionContextCreated", { context: { id: contextId, name: "main" } });
      return {};
    });
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Page.reload", () => {
      // The old runtime keeps answering while the device fetches and loads the
      // new bundle; the new one only shows up after that.
      setTimeout(() => {
        state.live = bootRuntime();
        state.next = state.live;
        contextId++;
        metro.emit("Runtime.executionContextsCleared", {});
        metro.emit("Runtime.executionContextCreated", { context: { id: contextId, name: "main" } });
      }, opts.newRuntimeAfterMs);
      return {};
    });
    metro.setHandler("Runtime.evaluate", (p: any) => {
      try {
        return { result: { value: state.live.evaluate(String(p.expression)) } };
      } catch (e) {
        return { exceptionDetails: { text: String(e) } };
      }
    });
    await getRegistry().connect({ port: metro.port });
    return state;
  }

  it("an error thrown after a late reload and a later app setGlobalHandler still reaches get_errors", async () => {
    // Scaled from the field: the new runtime answers after reload_app's wait
    // ran out (there 10 s vs 6 s, here 1.2 s vs 0.4 s).
    const state = await appMetro({ newRuntimeAfterMs: 1200 });
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver], reloadWaitMs: 400 });
    registerErrorTools(server);

    const reload = (await callTool(server, "reload_app", {})).content[0].text;
    expect(reload).toMatch(/still answering/i);

    // Nothing but the connection itself is watching when the runtime appears.
    await until(() => state.next?.sandbox.__RNE_ERR_INSTALLED__ === true);
    await new Promise((r) => setTimeout(r, 300));
    const rt = state.next!;

    // The app installs its own handler after ours (LogBox, a crash reporter)…
    rt.evaluate(`ErrorUtils.setGlobalHandler(function (e) { globalThis.__APP_SAW__ = (globalThis.__APP_SAW__ || 0) + 1; })`);
    // …and only then throws.
    rt.evaluate(`ErrorUtils.reportFatalError(new Error("rne-ft3-after-reload"))`);

    const res = await callTool(server, "get_errors", {});
    expect(res.content[0].text).toContain("rne-ft3-after-reload");
    // The app's handler still ran — its redbox is still painted.
    expect(rt.sandbox.__APP_SAW__).toBe(1);
  }, 15000);

  it("does not say 'may not have reloaded' once the execution context changed", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => {
      metro.emit("Runtime.executionContextCreated", { context: { id: 1, name: "main" } });
      return {};
    });
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Page.reload", () => {
      setTimeout(() => metro.emit("Runtime.executionContextCreated", { context: { id: 2, name: "main" } }), 50);
      return {};
    });
    // The sentinel never goes away here: identity, not the old runtime falling
    // silent, is what has to decide.
    metro.setHandler("Runtime.evaluate", (p: any) => {
      const expr = String(p.expression);
      if (expr.includes("typeof globalThis.__RNE_SENTINEL")) return evalEnvelope("number");
      return evalEnvelope(true);
    });
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver] });
    const msg = (await callTool(server, "reload_app", {})).content[0].text;
    expect(msg).not.toMatch(/may not have reloaded/i);
    expect(msg).toMatch(/new JS runtime/i);
  }, 20000);
});

// Field test D35 (RN 0.83 bridgeless, Android): Page.reload destroys the old
// context after ~0.8 s and creates the new one ~6.7 s later (9.6 s under load).
// reload_app's 6 s window always ran out first, and it answered "the old JS
// runtime is still answering" about a runtime that had been gone for 5 s.
describe("reload_app when the old runtime is destroyed before the new one exists (D35)", () => {
  /** Timeline of the measured target, scaled: gone after `goneMs`, back after `backMs` (never if undefined). */
  async function bridgelessMetro(t: { goneMs: number; backMs?: number }) {
    metro = await startFakeMetro({ port: 0 });
    let id = 4;
    let alive = true;
    metro.setHandler("Runtime.enable", () => {
      metro.emit("Runtime.executionContextCreated", { context: { id, name: "main", origin: "" } });
      return {};
    });
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Page.reload", () => {
      setTimeout(() => {
        alive = false;
        metro.emit("Runtime.executionContextDestroyed", { executionContextId: id });
        metro.emit("Runtime.executionContextsCleared", {});
      }, t.goneMs);
      if (t.backMs !== undefined) {
        setTimeout(() => {
          alive = true;
          id++;
          metro.emit("Runtime.executionContextCreated", { context: { id, name: "main", origin: "" } });
        }, t.backMs);
      }
      return {};
    });
    metro.setHandler("Runtime.evaluate", (p: any) => {
      if (!alive) return noRuntime();
      const expr = String(p.expression);
      // A new runtime has none of the old one's globals.
      if (expr.includes("typeof globalThis.__RNE_SENTINEL")) return evalEnvelope(id === 4 ? "number" : "undefined");
      if (expr.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) return evalEnvelope(true);
      if (expr.includes("__RNE_NET_VERSION__") || expr.includes("__RNE_ERR_VERSION__")) return evalEnvelope("ok");
      return evalEnvelope(true);
    });
    await getRegistry().connect({ port: metro.port });
  }

  it("waits past the old-runtime window for the new context and confirms it", async () => {
    // Scaled from the field: old-runtime window 0.4 s (6 s), gone at 0.1 s
    // (0.8 s), new context at 1.2 s (7.5 s).
    await bridgelessMetro({ goneMs: 100, backMs: 1200 });
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver], reloadWaitMs: 400 });
    const started = Date.now();
    const msg = (await callTool(server, "reload_app", {})).content[0].text;
    expect(msg).not.toMatch(/still answering/i);
    expect(msg).toMatch(/^App reloaded \(new JS runtime after \d+(\.\d)?s\)/);
    expect(msg).toMatch(/error and network capture reinstalled/);
    // Returns as soon as the new runtime is ready, not at the end of a budget.
    expect(Date.now() - started).toBeLessThan(5000);
  }, 15000);

  it("says the old runtime is gone, not 'still answering', when the new one does not start in time", async () => {
    await bridgelessMetro({ goneMs: 100 });
    const server = makeServer();
    registerDeviceTools(server, { drivers: [driver], reloadWaitMs: 300, reloadNewRuntimeWaitMs: 900 });
    const started = Date.now();
    const msg = (await callTool(server, "reload_app", {})).content[0].text;
    expect(Date.now() - started).toBeGreaterThanOrEqual(850);
    expect(msg).not.toMatch(/still answering/i);
    expect(msg).not.toMatch(/may not have reloaded/i);
    expect(msg).toMatch(/old JS runtime is gone/);
    expect(msg).toMatch(/new one has not started yet after \d+(\.\d)?s/);
    expect(msg).toMatch(/reinstalled automatically/);
  }, 15000);
});
