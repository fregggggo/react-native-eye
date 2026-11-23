import { describe, it, expect } from "vitest";
import { Connection } from "../../src/core/registry.js";
import { evalWrapper, parseEnvelope, isPolyfilledPromiseShape, escapeSurrogates } from "../../src/core/evaluate.js";
import { makeRuntime, fakeClient } from "../helpers/rnRuntime.js";

function connectionOn(runtime: ReturnType<typeof makeRuntime>, onSend?: (m: string) => void): Connection {
  return new Connection(fakeClient(runtime, { onSend }) as any, { port: 0, targetId: "t", title: "fake" });
}

describe("Connection.evaluate against a polyfilled-Promise runtime", () => {
  it("returns the resolved value, not the promise's internals", async () => {
    const runtime = makeRuntime();
    // What the old implementation got back, and handed to callers as a value:
    const rawPromise: any = runtime.evaluate("Promise.resolve('AWAITED_OK')");
    expect(Object.keys(rawPromise)).toEqual(expect.arrayContaining(["_h", "_i", "_j", "_k"]));

    const conn = connectionOn(runtime);
    await expect(conn.evaluate("Promise.resolve('AWAITED_OK')")).resolves.toBe("AWAITED_OK");
  });

  it("waits for a promise that settles later", async () => {
    const runtime = makeRuntime();
    const conn = connectionOn(runtime);
    const value = await conn.evaluate(
      "new Promise(function (r) { setTimeout(function () { r('LATE'); }, 120); })",
    );
    expect(value).toBe("LATE");
  });

  it("costs a single round trip for a synchronous expression", async () => {
    const runtime = makeRuntime();
    let evaluates = 0;
    const conn = connectionOn(runtime, (m) => {
      if (m === "Runtime.evaluate") evaluates++;
    });
    await expect(conn.evaluate("1 + 1")).resolves.toBe(2);
    expect(evaluates).toBe(1);
  });

  it("propagates a rejected promise as an error", async () => {
    const runtime = makeRuntime();
    const conn = connectionOn(runtime);
    await expect(conn.evaluate("Promise.reject(new Error('boom'))")).rejects.toThrow(/boom/);
  });

  it("propagates a synchronous throw as an error", async () => {
    const runtime = makeRuntime();
    const conn = connectionOn(runtime);
    await expect(conn.evaluate("(function () { throw new Error('sync boom'); })()")).rejects.toThrow(/sync boom/);
  });

  it("supports statements, not just expressions", async () => {
    const runtime = makeRuntime();
    const conn = connectionOn(runtime);
    await expect(conn.evaluate("var a = 20; a * 2")).resolves.toBe(40);
  });

  it("times out instead of hanging when a promise never settles", async () => {
    const runtime = makeRuntime();
    const conn = connectionOn(runtime);
    await expect(conn.evaluate("new Promise(function () {})", { timeoutMs: 150 })).rejects.toThrow(
      /did not settle/i,
    );
  });

  it("reports the reload that wiped a pending evaluation", async () => {
    const runtime = makeRuntime();
    const conn = connectionOn(runtime);
    const pending = conn.evaluate("new Promise(function (r) { setTimeout(function(){ r(1); }, 500); })", {
      timeoutMs: 3000,
    });
    // A reload drops every global, including the slot the value was parked in.
    setTimeout(() => {
      runtime.sandbox.__RNE_EV__ = {};
    }, 30);
    await expect(pending).rejects.toThrow(/reloaded/i);
  });
});

describe("characters outside the BMP", () => {
  // Hermes' CDP agent re-encodes the source unit by unit, so a raw surrogate
  // pair failed to compile on a real RN 0.83 app ("Invalid UTF-8 code point").
  const SURROGATE = /[\uD800-\uDFFF]/;

  function recording(runtime: ReturnType<typeof makeRuntime>) {
    const sent: string[] = [];
    const replies: unknown[] = [];
    const client = fakeClient(runtime);
    const send = client.send.bind(client);
    client.send = async (method: string, params: any) => {
      if (method === "Runtime.evaluate") sent.push(params.expression);
      const res: any = await send(method, params);
      replies.push(res?.result?.value);
      return res;
    };
    return { conn: new Connection(client as any, { port: 0, targetId: "t", title: "fake" }), sent, replies };
  }

  it("sends an emoji in a string literal as escapes, and it still means the emoji", async () => {
    const runtime = makeRuntime();
    const { conn, sent } = recording(runtime);
    await expect(conn.evaluate(`"🐱".length`)).resolves.toBe(2);
    await expect(conn.evaluate("`cat: ${'🐱'}`")).resolves.toBe("cat: 🐱");
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) expect(s).not.toMatch(SURROGATE);
  });

  it("hands an emoji result back intact", async () => {
    const runtime = makeRuntime();
    const { conn, replies } = recording(runtime);
    await expect(conn.evaluate(`"🐱"`)).resolves.toBe("🐱");
    await expect(conn.evaluate(`Promise.resolve({ label: "go 🚀" })`)).resolves.toEqual({ label: "go 🚀" });
    // The app's own reply crosses the same agent, so it travels escaped too.
    for (const r of replies) if (typeof r === "string") expect(r).not.toMatch(SURROGATE);
  });

  it("survives a lone surrogate instead of crashing", async () => {
    const runtime = makeRuntime();
    const { conn, sent } = recording(runtime);
    const lone = String.fromCharCode(0xd83d);
    await expect(conn.evaluate(`"${lone}".length`)).resolves.toBe(1);
    for (const s of sent) expect(s).not.toMatch(SURROGATE);
  });

  it("keeps an identity-escaped emoji and an escaped backslash apart", () => {
    // `"\🐱"` is the emoji itself; `"\\🐱"` is a backslash followed by it.
    expect(eval(escapeSurrogates(`"\\🐱"`))).toBe("🐱");
    expect(eval(escapeSurrogates(`"\\\\🐱"`))).toBe("\\🐱");
    expect(escapeSurrogates("plain ascii")).toBe("plain ascii");
  });
});

describe("evaluate protocol helpers", () => {
  it("embeds the code as data, so quotes and newlines survive", () => {
    const wrapped = evalWrapper(`"a\n'b'"`);
    expect(wrapped).toContain(JSON.stringify(`"a\n'b'"`));
  });

  it("parses a bare (non-envelope) value as a plain result", () => {
    expect(parseEnvelope("hello")).toEqual({ s: "ok", v: "hello" });
    expect(parseEnvelope(42)).toEqual({ s: "ok", v: 42 });
  });

  it("recognises a serialised polyfill promise", () => {
    expect(isPolyfilledPromiseShape({ _h: 0, _i: 1, _j: "x", _k: null })).toBe(true);
    expect(isPolyfilledPromiseShape({ _h: 0, _i: 1, other: 1 })).toBe(false);
    expect(isPolyfilledPromiseShape({ value: 1 })).toBe(false);
    expect(isPolyfilledPromiseShape(null)).toBe(false);
  });
});
