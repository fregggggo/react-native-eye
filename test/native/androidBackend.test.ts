import { describe, it, expect } from "vitest";
import { AndroidServerBackend } from "../../src/native/androidBackend.js";
import { NativeCallError } from "../../src/native/httpClient.js";

type Call = { method: string; path: string; body: unknown; timeoutMs: number };

function fakeAdb(forwardList: string | Error) {
  const calls: string[] = [];
  const deps = {
    adb: async (serial: string, args: string[]) => {
      calls.push(`${serial} ${args.join(" ")}`);
      if (forwardList instanceof Error) throw forwardList;
      return forwardList;
    },
    repairIme: async () => {},
  };
  return { deps, calls };
}

function fakeHttp(answer: (c: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  const http = {
    callJson: async (_port: number, method: "GET" | "POST", path: string, body: unknown, timeoutMs: number) => {
      const c = { method, path, body, timeoutMs };
      calls.push(c);
      const r = answer(c);
      if (r instanceof Error) throw r;
      return r as never;
    },
    callBytes: async (_port: number, path: string, timeoutMs: number) => {
      calls.push({ method: "GET", path, body: undefined, timeoutMs });
      return Buffer.from("png");
    },
  };
  return { http, calls };
}

describe("AndroidServerBackend", () => {
  it("sends pixel coordinates and ms durations, omitting durationMs for a plain tap", async () => {
    const f = fakeHttp();
    const b = new AndroidServerBackend(4000, "S", f.http, async () => {});
    await b.touch(10, 20);
    await b.touch(10, 20, 800);
    await b.swipe(1, 2, 3, 4, 300);
    expect(f.calls.map((c) => [c.path, c.body, c.timeoutMs])).toEqual([
      ["/touch", { x: 10, y: 20 }, 5000],
      ["/touch", { x: 10, y: 20, durationMs: 800 }, 5800],
      ["/swipe", { startX: 1, startY: 2, endX: 3, endY: 4, durationMs: 300 }, 5300],
    ]);
    expect(b.platform).toBe("android");
  });

  it("types ASCII through the server with a 250 ms/char budget, everything else through the IME", async () => {
    const f = fakeHttp();
    const typed: string[] = [];
    const b = new AndroidServerBackend(4000, "emulator-5554", f.http, async (serial, text) => {
      typed.push(`${serial}:${text}`);
    });
    await b.inputText("hello");
    await b.inputText("Привет, hello");
    expect(f.calls).toEqual([{ method: "POST", path: "/inputText", body: { text: "hello" }, timeoutMs: 5000 + 250 * 5 }]);
    expect(typed).toEqual(["emulator-5554:Привет, hello"]);
  });

  it("maps the other routes", async () => {
    const f = fakeHttp((c) =>
      c.path === "/isScreenStatic" ? { isScreenStatic: true } : c.path === "/status" ? { status: "ok", version: "v" } : {},
    );
    const b = new AndroidServerBackend(4000, "S", f.http, async () => {});
    await b.eraseText(3);
    await b.pressKey("back");
    await b.pressButton("lock");
    expect(await b.isScreenStatic()).toBe(true);
    expect(await b.screenshot()).toEqual(Buffer.from("png"));
    expect(await b.status()).toEqual({ status: "ok", version: "v" });
    await b.hierarchy();
    await b.deviceInfo();
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /eraseText", "POST /pressKey", "POST /pressButton", "GET /isScreenStatic",
      "GET /screenshot", "GET /status", "POST /viewHierarchy", "GET /deviceInfo",
    ]);
    expect(f.calls[0].body).toEqual({ charactersToErase: 3 });
  });

  const resetEverything = (c: Call) =>
    c.path === "/touch"
      ? new NativeCallError("lost", "POST /touch lost: ECONNRESET")
      : new NativeCallError("lost", "GET /status lost: ECONNRESET");

  it("re-checks a reset (lost, no timeout) with /status and the forward, and reports refused when only the server is gone", async () => {
    const f = fakeHttp(resetEverything);
    const a = fakeAdb(`S tcp:4000 localabstract:rneye-1\nOTHER tcp:4001 tcp:7311\n`);
    const b = new AndroidServerBackend(4000, "S", f.http, async () => {}, a.deps);
    const e = (await b.touch(1, 2).catch((x) => x)) as NativeCallError;
    expect(e.kind).toBe("refused");
    expect(e.code).toBe("forward_dead");
    expect(e.message).toMatch(/nothing answers behind the adb forward/);
    expect(f.calls.map((c) => c.path)).toEqual(["/touch", "/status"]);
    expect(a.calls).toEqual(["S forward --list"]);
  });

  it("keeps lost when the forward itself is gone (adb restarted, USB replug): the request may have run", async () => {
    for (const list of ["", "OTHER tcp:4000 tcp:7311\n", "S tcp:40001 tcp:7311\n", new Error("adb: device offline")]) {
      const f = fakeHttp(resetEverything);
      const b = new AndroidServerBackend(4000, "S", f.http, async () => {}, fakeAdb(list).deps);
      const e = (await b.touch(1, 2).catch((x) => x)) as NativeCallError;
      expect(e.kind).toBe("lost");
      expect(e.message).toMatch(/the adb forward is gone too/);
    }
  });

  it("keeps lost when /status still answers (the server is alive: delivery unknown)", async () => {
    const f = fakeHttp((c) => (c.path === "/touch" ? new NativeCallError("lost", "reset") : { status: "ok", version: "v" }));
    const b = new AndroidServerBackend(4000, "S", f.http, async () => {});
    expect(((await b.touch(1, 2).catch((x) => x)) as NativeCallError).kind).toBe("lost");
  });

  it("keeps a timeout lost without re-checking", async () => {
    const f = fakeHttp(() => new NativeCallError("lost", "no answer within 5000ms", undefined, "timeout"));
    const b = new AndroidServerBackend(4000, "S", f.http, async () => {});
    const e = (await b.touch(1, 2).catch((x) => x)) as NativeCallError;
    expect(e.kind).toBe("lost");
    expect(f.calls).toHaveLength(1);
  });

  it("passes refused, rejected and unsupported through unchanged", async () => {
    for (const kind of ["refused", "rejected", "unsupported"] as const) {
      const f = fakeHttp(() => new NativeCallError(kind, kind));
      const b = new AndroidServerBackend(4000, "S", f.http, async () => {});
      expect(((await b.swipe(0, 0, 1, 1, 100).catch((x) => x)) as NativeCallError).kind).toBe(kind);
      expect(f.calls).toHaveLength(1);
    }
  });

  it("runs the calls that take the server's route lock one at a time, each budget starting when it runs", async () => {
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const http = {
      callJson: (_port: number, _m: string, path: string) => {
        started.push(path);
        if (path === "/status" || path === "/deviceInfo") return Promise.resolve({} as never);
        return new Promise<never>((resolve) => finish.set(path, () => resolve({} as never)));
      },
      callBytes: (_port: number, path: string) => {
        started.push(path);
        return new Promise<Buffer>((resolve) => finish.set(path, () => resolve(Buffer.from("png"))));
      },
    };
    const b = new AndroidServerBackend(4000, "S", http as never, async () => {}, fakeAdb("").deps);
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const h = b.hierarchy();
    const shot = b.screenshot();
    const tap = b.touch(1, 2);
    await b.status();
    await b.deviceInfo();
    await tick();
    // /status and /deviceInfo take no lock on the server and skip the queue.
    expect([...started].sort()).toEqual(["/deviceInfo", "/status", "/viewHierarchy"]);
    finish.get("/viewHierarchy")!();
    await h;
    await tick();
    expect(started.slice(3)).toEqual(["/screenshot"]);
    finish.get("/screenshot")!();
    await shot;
    await tick();
    expect(started.slice(4)).toEqual(["/touch"]);
    finish.get("/touch")!();
    await tap;
  });

  it("a failed call does not hold up the queue", async () => {
    const f = fakeHttp((c) => (c.path === "/swipe" ? new NativeCallError("rejected", "no") : {}));
    const b = new AndroidServerBackend(4000, "S", f.http, async () => {}, fakeAdb("").deps);
    const [swipe, tap] = await Promise.allSettled([b.swipe(0, 0, 1, 1, 100), b.touch(1, 2)]);
    expect(swipe.status).toBe("rejected");
    expect(tap.status).toBe("fulfilled");
  });

  it("repairs the keyboard once per server, and never rejects", async () => {
    const serials: string[] = [];
    const repairIme = async (serial: string) => {
      serials.push(serial);
      throw new Error("adb: device offline");
    };
    const b = new AndroidServerBackend(4000, "emulator-5554", fakeHttp().http, async () => {}, { repairIme });
    await b.repairKeyboard();
    await b.repairKeyboard();
    expect(serials).toEqual(["emulator-5554"]);
  });
});
