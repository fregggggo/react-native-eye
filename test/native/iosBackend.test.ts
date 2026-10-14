import { describe, it, expect } from "vitest";
import { IosRunnerBackend } from "../../src/native/iosBackend.js";
import { CALL_TIMEOUTS } from "../../src/native/nativeBackend.js";
import { NativeCallError } from "../../src/native/httpClient.js";

type Call = { kind: "json" | "bytes"; port: number; method: string; path: string; body: unknown; timeoutMs: number };

function fakeHttp(answers: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const http = {
    callJson: async <T,>(port: number, method: "GET" | "POST", path: string, body: unknown, timeoutMs: number) => {
      calls.push({ kind: "json", port, method, path, body, timeoutMs });
      const a = answers[path];
      if (a instanceof Error) throw a;
      return a as T;
    },
    callBytes: async (port: number, path: string, timeoutMs: number) => {
      calls.push({ kind: "bytes", port, method: "GET", path, body: undefined, timeoutMs });
      const a = answers[path];
      if (a instanceof Error) throw a;
      return a as Buffer;
    },
  };
  return { http, calls };
}

describe("IosRunnerBackend", () => {
  it("is the ios platform and keeps its port", () => {
    const b = new IosRunnerBackend(4321, fakeHttp().http);
    expect(b.platform).toBe("ios");
    expect(b.port).toBe(4321);
  });

  it("status: GET /status with the status timeout", async () => {
    const { http, calls } = fakeHttp({ "/status": { status: "ok", version: "0.0.1-ab12cd34" } });
    const out = await new IosRunnerBackend(4321, http).status();
    expect(out).toEqual({ status: "ok", version: "0.0.1-ab12cd34" });
    expect(calls).toEqual([{ kind: "json", port: 4321, method: "GET", path: "/status", body: undefined, timeoutMs: 1000 }]);
  });

  it("hierarchy: POST /viewHierarchy {} with the hierarchy timeout", async () => {
    const tree = { axElement: { elementType: 1 }, depth: 3 };
    const { http, calls } = fakeHttp({ "/viewHierarchy": tree });
    expect(await new IosRunnerBackend(1, http).hierarchy()).toEqual(tree);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/viewHierarchy", body: {}, timeoutMs: 10_000 });
  });

  it("touch: POST /touch with points, no durationMs for a tap", async () => {
    const { http, calls } = fakeHttp();
    await new IosRunnerBackend(1, http).touch(50, 60);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/touch", body: { x: 50, y: 60 }, timeoutMs: 5000 });
    expect(calls[0].body).not.toHaveProperty("durationMs");
  });

  it("touch: long press sends durationMs in ms and adds it to the timeout", async () => {
    const { http, calls } = fakeHttp();
    await new IosRunnerBackend(1, http).touch(50, 60, 1500);
    expect(calls[0]).toMatchObject({ path: "/touch", body: { x: 50, y: 60, durationMs: 1500 }, timeoutMs: 6500 });
  });

  it("swipe: POST /swipe with start/end and durationMs, timeout 5s + duration", async () => {
    const { http, calls } = fakeHttp();
    await new IosRunnerBackend(1, http).swipe(10, 700, 10, 100, 300);
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/swipe",
      body: { startX: 10, startY: 700, endX: 10, endY: 100, durationMs: 300 },
      timeoutMs: 5300,
    });
  });

  it("inputText: POST /inputText {text}, timeout 5s + 100ms/char + 500ms first-char pause", async () => {
    const { http, calls } = fakeHttp();
    await new IosRunnerBackend(1, http).inputText("こんにちは");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/inputText", body: { text: "こんにちは" }, timeoutMs: 5000 + 500 + 500 });
  });

  it("inputText counts characters, not UTF-16 units", async () => {
    const { http, calls } = fakeHttp();
    await new IosRunnerBackend(1, http).inputText("😀a");
    expect(calls[0].timeoutMs).toBe(5000 + 200 + 500);
  });

  it("eraseText: POST /eraseText {charactersToErase}", async () => {
    const { http, calls } = fakeHttp();
    await new IosRunnerBackend(1, http).eraseText(12);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/eraseText", body: { charactersToErase: 12 }, timeoutMs: 5000 + 1200 });
  });

  it("pressKey and pressButton use the key timeout", async () => {
    const { http, calls } = fakeHttp();
    const b = new IosRunnerBackend(1, http);
    await b.pressKey("return");
    await b.pressButton("home");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/pressKey", body: { key: "return" }, timeoutMs: 5000 });
    expect(calls[1]).toMatchObject({ method: "POST", path: "/pressButton", body: { button: "home" }, timeoutMs: 5000 });
  });

  it("screenshot: GET /screenshot as bytes with the screenshot timeout", async () => {
    const png = Buffer.from([0x89, 0x50]);
    const { http, calls } = fakeHttp({ "/screenshot": png });
    expect(await new IosRunnerBackend(7, http).screenshot()).toBe(png);
    expect(calls).toEqual([{ kind: "bytes", port: 7, method: "GET", path: "/screenshot", body: undefined, timeoutMs: 10_000 }]);
  });

  it("isScreenStatic: GET /isScreenStatic and unwraps the boolean", async () => {
    const { http, calls } = fakeHttp({ "/isScreenStatic": { isScreenStatic: false } });
    expect(await new IosRunnerBackend(1, http).isScreenStatic()).toBe(false);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/isScreenStatic", timeoutMs: 5000 });
  });

  it("deviceInfo: GET /deviceInfo", async () => {
    const info = { widthPoints: 402, heightPoints: 874, widthPixels: 1206, heightPixels: 2622 };
    const { http, calls } = fakeHttp({ "/deviceInfo": info });
    expect(await new IosRunnerBackend(1, http).deviceInfo()).toEqual(info);
    expect(calls[0]).toMatchObject({ method: "GET", path: "/deviceInfo", timeoutMs: 2000 });
  });

  it("never sends appIds and never retries; NativeCallError passes through unchanged", async () => {
    const err = new NativeCallError("lost", "POST /touch lost: no answer within 5000ms");
    const { http, calls } = fakeHttp({ "/touch": err });
    await expect(new IosRunnerBackend(1, http).touch(1, 2)).rejects.toBe(err);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain("appId");
  });

  it("CALL_TIMEOUTS match the spec", () => {
    expect(CALL_TIMEOUTS).toEqual({
      status: 1000, touch: 5000, swipe: 5000, inputBase: 5000, inputPerChar: 100,
      hierarchy: 10000, screenshot: 10000, key: 5000, isScreenStatic: 5000, deviceInfo: 2000,
    });
  });
});
