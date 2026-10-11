import { describe, it, expect, afterEach } from "vitest";
import { CdpClient } from "../../src/core/cdp.js";
import { startFakeMetro, NO_REPLY, type FakeMetro } from "../helpers/fakeCdp.js";

let metro: FakeMetro;
let client: CdpClient;
afterEach(async () => {
  client?.close();
  await metro?.close();
});

describe("CdpClient", () => {
  it("connects and round-trips a command", async () => {
    metro = await startFakeMetro({
      port: 0,
      handlers: { "Runtime.evaluate": (p) => ({ echoed: p.expression }) },
    });
    client = new CdpClient(metro.wsUrl);
    await client.connect();
    const result = await client.send("Runtime.evaluate", { expression: "1+1" });
    expect(result.echoed).toBe("1+1");
    expect(client.connected).toBe(true);
  });

  it("delivers unsolicited events to subscribers", async () => {
    metro = await startFakeMetro({ port: 0 });
    client = new CdpClient(metro.wsUrl);
    await client.connect();
    const got = new Promise<any>((resolve) => client.on("Runtime.consoleAPICalled", resolve));
    metro.emit("Runtime.consoleAPICalled", { type: "log", args: [] });
    expect((await got).type).toBe("log");
  });

  it("rejects send() after close with ConnectionError", async () => {
    metro = await startFakeMetro({ port: 0 });
    client = new CdpClient(metro.wsUrl);
    await client.connect();
    client.close();
    await expect(client.send("Runtime.evaluate", {})).rejects.toThrow(/not connected|closed/i);
  });

  it("connect rejects on an unreachable url", async () => {
    client = new CdpClient("ws://127.0.0.1:1/nope");
    await expect(client.connect()).rejects.toThrow();
  });
});

describe("CdpClient timeouts", () => {
  it("rejects instead of hanging when the app never answers", async () => {
    // A blocked JS thread is exactly the case this server is used to debug.
    metro = await startFakeMetro({ port: 0, handlers: {} });
    metro.setHandler("Runtime.evaluate", () => NO_REPLY);
    client = new CdpClient(metro.wsUrl);
    await client.connect();
    await expect(client.send("Runtime.evaluate", { expression: "x" }, { timeoutMs: 120 })).rejects.toThrow(
      /timed out after 120ms.*JS thread may be blocked/s,
    );
  });
});
