import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { getRegistry } from "../../src/core/registry.js";
import { startFakeMetro, evalEnvelope, noRuntime, NO_REPLY, type FakeMetro } from "../helpers/fakeCdp.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().active_or_null?.close?.();
  await metro?.close();
});

function withRuntime(m: FakeMetro) {
  m.setHandler("Runtime.enable", () => ({}));
  m.setHandler("Log.enable", () => ({}));
  m.setHandler("Runtime.evaluate", () => evalEnvelope(undefined));
}

describe("Registry", () => {
  it("active() throws before connect", () => {
    expect(() => getRegistry().active()).toThrow(/no active connection/i);
  });

  it("connect() establishes an active connection with meta", async () => {
    metro = await startFakeMetro({ port: 0, targets: [{ id: "t1", title: "MyApp" }] });
    withRuntime(metro);
    const conn = await getRegistry().connect({ port: metro.port });
    expect(conn.meta.port).toBe(metro.port);
    expect(conn.meta.title).toBe("MyApp");
    expect(getRegistry().active()).toBe(conn);
  });

  it("captures console logs pushed as CDP events", async () => {
    metro = await startFakeMetro({ port: 0 });
    withRuntime(metro);
    const conn = await getRegistry().connect({ port: metro.port });
    metro.emit("Runtime.consoleAPICalled", {
      type: "warn",
      args: [{ type: "string", value: "hello" }],
      timestamp: 123,
    });
    await new Promise((r) => setTimeout(r, 10));
    const last = conn.logs.last(1)[0];
    expect(last.level).toBe("warn");
    expect(last.text).toContain("hello");
  });

  it("captures exceptions as error entries", async () => {
    metro = await startFakeMetro({ port: 0 });
    withRuntime(metro);
    const conn = await getRegistry().connect({ port: metro.port });
    metro.emit("Runtime.exceptionThrown", {
      exceptionDetails: { text: "Uncaught", exception: { description: "TypeError: boom" } },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(conn.errors.last(1)[0].text).toContain("boom");
  });

  it("drainNetwork pulls interceptor entries into the ring buffer", async () => {
    metro = await startFakeMetro({ port: 0 });
    withRuntime(metro);
    const conn = await getRegistry().connect({ port: metro.port });
    metro.setHandler("Runtime.evaluate", (p) => {
      if (String(p.expression).includes("__RNE_NET__")) {
        return {
          result: {
            value: JSON.stringify([
              { seq: 1, method: "GET", url: "http://x", status: 200, timestamp: 1 },
            ]),
          },
        };
      }
      return { result: { value: undefined } };
    });
    await conn.drainNetwork();
    expect(conn.network.last(1)[0].url).toBe("http://x");
  });

  it("installs the error interceptor on connect", async () => {
    metro = await startFakeMetro({ port: 0 });
    const seen: string[] = [];
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) => {
      seen.push(String(p.expression));
      return evalEnvelope(undefined);
    });
    await getRegistry().connect({ port: metro.port });
    expect(seen.some((e) => e.includes("__RNE_ERR_INSTALLED__"))).toBe(true);
  });

  // A drain path only cares about its own source: get_network re-asserting the
  // error interceptor too (and vice versa) is a third CDP round-trip nobody
  // asked for. installInterceptors("network"/"errors") narrows to one.
  it("installInterceptors(only) re-asserts a single source and leaves the other status untouched", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    const seen: string[] = [];
    metro.setHandler("Runtime.evaluate", (p) => {
      const expr = String(p.expression);
      seen.push(expr);
      return evalEnvelope(expr.includes("__RNE_ERR_VERSION__") ? "unavailable" : "ok");
    });
    const conn = await getRegistry().connect({ port: metro.port });
    expect(conn.interceptorStatus).toBe("ok");
    expect(conn.errorInterceptorStatus).toBe("unavailable");

    const atConnect = seen.length;
    await conn.installInterceptors("network");
    const calls = seen.slice(atConnect);
    expect(calls.some((e) => e.includes("__RNE_NET_VERSION__"))).toBe(true);
    expect(calls.some((e) => e.includes("__RNE_ERR_VERSION__"))).toBe(false);
    // Skipping the error source must not reset or overwrite its recorded status.
    expect(conn.errorInterceptorStatus).toBe("unavailable");
  });

  // Field test D3: LogBox swallows the exception, so the redbox on screen never
  // reached CDP and get_errors answered "No errors captured".
  it("drainErrors pulls redbox entries the app captured into the ring buffer", async () => {
    metro = await startFakeMetro({ port: 0 });
    withRuntime(metro);
    const conn = await getRegistry().connect({ port: metro.port });
    metro.setHandler("Runtime.evaluate", (p) => {
      if (String(p.expression).includes("__RNE_ERR__")) {
        return evalEnvelope(
          JSON.stringify([
            { seq: 1, kind: "redbox", text: "Error: rne-uncaught-probe", stack: "at x", timestamp: 5 },
          ]),
        );
      }
      return evalEnvelope(undefined);
    });
    await conn.drainErrors();
    const last = conn.errors.last(1)[0];
    expect(last.kind).toBe("redbox");
    expect(last.text).toContain("rne-uncaught-probe");
  });

  // The app hands the entries over and forgets them, so a second drain that
  // returns nothing must not be treated as "the errors are gone".
  it("keeps the errors it already pulled when a later drain comes back empty", async () => {
    metro = await startFakeMetro({ port: 0 });
    withRuntime(metro);
    const conn = await getRegistry().connect({ port: metro.port });
    let handedOver = false;
    metro.setHandler("Runtime.evaluate", (p) => {
      if (String(p.expression).includes("__RNE_ERR__")) {
        if (handedOver) return evalEnvelope("[]");
        handedOver = true;
        return evalEnvelope(
          JSON.stringify([{ seq: 1, kind: "redbox", text: "Error: once", timestamp: 5 }]),
        );
      }
      return evalEnvelope(undefined);
    });
    await conn.drainErrors();
    await conn.drainErrors();
    expect(conn.errors.all()).toHaveLength(1);
  });

  // Without LogBox in the chain both paths fire for the same throw; the agent
  // must not be told the app failed twice.
  it("drainErrors skips an entry CDP already reported", async () => {
    metro = await startFakeMetro({ port: 0 });
    withRuntime(metro);
    const conn = await getRegistry().connect({ port: metro.port });
    metro.emit("Runtime.exceptionThrown", {
      exceptionDetails: { exception: { description: "Error: doubled" } },
    });
    await new Promise((r) => setTimeout(r, 10));
    metro.setHandler("Runtime.evaluate", (p) =>
      String(p.expression).includes("__RNE_ERR__")
        ? evalEnvelope(
            JSON.stringify([{ seq: 1, kind: "redbox", text: "Error: doubled", timestamp: Date.now() }]),
          )
        : evalEnvelope(undefined),
    );
    await conn.drainErrors();
    expect(conn.errors.all()).toHaveLength(1);
  });

  it("uses the default port when connect() is called without one", async () => {
    metro = await startFakeMetro({ port: 0 });
    withRuntime(metro);
    getRegistry().setDefaultPort(metro.port);
    const conn = await getRegistry().connect();
    expect(conn.meta.port).toBe(metro.port);
  });
});

