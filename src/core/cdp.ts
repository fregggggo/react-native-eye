import WebSocket from "ws";
import { ConnectionError } from "./errors.js";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

// Every request needs a deadline: a blocked JS thread — the exact situation this
// server exists to debug — never answers, and an un-timed request would hang the
// tool forever with no way to cancel it.
export const DEFAULT_CDP_TIMEOUT_MS = 15000;

export class CdpClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private eventHandlers = new Map<string, ((params: any) => void)[]>();
  private closeHandlers: (() => void)[] = [];
  private _connected = false;

  constructor(private wsUrl: string) {}

  get connected(): boolean {
    return this._connected;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl, { maxPayload: 100 * 1024 * 1024 });
      this.ws = ws;
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new ConnectionError(`timed out connecting to ${this.wsUrl}`));
      }, 5000);

      ws.on("open", () => {
        clearTimeout(timer);
        this._connected = true;
        resolve();
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        if (!this._connected) reject(new ConnectionError(`cannot connect: ${err.message}`));
      });
      ws.on("close", () => {
        this._connected = false;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new ConnectionError("socket closed"));
        }
        this.pending.clear();
        for (const h of this.closeHandlers) h();
      });
      ws.on("message", (data) => this.onMessage(data.toString()));
    });
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        // The code is what tells "no JS runtime right now" (-32601 while the
        // app is between execution contexts) from a real failure; the message
        // alone is just the method name.
        const err = new Error(msg.error.message ?? "CDP error") as Error & { code?: number };
        if (typeof msg.error.code === "number") err.code = msg.error.code;
        p.reject(err);
      }
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === "string") {
      for (const h of this.eventHandlers.get(msg.method) ?? []) h(msg.params);
    }
  }

  send(method: string, params: object = {}, opts?: { timeoutMs?: number }): Promise<any> {
    if (!this.ws || !this._connected) {
      return Promise.reject(new ConnectionError("not connected"));
    }
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_CDP_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ConnectionError(
            `${method} timed out after ${timeoutMs}ms — the app's JS thread may be blocked or the target is stale`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params }), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new ConnectionError(err.message));
        }
      });
    });
  }

  on(method: string, handler: (params: any) => void): void {
    const list = this.eventHandlers.get(method) ?? [];
    list.push(handler);
    this.eventHandlers.set(method, list);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    this._connected = false;
    this.ws?.close();
  }
}
