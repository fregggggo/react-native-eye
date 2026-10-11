import { callJson, callBytes } from "./httpClient.js";
import { CALL_TIMEOUTS, type NativeBackend } from "./nativeBackend.js";

type Http = { callJson: typeof callJson; callBytes: typeof callBytes };

// The runner sleeps this long after typing the first character (Maestro's
// workaround for the keyboard dropping the first keystrokes), so it is part of
// every inputText call's budget.
const FIRST_CHAR_PAUSE_MS = 500;

/**
 * HTTP client for native/ios-runner on 127.0.0.1:<port>. Request shapes are
 * the fork's (spec "Routes kept"): no appIds, durations in ms, points.
 */
export class IosRunnerBackend implements NativeBackend {
  readonly platform = "ios" as const;

  constructor(
    public readonly port: number,
    private http: Http = { callJson, callBytes },
  ) {}

  status(): Promise<{ status: string; version: string }> {
    return this.http.callJson(this.port, "GET", "/status", undefined, CALL_TIMEOUTS.status);
  }

  hierarchy(): Promise<unknown> {
    return this.http.callJson(this.port, "POST", "/viewHierarchy", {}, CALL_TIMEOUTS.hierarchy);
  }

  async touch(x: number, y: number, durationMs?: number): Promise<void> {
    const body = durationMs === undefined ? { x, y } : { x, y, durationMs };
    await this.http.callJson(this.port, "POST", "/touch", body, CALL_TIMEOUTS.touch + (durationMs ?? 0));
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    await this.http.callJson(
      this.port,
      "POST",
      "/swipe",
      { startX: x1, startY: y1, endX: x2, endY: y2, durationMs },
      CALL_TIMEOUTS.swipe + durationMs,
    );
  }

  async inputText(text: string): Promise<void> {
    // Code points, not UTF-16 units: the runner types one character at a time.
    const chars = [...text].length;
    const timeoutMs = CALL_TIMEOUTS.inputBase + CALL_TIMEOUTS.inputPerChar * chars + FIRST_CHAR_PAUSE_MS;
    await this.http.callJson(this.port, "POST", "/inputText", { text }, timeoutMs);
  }

  async eraseText(chars: number): Promise<void> {
    const timeoutMs = CALL_TIMEOUTS.inputBase + CALL_TIMEOUTS.inputPerChar * chars;
    await this.http.callJson(this.port, "POST", "/eraseText", { charactersToErase: chars }, timeoutMs);
  }

  async pressKey(key: string): Promise<void> {
    await this.http.callJson(this.port, "POST", "/pressKey", { key }, CALL_TIMEOUTS.key);
  }

  async pressButton(button: "home" | "lock"): Promise<void> {
    await this.http.callJson(this.port, "POST", "/pressButton", { button }, CALL_TIMEOUTS.key);
  }

  screenshot(): Promise<Buffer> {
    return this.http.callBytes(this.port, "/screenshot", CALL_TIMEOUTS.screenshot);
  }

  async isScreenStatic(): Promise<boolean> {
    const r = await this.http.callJson<{ isScreenStatic: boolean }>(
      this.port, "GET", "/isScreenStatic", undefined, CALL_TIMEOUTS.isScreenStatic,
    );
    return r.isScreenStatic;
  }

  deviceInfo(): Promise<{ widthPoints?: number; heightPoints?: number; widthPixels: number; heightPixels: number }> {
    return this.http.callJson(this.port, "GET", "/deviceInfo", undefined, CALL_TIMEOUTS.deviceInfo);
  }
}