describe("Registry connection lifecycle", () => {
  it("re-attaches transparently after the socket drops", async () => {
    metro = await startFakeMetro({ port: 0, targets: [{ id: "t1", title: "App" }] });
    withRuntime(metro);
    const first = await getRegistry().connect({ port: metro.port });
    first.close();
    await new Promise((r) => setTimeout(r, 20));
    // ensure() reconnects instead of telling the user to start Metro.
    const again = await getRegistry().ensure();
    expect(again.connected).toBe(true);
    expect(again.meta.port).toBe(metro.port);
  });

  it("never re-attaches to an app on another device when the bound one is gone (D39)", async () => {
    const targets: any[] = [{ id: "a1", title: "app (Pixel)", deviceName: "sdk_gphone64_arm64 - 16 - API 36" }];
    metro = await startFakeMetro({ port: 0, targets });
    withRuntime(metro);
    const first = await getRegistry().connect({ port: metro.port });
    // The Android app stops; the only target left on this Metro is another device's.
    targets.splice(0, 1, { id: "i1", title: "app (iPhone)", deviceName: "iPhone 17 Pro Max" });
    first.close();
    await new Promise((r) => setTimeout(r, 20));
    const err = await getRegistry().ensure().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/sdk_gphone64_arm64 - 16 - API 36/);
    expect(err.message).toMatch(/iPhone 17 Pro Max/);
    expect(err.message).toMatch(/connect/);
    expect(await getRegistry().optional()).toBeUndefined();
  });

  it("re-attaches to a new target id on the same device (reload gives a new id)", async () => {
    const targets: any[] = [{ id: "a1", title: "app", deviceName: "Pixel 8" }];
    metro = await startFakeMetro({ port: 0, targets });
    withRuntime(metro);
    const first = await getRegistry().connect({ port: metro.port });
    targets.splice(0, 1, { id: "i1", title: "other", deviceName: "iPhone 17" }, { id: "a2", title: "app", deviceName: "Pixel 8" });
    first.close();
    await new Promise((r) => setTimeout(r, 20));
    const again = await getRegistry().ensure();
    expect(again.meta.deviceName).toBe("Pixel 8");
    expect(again.meta.targetId).toBe("a2");
  });

  it("distinguishes 'never connected' from 'connection lost'", async () => {
    expect(() => getRegistry().active()).toThrow(/no active connection/i);
    metro = await startFakeMetro({ port: 0 });
    withRuntime(metro);
    await getRegistry().connect({ port: metro.port });
    await metro.close();
    await new Promise((r) => setTimeout(r, 20));
    await expect(getRegistry().ensure()).rejects.toThrow(/was lost/i);
  });

  it("carries the device name from the target so taps can be bound to it", async () => {
    metro = await startFakeMetro({
      port: 0,
      targets: [{ id: "t1", title: "app (iPhone 17)", deviceName: "iPhone 17", appId: "com.x" } as any],
    });
    withRuntime(metro);
    const conn = await getRegistry().connect({ port: metro.port });
    expect(conn.meta.deviceName).toBe("iPhone 17");
    expect(conn.meta.appId).toBe("com.x");
  });

  it("merges a late response body into the entry it belongs to", async () => {
    metro = await startFakeMetro({ port: 0 });
    withRuntime(metro);
    const conn = await getRegistry().connect({ port: metro.port });
    let phase = 0;
    metro.setHandler("Runtime.evaluate", (p) => {
      if (!String(p.expression).includes("__RNE_NET__")) return evalEnvelope(undefined);
      phase++;
      return evalEnvelope(
        JSON.stringify(
          phase === 1
            ? [{ seq: 1, method: "GET", url: "http://x", status: 200, bodyPending: true, timestamp: 1 }]
            : [{ seq: 1, method: "GET", url: "http://x", status: 200, responseBody: "late", timestamp: 1 }],
        ),
      );
    });
    await conn.drainNetwork();
    await conn.drainNetwork();
    expect(conn.network.all()).toHaveLength(1);
    expect(conn.network.all()[0].responseBody).toBe("late");
  });
});

