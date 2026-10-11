/**
 * What an on-device runner can do, identical in shape on both platforms.
 * iOS coordinates are points, Android's pixels — the driver owns that
 * difference. Every method throws NativeCallError (httpClient.ts) unchanged,
 * so the driver can pick the fallback by `kind`; nothing here retries.
 */
export interface NativeBackend {
  readonly platform: "ios" | "android";
  status(): Promise<{ status: string; version: string }>;
  /** iOS: `{axElement, depth}`; Android: `{hierarchy: "<xml>"}`. */
  hierarchy(): Promise<unknown>;
  touch(x: number, y: number, durationMs?: number): Promise<void>;
  swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  inputText(text: string): Promise<void>;
  eraseText(chars: number): Promise<void>;
  pressKey(key: string): Promise<void>;
  pressButton(button: "home" | "lock"): Promise<void>;
  screenshot(): Promise<Buffer>;
  isScreenStatic(): Promise<boolean>;
  deviceInfo(): Promise<{ widthPoints?: number; heightPoints?: number; widthPixels: number; heightPixels: number }>;
}

/**
 * Per-call budgets (spec "Error handling and fallback"). A timeout is `lost`,
 * so these are what separates "slow" from "delivery unknown": touch and swipe
 * get their gesture duration on top, text gets 100ms per character on top.
 */
export const CALL_TIMEOUTS = {
  status: 1000,
  touch: 5000,
  swipe: 5000,
  inputBase: 5000,
  inputPerChar: 100,
  hierarchy: 10000,
  screenshot: 10000,
  key: 5000,
  isScreenStatic: 5000,
  deviceInfo: 2000,
};
