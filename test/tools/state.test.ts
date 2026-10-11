import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerStateTools } from "../../src/tools/state.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, type FakeMetro } from "../helpers/fakeCdp.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

describe("get_state / get_component_tree", () => {
  it("returns store state resolved by the snippet", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) => {
      if (String(p.expression).includes("__RNE_STORES__")) {
        return { result: { value: JSON.stringify({ found: true, value: { count: 1 } }) } };
      }
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerStateTools(server);
    const res = await callTool(server, "get_state", {});
    expect(res.content[0].text).toContain("count");
  });

  // Finding 3 (field test 2 review): the response's 4000-char cap can slice
  // off the app's own `truncated` flag before a caller ever sees it, so the
  // tool must tell the caller in plain response text — not just via a JSON
  // field the cap might have already destroyed. `truncated` is placed last
  // here (as componentTreeExpression used to emit it, and could again from
  // some other runtime) specifically so a "slice first, inspect what's left"
  // implementation cannot find it.
  it("get_component_tree tells the caller in plain text that the tree was truncated, even though the flag itself gets sliced off the wire", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    const bigRoots = Array.from({ length: 400 }, (_, i) => ({
      name: "Item" + i,
      testID: "some-fairly-long-test-id-" + i,
    }));
    const rawPayload = JSON.stringify({ available: true, roots: bigRoots, truncated: true });
    expect(rawPayload.length).toBeGreaterThan(4000);
    metro.setHandler("Runtime.evaluate", (p) => {
      if (String(p.expression).includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) {
        return { result: { value: rawPayload } };
      }
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerStateTools(server);
    const res = await callTool(server, "get_component_tree", {});
    // A caller must not have to parse (possibly invalid) JSON to learn this —
    // the response text itself must say so, plainly, and say what to do.
    expect(res.content[0].text).toMatch(/truncat/i);
    expect(res.content[0].text).toMatch(/max_depth/i);
  });

  it("component tree reports when hook is unavailable", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) => {
      if (String(p.expression).includes("__REACT_DEVTOOLS_GLOBAL_HOOK__")) {
        return { result: { value: JSON.stringify({ available: false, hint: "no hook" }) } };
      }
      return { result: { value: undefined } };
    });
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerStateTools(server);
    const res = await callTool(server, "get_component_tree", {});
    expect(res.content[0].text).toMatch(/no hook|not present|unavailable/i);
  });
});