describe("Connection.evaluate timeout budget", () => {
  // A background job passes a timeout far above DEFAULT_CDP_TIMEOUT_MS because
  // Hermes queues the message and runs it when the blocked thread frees. That
  // only works if `timeoutMs` bounds the initial Runtime.evaluate send too, not
  // just the slot polling — this asserts the send honours it (here by timing
  // out early, which the 15s CDP default would never do).
  it("applies the caller's timeout to the initial send, not just the polling", async () => {
    metro = await startFakeMetro({ port: 0 });
    withRuntime(metro);
    const conn = await getRegistry().connect({ port: metro.port });
    metro.setHandler("Runtime.evaluate", () => NO_REPLY);
    const started = Date.now();
    await expect(conn.evaluate("blocked()", { timeoutMs: 120 })).rejects.toThrow(/120ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("exposes socket close so long-lived work can react to a reload", async () => {
    metro = await startFakeMetro({ port: 0 });
    withRuntime(metro);
    const conn = await getRegistry().connect({ port: metro.port });
    let closed = false;
    conn.onClose(() => {
      closed = true;
    });
    conn.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(true);
  });
});

// Field test D26: the reload on a slow emulator outlived reload_app's wait, and
// nothing ever installed the interceptors in the runtime that came up later.
// The connection itself has to react to a new execution context, whenever it
// arrives — not only inside one tool's wait window.
describe("Connection reacts to a new JS runtime", () => {
  async function until(cond: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  function contextMetro(m: FakeMetro, seen: string[]) {
    // Hermes announces the live context in answer to Runtime.enable.
    m.setHandler("Runtime.enable", () => {
      m.emit("Runtime.executionContextCreated", { context: { id: 1, name: "main" } });
      return {};
    });
    m.setHandler("Log.enable", () => ({}));
    m.setHandler("Runtime.evaluate", (p) => {
      const expr = String(p.expression);
      seen.push(expr);
      if (expr.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) return evalEnvelope(true);
      return evalEnvelope("ok");
    });
  }

  it("does not treat the context announced on connect as a reload", async () => {
    metro = await startFakeMetro({ port: 0 });
    const seen: string[] = [];
    contextMetro(metro, seen);
    await getRegistry().connect({ port: metro.port });
    const atConnect = seen.filter((e) => e.includes("__RNE_NET_VERSION__")).length;
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.filter((e) => e.includes("__RNE_NET_VERSION__")).length).toBe(atConnect);
  });

  it("reinstalls both interceptors when the target reports a new execution context, with no tool call", async () => {
    metro = await startFakeMetro({ port: 0 });
    const seen: string[] = [];
    contextMetro(metro, seen);
    const conn = await getRegistry().connect({ port: metro.port });
    const at = seen.length;

    metro.emit("Runtime.executionContextsCleared", {});
    metro.emit("Runtime.executionContextCreated", { context: { id: 2, name: "main" } });

    await until(() => {
      const after = seen.slice(at);
      return after.some((e) => e.includes("__RNE_NET_VERSION__")) && after.some((e) => e.includes("__RNE_ERR_VERSION__"));
    });
    // The log stream now spans two runtimes; observe/get_logs say so.
    expect(conn.logs.gaps.length).toBeGreaterThan(0);
  });

  // The new runtime's request counter restarts at 1, while the drain watermark
  // still held the old runtime's last seq — so its first N requests (exactly
  // the startup ones) were filtered out, or merged into old entries by seq.
  it("drains the new runtime's requests although their seq restarted below the old watermark", async () => {
    metro = await startFakeMetro({ port: 0 });
    const seen: string[] = [];
    contextMetro(metro, seen);
    const conn = await getRegistry().connect({ port: metro.port });
    let runtime: "old" | "new" = "old";
    metro.setHandler("Runtime.evaluate", (p) => {
      const expr = String(p.expression);
      seen.push(expr);
      if (expr.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) return evalEnvelope(true);
      const m = /e\.seq > (\d+)/.exec(expr);
      if (m && expr.includes("__RNE_NET__") && !expr.includes("__RNE_NET_VERSION__")) {
        const since = Number(m[1]);
        const all =
          runtime === "old"
            ? [1, 2, 3].map((seq) => ({ seq, method: "GET", url: `http://old/${seq}`, status: 200, timestamp: 1 }))
            : [{ seq: 1, method: "GET", url: "http://new/startup", status: 200, timestamp: 2 }];
        return evalEnvelope(JSON.stringify(all.filter((e) => e.seq > since)));
      }
      return evalEnvelope("ok");
    });
    await conn.drainNetwork();
    expect(conn.network.all()).toHaveLength(3);

    runtime = "new";
    const at = seen.length;
    metro.emit("Runtime.executionContextsCleared", {});
    metro.emit("Runtime.executionContextCreated", { context: { id: 2, name: "main" } });
    await until(() => seen.slice(at).some((e) => e.includes("__RNE_NET_VERSION__")));

    await conn.drainNetwork();
    const urls = conn.network.all().map((e) => e.url);
    expect(urls).toContain("http://new/startup");
    expect(urls).toContain("http://old/1");
    // Distinct seqs, so get_network detail:<seq> can still tell them apart.
    const seqs = conn.network.all().map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("treats a cleared-then-recreated context as new even when the id is reused", async () => {
    metro = await startFakeMetro({ port: 0 });
    const seen: string[] = [];
    contextMetro(metro, seen);
    await getRegistry().connect({ port: metro.port });
    const at = seen.length;

    metro.emit("Runtime.executionContextsCleared", {});
    metro.emit("Runtime.executionContextCreated", { context: { id: 1, name: "main" } });

    await until(() => seen.slice(at).some((e) => e.includes("__RNE_ERR_VERSION__")));
  });
});

// Field test D33 (RN 0.83 bridgeless, Android): after Page.reload the old
// context is destroyed within ~1 s and the new one is created 7–10 s later. In
// between the target answers Runtime.evaluate with CDP -32601 ("Runtime.evaluate"),
// so every tool failed with a bare "Unexpected error: Runtime.evaluate".
describe("Connection.evaluate while the app is between JS runtimes", () => {
  /** A target that announces contexts and has none between `gone()` and `back()`. */
  async function reloadingMetro() {
    metro = await startFakeMetro({ port: 0 });
    let id = 1;
    let alive = true;
    const evaluated: string[] = [];
    metro.setHandler("Runtime.enable", () => {
      metro.emit("Runtime.executionContextCreated", { context: { id, name: "main" } });
      return {};
    });
    metro.setHandler("Log.enable", () => ({}));
    let died = false;
    metro.setHandler("Runtime.evaluate", (p) => {
      if (!alive) return noRuntime();
      const expr = String(p.expression);
      // The runtime is torn down while this very request is in flight: the
      // target announces it, then answers the request with -32601.
      if (expr.includes("dieUnderMe") && !died) {
        died = true;
        alive = false;
        metro.emit("Runtime.executionContextDestroyed", { executionContextId: id });
        metro.emit("Runtime.executionContextsCleared", {});
        return noRuntime();
      }
      evaluated.push(expr);
      if (expr.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) return evalEnvelope(true);
      if (expr.includes("__RNE_NET_VERSION__") || expr.includes("__RNE_ERR_VERSION__")) return evalEnvelope("ok");
      return evalEnvelope(42);
    });
    const conn = await getRegistry().connect({ port: metro.port });
    return {
      conn,
      evaluated,
      gone() {
        alive = false;
        metro.emit("Runtime.executionContextDestroyed", { executionContextId: id });
        metro.emit("Runtime.executionContextsCleared", {});
      },
      /** The runtime dies without the target saying so first. */
      goneSilently() {
        alive = false;
      },
      back() {
        alive = true;
        id++;
        metro.emit("Runtime.executionContextCreated", { context: { id, name: "main" } });
      },
    };
  }
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("waits for the new context and then runs, instead of failing", async () => {
    const t = await reloadingMetro();
    t.gone();
    await tick(30);
    setTimeout(() => t.back(), 300);
    const started = Date.now();
    await expect(t.conn.evaluate("probe()")).resolves.toBe(42);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it("says the runtime is reloading when the context is not back within the wait", async () => {
    const t = await reloadingMetro();
    t.gone();
    await tick(30);
    const started = Date.now();
    const err = await t.conn.evaluate("probe()", { timeoutMs: 200 }).catch((e) => e);
    expect(err.name).toBe("RuntimeError");
    expect(err.message).toMatch(/JS runtime is reloading \(no execution context yet\) — retry in a few seconds/);
    // Bounded by the caller's own budget — not the full default wait.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not make a second evaluate of the same tool call wait all over again", async () => {
    const t = await reloadingMetro();
    t.gone();
    await tick(30);
    await t.conn.evaluate("first()", { timeoutMs: 300 }).catch(() => {});
    const started = Date.now();
    const err = await t.conn.evaluate("second()", { timeoutMs: 300 }).catch((e) => e);
    expect(err.message).toMatch(/JS runtime is reloading/);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("retries an evaluate the runtime died under, once the new context is there", async () => {
    const t = await reloadingMetro();
    setTimeout(() => t.back(), 300);
    await expect(t.conn.evaluate("dieUnderMe()")).resolves.toBe(42);
    expect(t.evaluated.some((e) => e.includes("dieUnderMe"))).toBe(true);
  });

  it("maps the raw -32601 to the same message when the target never announced the gap", async () => {
    const t = await reloadingMetro();
    t.goneSilently();
    const err = await t.conn.evaluate("probe()").catch((e) => e);
    expect(err.name).toBe("RuntimeError");
    expect(err.message).not.toBe("Runtime.evaluate");
    expect(err.message).toMatch(/no execution context/);
    expect(err.message).toMatch(/retry in a few seconds/);
  });

  it("does not hang when the socket is gone too", async () => {
    const t = await reloadingMetro();
    t.gone();
    await tick(30);
    const pending = t.conn.evaluate("probe()").catch((e) => e);
    await tick(30);
    t.conn.close();
    const started = Date.now();
    const err = await pending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(err.name).toBe("ConnectionError");
  });

  it("stops waiting on a runtime that has been gone for a long time", async () => {
    const t = await reloadingMetro();
    t.gone();
    await tick(30);
    // As if the context was destroyed over a minute ago and never came back.
    (t.conn as any).contextGoneAt = Date.now() - 61_000;
    const started = Date.now();
    const err = await t.conn.evaluate("probe()").catch((e) => e);
    expect(Date.now() - started).toBeLessThan(500);
    expect(err.name).toBe("RuntimeError");
    expect(err.message).toMatch(/has not come back/);
  });
});
