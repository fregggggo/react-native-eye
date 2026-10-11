import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startFakeMetro, type FakeMetro } from "./fakeCdp.js";

let metro: FakeMetro;
afterEach(async () => {
  await metro?.close();
});

describe("fake Metro/CDP harness", () => {
  it("serves /json/list with a target", async () => {
    metro = await startFakeMetro({ port: 0, targets: [{ id: "1", title: "React Native" }] });
    const res = await fetch(`http://127.0.0.1:${metro.port}/json/list`);
    const list = await res.json();
    expect(list[0].title).toBe("React Native");
    expect(list[0].webSocketDebuggerUrl).toContain("ws://");
  });

  it("answers a CDP command with a matching id", async () => {
    metro = await startFakeMetro({
      port: 0,
      handlers: { "Runtime.evaluate": () => ({ result: { value: 42 } }) },
    });
    const ws = new WebSocket(metro.wsUrl);
    await new Promise((r) => ws.on("open", r));
    const reply = await new Promise<any>((resolve) => {
      ws.on("message", (d) => resolve(JSON.parse(d.toString())));
      ws.send(JSON.stringify({ id: 7, method: "Runtime.evaluate", params: {} }));
    });
    expect(reply).toEqual({ id: 7, result: { result: { value: 42 } } });
    ws.close();
  });
});
