import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerErrorTools } from "../../src/tools/errors.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, noRuntime, type FakeMetro } from "../helpers/fakeCdp.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

describe("get_errors", () => {
  it("lists captured errors", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({ result: { value: undefined } }));
    await getRegistry().connect({ port: metro.port });
    getRegistry().active().errors.push({ seq: 1, kind: "exception", text: "TypeError: x", timestamp: 1 });
    const server = makeServer();
    registerErrorTools(server);
    const res = await callTool(server, "get_errors", {});
    expect(res.content[0].text).toContain("TypeError: x");
    // G12/G13: the blind-spot boilerplate belongs on the empty answer only —
    // a real result must not carry it.
    expect(res.content[0].text).not.toMatch(/promise rejection/i);
  });

  // G12/G13: an unhandled Promise.reject reached neither get_errors nor
  // get_logs in the field test, while LogBox showed it on screen. Neither
  // kind can be intercepted without taking over a slot the app owns, so the
  // empty answer must name both instead of reading as "the app is fine".
  it("names what it cannot see when it has nothing to report and the interceptor is healthy", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({ result: { value: "ok" } }));
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerErrorTools(server);
    const res = await callTool(server, "get_errors", {});
    expect(res.content[0].text).toMatch(/promise rejection/i);
    expect(res.content[0].text).toMatch(/ErrorBoundary/i);
    // The blind-spot text is for the healthy case only — it must not blur
    // into (or replace) the unhealthy-interceptor warning.
    expect(res.content[0].text).not.toContain("error interceptor is");
  });

  // D3: the app captures what LogBox swallows; get_errors has to ask for it.
  it("pulls in a redbox the app captured before answering", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) =>
      String(p.expression).includes("__RNE_ERR__")
        ? {
            result: {
              value: JSON.stringify([
                { seq: 1, kind: "redbox", text: "Error: rne-uncaught-probe", timestamp: Date.now() },
              ]),
            },
          }
        : { result: { value: undefined } },
    );
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerErrorTools(server);
    const res = await callTool(server, "get_errors", {});
    expect(res.content[0].text).toContain("rne-uncaught-probe");
    expect(res.content[0].text).toContain("redbox");
  });

  it("re-asserts the error interceptor before draining", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    const evaluated: string[] = [];
    metro.setHandler("Runtime.evaluate", (p) => {
      evaluated.push(String(p.expression));
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    const atConnect = evaluated.length;
    const server = makeServer();
    registerErrorTools(server);
    await callTool(server, "get_errors", {});
    const calls = evaluated.slice(atConnect);
    const reassertIndex = calls.findIndex((e) => e.includes("__RNE_ERR_VERSION__"));
    // The drain expression's body is unique to it; the interceptor source
    // never contains it, so this can't be a false match.
    const drainIndex = calls.findIndex((e) => e.includes("splice(0, b.length)"));
    expect(reassertIndex).toBeGreaterThanOrEqual(0);
    expect(drainIndex).toBeGreaterThanOrEqual(0);
    // The re-assert must run before the drain, or a handler that drifted
    // mid-session is still dead for the very read meant to heal it.
    expect(reassertIndex).toBeLessThan(drainIndex);
  });

  it("heals a dead error interceptor mid-call and returns the error it starts capturing", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    // The drain only ever returns the captured error once the interceptor
    // source has actually been (re-)evaluated on *this* call — proving the
    // fix does something, not merely that a call was issued.
    let healed = false;
    metro.setHandler("Runtime.evaluate", (p) => {
      const expr = String(p.expression);
      if (expr.includes("__RNE_ERR_VERSION__")) {
        healed = true;
        return { result: { value: "ok" } };
      }
      if (expr.includes("splice(0, b.length)")) {
        return {
          result: {
            value: healed
              ? JSON.stringify([{ seq: 1, kind: "redbox", text: "Error: rne-healed-probe", timestamp: 1 }])
              : "[]",
          },
        };
      }
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    // Simulate the handler going dead again after connect: the buffer must
    // stay empty until get_errors's own re-assert flips it back.
    healed = false;
    const server = makeServer();
    registerErrorTools(server);
    const res = await callTool(server, "get_errors", {});
    expect(res.content[0].text).toContain("rne-healed-probe");
  });

  it("names the interceptor status when the drain comes back empty and it could not be confirmed healthy", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) =>
      String(p.expression).includes("__RNE_ERR_VERSION__")
        ? { result: { value: "failed" } }
        : { result: { value: undefined } },
    );
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerErrorTools(server);
    const res = await callTool(server, "get_errors", {});
    expect(res.content[0].text).toContain("No errors captured.");
    expect(res.content[0].text).toContain("failed");
    expect(res.content[0].text).toContain("reload_app");
    // The capture-may-be-broken warning is the more urgent message here; it
    // must not be diluted by (or share space with) the blind-spot boilerplate.
    expect(res.content[0].text).not.toMatch(/promise rejection/i);
    expect(res.content[0].text).not.toMatch(/ErrorBoundary/i);
  });

  it("re-asserts only the error interceptor, not the network interceptor", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    const evaluated: string[] = [];
    metro.setHandler("Runtime.evaluate", (p) => {
      evaluated.push(String(p.expression));
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    const atConnect = evaluated.length;
    const server = makeServer();
    registerErrorTools(server);
    await callTool(server, "get_errors", {});
    // get_errors has no interest in the network interceptor; re-asserting it
    // too would be a third CDP round-trip nobody asked for.
    expect(evaluated.slice(atConnect).some((e) => e.includes("__RNE_NET_VERSION__"))).toBe(false);
  });
});

