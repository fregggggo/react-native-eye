import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchTargets, pickHermesTarget, discoverMetro, symbolicate } from "../../src/core/metro.js";
import { startFakeMetro, type FakeMetro } from "../helpers/fakeCdp.js";

let metro: FakeMetro;
afterEach(async () => {
  await metro?.close();
});

describe("metro discovery", () => {
  it("fetchTargets returns [] for a dead port", async () => {
    expect(await fetchTargets(1)).toEqual([]);
  });

  it("fetchTargets parses /json/list", async () => {
    metro = await startFakeMetro({ port: 0, targets: [{ id: "a", title: "React Native" }] });
    const targets = await fetchTargets(metro.port);
    expect(targets[0].id).toBe("a");
  });

  it("pickHermesTarget prefers a Hermes VM target", () => {
    const pick = pickHermesTarget([
      { id: "1", title: "Other", webSocketDebuggerUrl: "ws://x/1" },
      { id: "2", title: "RN", webSocketDebuggerUrl: "ws://x/2", vm: "Hermes" },
    ]);
    expect(pick?.id).toBe("2");
  });

  it("pickHermesTarget falls back to first with a ws url", () => {
    const pick = pickHermesTarget([{ id: "9", title: "x", webSocketDebuggerUrl: "ws://x/9" }]);
    expect(pick?.id).toBe("9");
  });

  it("discoverMetro finds a running fake Metro on a scanned port", async () => {
    metro = await startFakeMetro({ port: 0 });
    const found = await discoverMetro({ ports: [metro.port] });
    expect(found).toHaveLength(1);
    expect(found[0].port).toBe(metro.port);
    expect(found[0].target.webSocketDebuggerUrl).toContain("ws://");
  });
});

describe("symbolicate", () => {
  afterEach(() => vi.unstubAllGlobals());

  const frames = [{ file: "http://localhost:8081/index.bundle", lineNumber: 10, column: 5, methodName: "App" }];

  it("posts { stack } to /symbolicate and returns the resolved stack", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({ stack: [{ file: "/src/App.tsx", lineNumber: 20, column: 3, methodName: "App" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const out = await symbolicate(8081, frames);
    expect(calls[0].url).toContain(":8081/symbolicate");
    expect(calls[0].body).toEqual({ stack: frames });
    expect(out?.[0].file).toBe("/src/App.tsx");
    expect(out?.[0].lineNumber).toBe(20);
  });

  it("returns undefined on a non-200 response", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    expect(await symbolicate(8081, frames)).toBeUndefined();
  });

  it("returns undefined when the response is unparsable", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 200 }));
    expect(await symbolicate(8081, frames)).toBeUndefined();
  });

  it("returns undefined when the stack comes back a different length", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ stack: [] }), { status: 200 }));
    expect(await symbolicate(8081, frames)).toBeUndefined();
  });

  it("returns undefined on a network error instead of throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await symbolicate(8081, frames)).toBeUndefined();
  });

  it("makes no request for an empty frame list", async () => {
    let called = false;
    vi.stubGlobal("fetch", async () => {
      called = true;
      return new Response("{}", { status: 200 });
    });
    expect(await symbolicate(8081, [])).toEqual([]);
    expect(called).toBe(false);
  });
});
