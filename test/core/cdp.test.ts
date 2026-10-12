import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
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

  // React Native 0.86's inspector proxy answers 401 to a debugger socket whose
  // Origin is missing or not local (dev-middleware InspectorProxy verifyClient),
  // and Expo CLI drops the socket when the Origin's host differs from the Host
  // header. So the Origin has to be the socket URL's own.
  it.each(["localhost", "127.0.0.1"])("sends the socket's own origin (%s), as RN 0.86+ and Expo require", async (host) => {
    const origins: (string | undefined)[] = [];
    const wss = new WebSocketServer({
      port: 0,
      verifyClient: (info: { origin?: string; req: { headers: { host?: string } } }) => {
        origins.push(info.origin);
        if (!info.origin || !URL.canParse(info.origin)) return false;
        const url = new URL(info.origin);
        return ["localhost", "127.0.0.1", "0.0.0.0", "[::]", "[::1]"].includes(url.hostname) && url.host === info.req.headers.host;
      },
    });
    await new Promise((r) => wss.once("listening", r));
    const { port } = wss.address() as AddressInfo;
    try {
      client = new CdpClient(`ws://${host}:${port}/inspector/debug?device=d&page=1`);
      await client.connect();
      expect(origins).toEqual([`http://${host}:${port}`]);
    } finally {
      client.close();
      await new Promise((r) => wss.close(r));
    }
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