describe("get_errors around a reload", () => {
  async function trackedMetro() {
    metro = await startFakeMetro({ port: 0 });
    let alive = true;
    let id = 1;
    metro.setHandler("Runtime.enable", () => {
      metro.emit("Runtime.executionContextCreated", { context: { id, name: "main" } });
      return {};
    });
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) => {
      if (!alive) return noRuntime();
      const expr = String(p.expression);
      if (expr.includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) return { result: { value: JSON.stringify({ s: "ok", v: true }) } };
      if (expr.includes("__RNE_ERR_VERSION__") || expr.includes("__RNE_NET_VERSION__")) return { result: { value: "ok" } };
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    return {
      gone() {
        alive = false;
        metro.emit("Runtime.executionContextDestroyed", { executionContextId: id });
        metro.emit("Runtime.executionContextsCleared", {});
      },
      back() {
        alive = true;
        id++;
        metro.emit("Runtime.executionContextCreated", { context: { id, name: "main" } });
      },
    };
  }
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Field test (verification, 6.4): an error from before the reload was listed
  // next to the new ones with nothing telling them apart.
  it("marks an error captured in a previous JS runtime", async () => {
    const t = await trackedMetro();
    metro.emit("Runtime.exceptionThrown", { exceptionDetails: { exception: { description: "Error: old-one" } } });
    await tick(20);
    t.gone();
    t.back();
    await tick(100);
    metro.emit("Runtime.exceptionThrown", { exceptionDetails: { exception: { description: "Error: new-one" } } });
    await tick(20);
    const server = makeServer();
    registerErrorTools(server);
    const lines = (await callTool(server, "get_errors", {})).content[0].text.split("\n");
    expect(lines.find((l: string) => l.includes("old-one"))).toMatch(/\(before reload\)/);
    expect(lines.find((l: string) => l.includes("new-one"))).not.toMatch(/before reload/);
  });

  // Field test D33: mid-reload the answer was "The error interceptor is failed
  // — capture may be incomplete; try reload_app." Reloading again is the one
  // thing that cannot help while a reload is in progress.
  it("does not advise reload_app while the runtime is between contexts", async () => {
    const t = await trackedMetro();
    t.gone();
    await tick(30);
    // The default wait fits a real bundle load; a test need not sit through it.
    getRegistry().active().contextWaitMs = 200;
    const server = makeServer();
    registerErrorTools(server);
    const msg = (await callTool(server, "get_errors", {})).content[0].text;
    expect(msg).not.toMatch(/try reload_app/);
    expect(msg).toMatch(/JS runtime is reloading/);
    expect(msg).toMatch(/retry in a few seconds/);
  });
});
