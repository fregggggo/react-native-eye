import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerLogTools } from "../../src/tools/logs.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, type FakeMetro } from "../helpers/fakeCdp.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

async function connect(): Promise<void> {
  metro = await startFakeMetro({ port: 0 });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", () => ({ result: { value: undefined } }));
  await getRegistry().connect({ port: metro.port });
}

describe("get_logs", () => {
  it("returns 'No logs' when empty", async () => {
    await connect();
    const server = makeServer();
    registerLogTools(server);
    const res = await callTool(server, "get_logs", {});
    expect(res.content[0].text).toMatch(/no logs/i);
  });

  it("filters by level and search", async () => {
    await connect();
    const conn = getRegistry().active();
    conn.logs.push({ seq: 1, level: "log", text: "hello world", timestamp: 1 });
    conn.logs.push({ seq: 2, level: "error", text: "boom failure", timestamp: 2 });
    const server = makeServer();
    registerLogTools(server);
    const byLevel = await callTool(server, "get_logs", { level: "error" });
    expect(byLevel.content[0].text).toContain("boom failure");
    expect(byLevel.content[0].text).not.toContain("hello world");
    const bySearch = await callTool(server, "get_logs", { search: "hello" });
    expect(bySearch.content[0].text).toContain("hello world");
  });

  it("masks secrets, explains the mask, and does not let search probe them", async () => {
    await connect();
    const conn = getRegistry().active();
    conn.logs.push({ seq: 1, level: "log", text: `login {"accessToken":"abc123def456","user":"anna"}`, timestamp: 1 });
    const server = makeServer();
    registerLogTools(server);
    const res = await callTool(server, "get_logs", {});
    expect(res.content[0].text).toMatch(/"accessToken":"\[redacted:[0-9a-f]{6}\]","user":"anna"/);
    expect(res.content[0].text).not.toContain("abc123def456");
    expect(res.content[0].text).toContain("1 secret-looking value masked");
    const probe = await callTool(server, "get_logs", { search: "abc123" });
    expect(probe.content[0].text).toMatch(/no logs/i);
    process.env.RNE_SHOW_SECRETS = "1";
    try {
      const shown = await callTool(server, "get_logs", {});
      expect(shown.content[0].text).toContain("abc123def456");
      expect(shown.content[0].text).not.toContain("masked");
    } finally {
      delete process.env.RNE_SHOW_SECRETS;
    }
  });

  it("still answers from what was captured when the app is gone", async () => {
    const targets: any[] = [{ id: "t1", title: "App", deviceName: "iPhone 16" }];
    metro = await startFakeMetro({ port: 0, targets });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", () => ({ result: { value: undefined } }));
    const conn = await getRegistry().connect({ port: metro.port });
    metro.emit("Runtime.consoleAPICalled", { type: "error", args: [{ type: "string", value: "about to crash" }] });
    await new Promise((r) => setTimeout(r, 20));
    // The app crashed: its socket closed and Metro lists nothing any more.
    targets.length = 0;
    conn.close();
    await new Promise((r) => setTimeout(r, 20));
    const server = makeServer();
    registerLogTools(server);
    const res = await callTool(server, "get_logs", {});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("[error] about to crash");
    expect(res.content[0].text).toMatch(/not connected — .*was lost.*captured before the connection dropped/s);
  });

  it("errors when not connected", async () => {
    getRegistry().reset();
    const server = makeServer();
    registerLogTools(server);
    const res = await callTool(server, "get_logs", {});
    expect(res.isError).toBe(true);
  });
});
