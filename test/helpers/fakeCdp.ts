import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

/** Handler return value that makes the fake target swallow the request. */
export const NO_REPLY = Symbol("no-reply");

/** Thrown from a handler to make the fake answer with this exact CDP error. */
export class CdpFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** What RN answers to Runtime.evaluate while the app is between JS runtimes. */
export const noRuntime = (): never => {
  throw new CdpFailure(-32601, "Runtime.evaluate");
};

export type CDPTargetLike = {
  id: string;
  title: string;
  description?: string;
  webSocketDebuggerUrl: string;
  vm?: string;
  reactNative?: unknown;
};

export type FakeMetro = {
  port: number;
  wsUrl: string;
  emit(method: string, params: unknown): void;
  setHandler(method: string, fn: (params: any) => any): void;
  close(): Promise<void>;
  connectionCount(): number;
};

export async function startFakeMetro(opts: {
  port: number;
  targets?: Partial<CDPTargetLike>[];
  handlers?: Record<string, (params: any) => any>;
}): Promise<FakeMetro> {
  const handlers: Record<string, (params: any) => any> = { ...(opts.handlers ?? {}) };
  const clients = new Set<WebSocket>();

  const http: Server = createServer((req, res) => {
    if (req.url?.startsWith("/json")) {
      const port = (http.address() as AddressInfo).port;
      const targets = (opts.targets ?? [{ id: "1", title: "React Native" }]).map((t, i) => ({
        id: t.id ?? String(i + 1),
        title: t.title ?? "React Native",
        description: t.description ?? "",
        vm: t.vm ?? "Hermes",
        reactNative: t.reactNative ?? { capabilities: {} },
        ...((t as any).deviceName ? { deviceName: (t as any).deviceName } : {}),
        ...((t as any).appId ? { appId: (t as any).appId } : {}),
        webSocketDebuggerUrl: t.webSocketDebuggerUrl ?? `ws://127.0.0.1:${port}/debugger/${i + 1}`,
      }));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(targets));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });

  const wss = new WebSocketServer({ server: http });
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      const handler = handlers[msg.method];
      let result: unknown = {};
      try {
        if (handler) result = handler(msg.params);
      } catch (err) {
        // A handler can throw a CdpFailure to answer with a real CDP error
        // object (code + message), e.g. Hermes's -32601 while no runtime exists.
        const error = err instanceof CdpFailure ? { code: err.code, message: err.message } : { message: String(err) };
        ws.send(JSON.stringify({ id: msg.id, error }));
        return;
      }
      if (result === NO_REPLY) return; // simulate a target that never answers
      ws.send(JSON.stringify({ id: msg.id, result }));
    });
  });

  await new Promise<void>((resolve) => http.listen(opts.port, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;

  return {
    port,
    wsUrl: `ws://127.0.0.1:${port}/debugger/1`,
    emit(method, params) {
      for (const ws of clients) ws.send(JSON.stringify({ method, params }));
    },
    setHandler(method, fn) {
      handlers[method] = fn;
    },
    connectionCount: () => clients.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const ws of clients) ws.close();
        wss.close(() => http.close(() => resolve()));
        // Node 18's close() waits out keep-alive sockets (/json/list fetches);
        // 19+ drops idle ones itself.
        http.closeIdleConnections?.();
      }),
  };
}

/**
 * Connection.evaluate wraps every expression and reads a JSON envelope back
 * (see src/core/evaluate.ts); fakes must answer in that shape.
 */
export function evalEnvelope(value: unknown): { result: { value: string } } {
  return { result: { value: JSON.stringify({ s: "ok", v: value }) } };
}
