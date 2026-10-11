import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerCheckStateTools } from "../../src/composite/checkState.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, type FakeMetro } from "../helpers/fakeCdp.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

describe("check_state", () => {
  it("bundles route, state, and errors", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) => {
      const e = String(p.expression);
      if (e.includes("__RNE_ROUTE__")) return { result: { value: JSON.stringify({ route: "Home" }) } };
      if (e.includes("__RNE_STORES__")) return { result: { value: JSON.stringify({ found: true, value: { n: 5 } }) } };
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    getRegistry().active().errors.push({ seq: 1, kind: "exception", text: "oops", timestamp: 1 });
    const server = makeServer();
    registerCheckStateTools(server);
    const res = await callTool(server, "check_state", {});
    expect(res.content[0].text).toContain("Home");
    expect(res.content[0].text).toContain('"n":5');
    expect(res.content[0].text).toContain("oops");
  });

  // D3: a redbox LogBox swallowed is invisible to CDP, so check_state has to
  // pull it from the app before it can honestly say "none".
  it("reports a redbox the app captured", async () => {
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
    registerCheckStateTools(server);
    const res = await callTool(server, "check_state", {});
    expect(res.content[0].text).toContain("rne-uncaught-probe");
  });
  // Field test D26: an error interceptor the app unplugged stays dead until
  // something re-evaluates its source; check_state reports "none" otherwise.
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
    const at = evaluated.length;
    const server = makeServer();
    registerCheckStateTools(server);
    await callTool(server, "check_state", {});
    const calls = evaluated.slice(at);
    const reassert = calls.findIndex((e) => e.includes("__RNE_ERR_VERSION__"));
    const drain = calls.findIndex((e) => e.includes("splice(0, b.length)"));
    expect(reassert).toBeGreaterThanOrEqual(0);
    expect(reassert).toBeLessThan(drain);
  });
  it("marks an error that was captured before the app reloaded", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({ result: { value: undefined } }));
    const conn = await getRegistry().connect({ port: metro.port });
    conn.errors.push({ seq: 1, kind: "redbox", text: "Error: stale", timestamp: 1, runtime: conn.runtimeGeneration });
    conn.markRuntimeReplaced();
    const server = makeServer();
    registerCheckStateTools(server);
    const res = await callTool(server, "check_state", {});
    expect(res.content[0].text).toContain("[redbox] Error: stale (before reload)");
  });
});
