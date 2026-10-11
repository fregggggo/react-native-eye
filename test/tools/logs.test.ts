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

  it("errors when not connected", async () => {
    getRegistry().reset();
    const server = makeServer();
    registerLogTools(server);
    const res = await callTool(server, "get_logs", {});
    expect(res.isError).toBe(true);
  });
});
