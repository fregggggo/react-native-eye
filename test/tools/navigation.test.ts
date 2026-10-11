import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerNavigationTools, formatNavStack } from "../../src/tools/navigation.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, type FakeMetro } from "../helpers/fakeCdp.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

// Answers every evaluate with one canned payload — the snippets themselves are
// covered in test/state/navSnippets.test.ts, so what matters here is how the
// tool turns that payload into a response.
async function serverAnswering(payload: unknown) {
  metro = await startFakeMetro({ port: 0 });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", () => ({
    result: { value: typeof payload === "string" ? payload : JSON.stringify(payload) },
  }));
  await getRegistry().connect({ port: metro.port });
  const server = makeServer();
  registerNavigationTools(server);
  return server;
}

const NESTED = {
  type: "stack",
  index: 0,
  routes: [
    {
      name: "Tabs",
      state: {
        type: "tab",
        index: 1,
        routes: [
          { name: "Home" },
          {
            name: "HomeStack",
            state: { type: "stack", index: 1, routes: [{ name: "Feed" }, { name: "Post", params: { id: 42 } }] },
          },
        ],
      },
    },
  ],
};

describe("formatNavStack", () => {
  it("prints one line per nesting level, marking the focused route", () => {
    const out = formatNavStack(NESTED as any);
    expect(out).toContain("Root(stack): Tabs ←");
    expect(out).toContain("Root(stack) > Tabs(tab): Home, HomeStack ←");
    expect(out).toContain("Root(stack) > Tabs(tab) > HomeStack(stack): Feed, Post {id: 42} ←");
  });

  // The focused leaf is the one fact an agent reads most often, so it does not
  // have to be reconstructed from the arrows.
  it("names the focused leaf route first", () => {
    expect(formatNavStack(NESTED as any).split("\n")[0]).toBe("Current: Post {id: 42}");
  });

  it("reports a navigator that has no state yet", () => {
    expect(formatNavStack(undefined)).toMatch(/no state|not ready/i);
  });

  it("shows a params note instead of params when the app could not serialise them", () => {
    const out = formatNavStack({
      type: "stack",
      index: 0,
      routes: [{ name: "Post", paramsNote: "(unserialisable)" }],
    } as any);
    expect(out).toContain("(unserialisable)");
  });
});

describe("navigate tool", () => {
  it("action 'stack' reports the current stack", async () => {
    const server = await serverAnswering({ found: true, source: "fiber", ok: true, state: NESTED });
    const res = await callTool(server, "navigate", { action: "stack" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("Current: Post {id: 42}");
  });

  it("rejects navigate without a route name before touching the app", async () => {
    const server = await serverAnswering({ found: true, ok: true, state: NESTED });
    const res = await callTool(server, "navigate", { action: "navigate" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/name/i);
  });

  // react-navigation swallows an unknown route name into a console.error; the
  // snippet catches it and the tool must surface it, because it is the only
  // evidence the agent's navigate did nothing.
  it("surfaces react-navigation's unhandled-action message as an error", async () => {
    const server = await serverAnswering({
      found: true,
      ok: true,
      unhandled: "The action 'NAVIGATE' with payload {\"name\":\"Nope\"} was not handled by any navigator.",
      state: NESTED,
    });
    const res = await callTool(server, "navigate", { action: "navigate", name: "Nope" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("was not handled by any navigator");
  });

  it("explains how to fix a missing navigation container", async () => {
    const server = await serverAnswering({ found: false, reason: "no react-navigation container found in the React tree" });
    const res = await callTool(server, "navigate", { action: "back" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/container/i);
  });

  it("reports 'cannot go back' as a normal answer, not an error", async () => {
    const server = await serverAnswering({
      found: true,
      ok: true,
      note: "cannot go back — nothing below this screen in the navigator.",
      state: NESTED,
    });
    const res = await callTool(server, "navigate", { action: "back" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/cannot go back/i);
  });

  it("reports an action that threw inside the app as an app error", async () => {
    const server = await serverAnswering({ found: true, ok: false, error: "boom" });
    const res = await callTool(server, "navigate", { action: "navigate", name: "Post" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/boom/);
  });

  it("tolerates an answer that is not our JSON", async () => {
    const server = await serverAnswering("not json at all");
    const res = await callTool(server, "navigate", { action: "stack" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not json at all/);
  });
});
