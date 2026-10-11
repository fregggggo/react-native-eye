import http from "node:http";

/**
 * Why a call to an on-device runner failed. Fallback depends on the kind
 * (spec "Error handling and fallback"), so the distinction is the whole point
 * of this module:
 * - refused: the connection never opened — the request was not delivered.
 * - lost: the socket died or the call timed out after the connection opened —
 *   delivery unknown, so a gesture must not be repeated. A timeout carries
 *   `code: "timeout"`. A socket that dies after connecting carries no code.
 *   Through `adb forward` that second case is how a dead server looks (the
 *   forward accepts, then resets), so androidBackend re-checks it.
 * - unsupported: 501 {code:"unsupported"} — the runner cannot do this on this
 *   Xcode/OS; nothing was done.
 * - rejected: any other non-2xx (or an unreadable 2xx) — the runner received
 *   the request and refused it.
 */
export type NativeFailureKind = "refused" | "lost" | "unsupported" | "rejected";

export class NativeCallError extends Error {
  constructor(
    public kind: NativeFailureKind,
    message: string,
    public status?: number,
    public code?: string,
  ) {
    super(message);
    this.name = "NativeCallError";
  }
}

const HOST = "127.0.0.1";

type RawResponse = { status: number; body: Buffer };

/**
 * One HTTP exchange, no retries. `agent: false` gives every call its own
 * socket, so a runner that died between calls can never hand us a stale
 * keep-alive connection whose failure would look like `lost` instead of
 * `refused`.
 */
function exchange(
  port: number,
  method: "GET" | "POST",
  path: string,
  body: unknown | undefined,
  timeoutMs: number,
): Promise<RawResponse> {
  const what = `${method} ${path} on ${HOST}:${port}`;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise<RawResponse>((resolve, reject) => {
    let settled = false;
    // Set once the TCP connection is up: every failure before it is `refused`
    // (nothing reached the runner), every failure after it is `lost`.
    let connected = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const fail = (why: string, code?: string) => {
      const kind: NativeFailureKind = connected ? "lost" : "refused";
      settle(() => reject(new NativeCallError(kind, `${what} ${kind}: ${why}`, undefined, code)));
    };

    const req = http.request({
      host: HOST,
      port,
      method,
      path,
      agent: false,
      // Every POST says application/json, body or not: the runner refuses any
      // other POST with 415, so a browser's no-preflight text/plain POST to
      // 127.0.0.1 cannot drive the simulator.
      headers:
        method === "POST"
          ? { "Content-Type": "application/json", "Content-Length": payload?.length ?? 0 }
          : undefined,
    });

    const timer = setTimeout(() => {
      fail(`no answer within ${timeoutMs}ms`, "timeout");
      req.destroy();
    }, timeoutMs);
    timer.unref?.();

    req.on("socket", (socket) => {
      if (!socket.connecting) connected = true;
      else socket.once("connect", () => (connected = true));
    });
    req.on("error", (err: NodeJS.ErrnoException) => fail(err.code ?? err.message));
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (d: Buffer) => chunks.push(d));
      res.on("aborted", () => fail("response aborted"));
      res.on("error", (err: NodeJS.ErrnoException) => fail(err.code ?? err.message));
      res.on("end", () => settle(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) })));
    });
    req.end(payload);
  });
}

/** Turns a non-2xx answer into `unsupported` or `rejected`. */
function statusError(method: string, path: string, res: RawResponse): NativeCallError {
  const text = res.body.toString("utf8");
  let code: string | undefined;
  let errorMessage: string | undefined;
  try {
    const j = JSON.parse(text) as { code?: unknown; errorMessage?: unknown };
    if (typeof j.code === "string") code = j.code;
    if (typeof j.errorMessage === "string") errorMessage = j.errorMessage;
  } catch {
    // Not JSON: keep the raw text as the message below.
  }
  if (res.status === 501 && code === "unsupported") {
    return new NativeCallError("unsupported", errorMessage ?? "unsupported", res.status, code);
  }
  const message = errorMessage ?? `${method} ${path} answered ${res.status}${text ? `: ${text.slice(0, 500)}` : ""}`;
  return new NativeCallError("rejected", message, res.status, code);
}

const ok = (status: number) => status >= 200 && status < 300;

/** JSON call; an empty 2xx body resolves to `undefined`. */
export async function callJson<T = unknown>(
  port: number,
  method: "GET" | "POST",
  path: string,
  body: unknown | undefined,
  timeoutMs: number,
): Promise<T> {
  const res = await exchange(port, method, path, body, timeoutMs);
  if (!ok(res.status)) throw statusError(method, path, res);
  if (res.body.length === 0) return undefined as T;
  const text = res.body.toString("utf8");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new NativeCallError(
      "rejected",
      `${method} ${path} answered ${res.status} with a body that is not JSON: ${text.slice(0, 200)}`,
      res.status,
    );
  }
}

/** GET returning the raw body (screenshot PNG). */
export async function callBytes(port: number, path: string, timeoutMs: number): Promise<Buffer> {
  const res = await exchange(port, "GET", path, undefined, timeoutMs);
  if (!ok(res.status)) throw statusError("GET", path, res);
  return res.body;
}
