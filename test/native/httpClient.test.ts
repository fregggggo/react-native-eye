import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { callJson, callBytes, NativeCallError } from "../../src/native/httpClient.js";

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

const servers: http.Server[] = [];

async function serve(handler: Handler): Promise<{ port: number; requests: () => number; lastBody: () => string }> {
  let count = 0;
  let last = "";
  const server = http.createServer((req, res) => {
    count++;
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      last = body;
      handler(req, body, res);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, requests: () => count, lastBody: () => last };
}

async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function failure(p: Promise<unknown>): Promise<NativeCallError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(NativeCallError);
    return e as NativeCallError;
  }
  throw new Error("expected the call to fail");
}

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

describe("callJson", () => {
  it("POSTs a JSON body and parses a JSON answer", async () => {
    const srv = await serve((req, _body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ method: req.method, url: req.url, type: req.headers["content-type"] }));
    });
    const out = await callJson<{ method: string; url: string; type: string }>(
      srv.port, "POST", "/touch", { x: 10, y: 20 }, 1000,
    );
    expect(out).toEqual({ method: "POST", url: "/touch", type: "application/json" });
    expect(JSON.parse(srv.lastBody())).toEqual({ x: 10, y: 20 });
  });

  it("M-4: every POST carries Content-Type: application/json, even without a body", async () => {
    const srv = await serve((req, _body, res) => res.end(JSON.stringify({ type: req.headers["content-type"] ?? null })));
    expect(await callJson(srv.port, "POST", "/viewHierarchy", undefined, 1000)).toEqual({ type: "application/json" });
    expect(await callJson(srv.port, "POST", "/viewHierarchy", {}, 1000)).toEqual({ type: "application/json" });
  });

  it("sends no body on GET", async () => {
    const srv = await serve((_req, _body, res) => res.end(JSON.stringify({ status: "ok", version: "v1" })));
    const out = await callJson(srv.port, "GET", "/status", undefined, 1000);
    expect(out).toEqual({ status: "ok", version: "v1" });
    expect(srv.lastBody()).toBe("");
  });

  it("returns undefined for an empty 200 body", async () => {
    const srv = await serve((_req, _body, res) => res.end());
    expect(await callJson(srv.port, "POST", "/touch", { x: 1, y: 2 }, 1000)).toBeUndefined();
  });

  it("reports refused when nothing listens on the port", async () => {
    const port = await closedPort();
    const e = await failure(callJson(port, "POST", "/touch", { x: 1, y: 2 }, 1000));
    expect(e.kind).toBe("refused");
    expect(e.message).toContain(String(port));
  });

  it("reports lost when the server accepts the request and never answers", async () => {
    const srv = await serve(() => {
      /* never respond */
    });
    const started = Date.now();
    const e = await failure(callJson(srv.port, "POST", "/touch", { x: 1, y: 2 }, 200));
    expect(e.kind).toBe("lost");
    expect(e.message).toMatch(/200ms/);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(srv.requests()).toBe(1);
  });

  it("reports lost when the server drops the socket after reading the body", async () => {
    const srv = await serve((req) => req.socket.destroy());
    const e = await failure(callJson(srv.port, "POST", "/swipe", { startX: 1 }, 1000));
    expect(e.kind).toBe("lost");
    expect(srv.requests()).toBe(1);
  });

  it("reports unsupported for 501 with code unsupported and keeps the runner's message", async () => {
    const srv = await serve((_req, _body, res) => {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "unsupported", errorMessage: "XCPointerEventPath" }));
    });
    const e = await failure(callJson(srv.port, "POST", "/swipe", {}, 1000));
    expect(e.kind).toBe("unsupported");
    expect(e.status).toBe(501);
    expect(e.code).toBe("unsupported");
    expect(e.message).toBe("XCPointerEventPath");
  });

  it("reports rejected for a 400 with the runner's errorMessage", async () => {
    const srv = await serve((_req, _body, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "precondition", errorMessage: "no focused text field" }));
    });
    const e = await failure(callJson(srv.port, "POST", "/inputText", { text: "a" }, 1000));
    expect(e.kind).toBe("rejected");
    expect(e.status).toBe(400);
    expect(e.code).toBe("precondition");
    expect(e.message).toBe("no focused text field");
  });

  it("reports rejected for a 500, and for a 501 whose code is not unsupported", async () => {
    const a = await serve((_req, _body, res) => {
      res.writeHead(500);
      res.end(JSON.stringify({ code: "internal", errorMessage: "snapshot failed" }));
    });
    const e1 = await failure(callJson(a.port, "POST", "/viewHierarchy", {}, 1000));
    expect(e1.kind).toBe("rejected");
    expect(e1.message).toBe("snapshot failed");

    const b = await serve((_req, _body, res) => {
      res.writeHead(501);
      res.end("not json at all");
    });
    const e2 = await failure(callJson(b.port, "POST", "/viewHierarchy", {}, 1000));
    expect(e2.kind).toBe("rejected");
    expect(e2.status).toBe(501);
    expect(e2.message).toContain("not json at all");
  });

  it("reports rejected when a 200 body is not JSON", async () => {
    const srv = await serve((_req, _body, res) => res.end("<html>"));
    const e = await failure(callJson(srv.port, "GET", "/status", undefined, 1000));
    expect(e.kind).toBe("rejected");
    expect(e.message).toMatch(/not JSON/);
  });

  it("never retries: one request per call even when the call fails", async () => {
    const srv = await serve((_req, _body, res) => {
      res.writeHead(500);
      res.end(JSON.stringify({ errorMessage: "boom" }));
    });
    await failure(callJson(srv.port, "POST", "/touch", { x: 1, y: 1 }, 1000));
    expect(srv.requests()).toBe(1);
  });

  it("tags a timeout with code 'timeout' so callers can tell a hung runner from a reset socket", async () => {
    const srv = await serve(() => {
      /* never respond */
    });
    const e = await failure(callJson(srv.port, "GET", "/status", undefined, 150));
    expect(e.kind).toBe("lost");
    expect(e.code).toBe("timeout");
  });

  it("leaves code undefined when the socket is reset after connecting (adb forward to a dead server)", async () => {
    const srv = await serve((req) => req.socket.destroy());
    const e = await failure(callJson(srv.port, "GET", "/status", undefined, 1000));
    expect(e.kind).toBe("lost");
    expect(e.code).toBeUndefined();
  });
});

describe("callBytes", () => {
  it("returns the raw body as a Buffer", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const srv = await serve((req, _body, res) => {
      expect(req.method).toBe("GET");
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(png);
    });
    const out = await callBytes(srv.port, "/screenshot", 1000);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.equals(png)).toBe(true);
  });

  it("classifies failures the same way as callJson", async () => {
    const port = await closedPort();
    expect((await failure(callBytes(port, "/screenshot", 1000))).kind).toBe("refused");
    const srv = await serve((_req, _body, res) => {
      res.writeHead(501);
      res.end(JSON.stringify({ code: "unsupported", errorMessage: "XCUIScreen" }));
    });
    const e = await failure(callBytes(srv.port, "/screenshot", 1000));
    expect(e.kind).toBe("unsupported");
    expect(e.message).toBe("XCUIScreen");
  });
});
