import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { registerObserveTools } from "../../src/composite/observe.js";
import { getRegistry } from "../../src/core/registry.js";
import { makeServer, callTool } from "../helpers/callTool.js";
import { startFakeMetro, evalEnvelope, type FakeMetro } from "../helpers/fakeCdp.js";
import type { DeviceDriver } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";

let metro: FakeMetro;
beforeEach(() => getRegistry().reset());
afterEach(async () => {
  getRegistry().reset();
  await metro?.close();
});

const driver: DeviceDriver = {
  platform: "ios",
  listDevices: async () => [{ platform: "ios", udid: "u", name: "n", booted: true }],
  screenshotPng: async () => Buffer.from("IMG"),
  rawLayout: async () => axeLayout([{ text: "Home", x: 0, y: 0, w: 100, h: 40 }]),
  tapXY: async () => AXE,
  swipe: async () => AXE,
  typeText: async () => AXE,
  pressKey: async () => AXE,
  launchApp: async () => {},
};

async function connect() {
  metro = await startFakeMetro({ port: 0 });
  metro.setHandler("Runtime.enable", () => ({}));
  metro.setHandler("Log.enable", () => ({}));
  metro.setHandler("Runtime.evaluate", () => ({ result: { value: undefined } }));
  await getRegistry().connect({ port: metro.port });
}

describe("observe", () => {
  // D3: the ERRORS section said "none" while a full-screen redbox was up,
  // because LogBox swallows the exception before CDP can see it.
  it("shows a redbox the app captured instead of reporting none", async () => {
    metro = await startFakeMetro({ port: 0 });
    metro.setHandler("Runtime.enable", () => ({}));
    metro.setHandler("Log.enable", () => ({}));
    metro.setHandler("Runtime.evaluate", (p) =>
      String(p.expression).includes("__RNE_ERR__")
        ? evalEnvelope(
            JSON.stringify([
              { seq: 1, kind: "redbox", text: "Error: rne-uncaught-probe", timestamp: Date.now() },
            ]),
          )
        : evalEnvelope(undefined),
    );
    await getRegistry().connect({ port: metro.port });
    const server = makeServer();
    registerObserveTools(server, { drivers: [driver] });
    const res = await callTool(server, "observe", {});
    const body = res.content.map((c: any) => c.text ?? "").join("\n");
    expect(body).toContain("rne-uncaught-probe");
  });

  it("returns an image plus a layout/errors/logs text block", async () => {
    await connect();
    getRegistry().active().logs.push({ seq: 1, level: "log", text: "booted", timestamp: 1 });
    const server = makeServer();
    registerObserveTools(server, { drivers: [driver] });
    const res = await callTool(server, "observe", {});
    const kinds = res.content.map((c: any) => c.type);
    expect(kinds).toContain("image");
    const textBlock = res.content.find((c: any) => c.type === "text").text;
    expect(textBlock).toContain("Home @50,20");
    expect(textBlock).toContain("booted");
  });

  it("omits the image when screenshot:false", async () => {
    await connect();
    const server = makeServer();
    registerObserveTools(server, { drivers: [driver] });
    const res = await callTool(server, "observe", { screenshot: false });
    expect(res.content.every((c: any) => c.type !== "image")).toBe(true);
  });

  it("reports the layout source in the header", async () => {
    await connect();
    const server = makeServer();
    registerObserveTools(server, { drivers: [driver] });
    const res = await callTool(server, "observe", { screenshot: false });
    const textBlock = res.content.find((c: any) => c.type === "text").text;
    expect(textBlock).toMatch(/LAYOUT \((js|os)/);
  });
});

describe("observe resilience", () => {
  it("still returns the screenshot and logs when the layout capture fails", async () => {
    // A layout timeout used to take down the whole tool, exactly when the
    // screenshot and errors were most needed.
    await connect();
    getRegistry().active().logs.push({ seq: 1, level: "error", text: "boom", timestamp: 1 });
    const broken: DeviceDriver = {
      ...driver,
      rawLayout: async () => {
        throw new Error("axe timed out after 45000ms (killed)");
      },
    };
    const server = makeServer();
    registerObserveTools(server, { drivers: [broken] });
    const res = await callTool(server, "observe", {});
    expect(res.content.map((c: any) => c.type)).toContain("image");
    const textBlock = res.content.find((c: any) => c.type === "text").text;
    expect(textBlock).toMatch(/LAYOUT: \(unavailable: .*axe timed out/);
    expect(textBlock).toContain("boom");
  });

  it("works without a runtime connection, saying which sections need one", async () => {
    getRegistry().reset();
    const server = makeServer();
    registerObserveTools(server, { drivers: [driver] });
    const res = await callTool(server, "observe", {});
    const textBlock = res.content.find((c: any) => c.type === "text").text;
    expect(textBlock).toContain("Home @50,20");
    expect(textBlock).toMatch(/LOGS: \(no runtime connection/);
  });
});
