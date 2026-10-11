import { run, TIMEOUTS } from "../core/exec.js";
import { callJson, callBytes, NativeCallError } from "./httpClient.js";
import { CALL_TIMEOUTS, type NativeBackend } from "./nativeBackend.js";
import { isKeyCodeText, repairIme, typeWithIme } from "./androidIme.js";

type Http = { callJson: typeof callJson; callBytes: typeof callBytes };
type Ime = (serial: string, text: string) => Promise<void>;
type BackendDeps = {
  /** `adb -s <serial> <args…>` → stdout; throws on failure. */
  adb: (serial: string, args: string[]) => Promise<string>;
  repairIme: (serial: string) => Promise<unknown>;
};

const DEFAULT_DEPS: BackendDeps = {
  adb: async (serial, args) => (await run("adb", ["-s", serial, ...args], { timeoutMs: TIMEOUTS.list })).stdout,
  repairIme: (serial) => repairIme(serial),
};

/**
 * Maestro's key-code typing sleeps 75 ms per character and injects 2–4 key
 * events per character (shifted characters take more), each measured at
 * 15–45 ms under load (T1), so iOS's 100 ms/char budget is too tight here.
 */
const INPUT_PER_CHAR_MS = 250;

/**
 * HTTP client for native/android-server behind an `adb forward` to its socket.
 * Coordinates are pixels. Non-ASCII text goes through our IME (androidIme.ts).
 *
 * Every route that drives UiAutomation waits for the server's one route lock
 * (Routes.kt), so calls to those routes are queued here, one at a time per
 * server: each call's budget then starts when the server can actually run it.
 * Without the queue, a screenshot waiting behind a 10 s hierarchy dump (observe
 * runs both at once) or behind a long /inputText would time out as `lost`
 * although it runs later anyway — and two of those in 60 s write the server off.
 * /status and /deviceInfo take no lock and skip the queue.
 */
export class AndroidServerBackend implements NativeBackend {
  readonly platform = "android" as const;
  private tail: Promise<void> = Promise.resolve();
  private repaired?: Promise<void>;
  private deps: BackendDeps;

  constructor(
    public readonly port: number,
    public readonly serial: string,
    private http: Http = { callJson, callBytes },
    private ime: Ime = typeWithIme,
    deps: Partial<BackendDeps> = {},
  ) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  /**
   * Gives the user their keyboard back if a previous host died while our IME
   * was selected (androidIme.repairIme). Once per server generation: the
   * driver calls this whenever the pool hands the server out, and only the
   * first call does anything. Never rejects.
   */
  repairKeyboard(): Promise<void> {
    this.repaired ??= this.deps.repairIme(this.serial).then(
      () => {},
      () => {},
    );
    return this.repaired;
  }

  /** Runs `fn` once every earlier locked call has settled. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(() => this.call(fn));
    this.tail = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /**
   * adb forward accepts the host connection even when nothing listens on the
   * device, then resets it: a dead server looks `lost`. A reset without a
   * timeout is re-checked: when /status does not answer either AND the adb
   * forward is still in place, the server behind it is gone and nothing was
   * delivered, so it becomes `refused` (fall back, re-warm). When the forward
   * itself has vanished, the adb transport dropped (adb server restarted,
   * `adb kill-server`, USB replug) — possibly after the request was delivered
   * and executed — so it stays `lost` and a gesture is not repeated.
   */
  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof NativeCallError && e.kind === "lost" && e.code !== "timeout" && !(await this.answers())) {
        if (await this.forwardInPlace()) {
          throw new NativeCallError(
            "refused",
            `${e.message} — nothing answers behind the adb forward: the server is gone`,
            e.status,
            "forward_dead",
          );
        }
        throw new NativeCallError(
          "lost",
          `${e.message} — the adb forward is gone too (adb restarted or the device reconnected), so delivery is unknown`,
          e.status,
          e.code,
        );
      }
      throw e;
    }
  }

  private async answers(): Promise<boolean> {
    try {
      await this.http.callJson(this.port, "GET", "/status", undefined, CALL_TIMEOUTS.status);
      return true;
    } catch {
      return false;
    }
  }

  /** `adb forward --list` still maps our host port for this device; false when adb itself fails. */
  private async forwardInPlace(): Promise<boolean> {
    try {
      const out = await this.deps.adb(this.serial, ["forward", "--list"]);
      return out.split(/\r?\n/).some((line) => {
        const [serial, local] = line.trim().split(/\s+/);
        return serial === this.serial && local === `tcp:${this.port}`;
      });
    } catch {
      return false;
    }
  }

  status(): Promise<{ status: string; version: string }> {
    return this.http.callJson(this.port, "GET", "/status", undefined, CALL_TIMEOUTS.status);
  }

  hierarchy(): Promise<unknown> {
    return this.locked(() => this.http.callJson(this.port, "POST", "/viewHierarchy", {}, CALL_TIMEOUTS.hierarchy));
  }

  async touch(x: number, y: number, durationMs?: number): Promise<void> {
    const body = durationMs === undefined ? { x, y } : { x, y, durationMs };
    await this.locked(() => this.http.callJson(this.port, "POST", "/touch", body, CALL_TIMEOUTS.touch + (durationMs ?? 0)));
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    const body = { startX: x1, startY: y1, endX: x2, endY: y2, durationMs };
    await this.locked(() => this.http.callJson(this.port, "POST", "/swipe", body, CALL_TIMEOUTS.swipe + durationMs));
  }

  async inputText(text: string): Promise<void> {
    if (!isKeyCodeText(text)) {
      await this.ime(this.serial, text);
      return;
    }
    const timeoutMs = CALL_TIMEOUTS.inputBase + INPUT_PER_CHAR_MS * text.length;
    await this.locked(() => this.http.callJson(this.port, "POST", "/inputText", { text }, timeoutMs));
  }

  async eraseText(chars: number): Promise<void> {
    const timeoutMs = CALL_TIMEOUTS.inputBase + CALL_TIMEOUTS.inputPerChar * chars;
    await this.locked(() => this.http.callJson(this.port, "POST", "/eraseText", { charactersToErase: chars }, timeoutMs));
  }

  async pressKey(key: string): Promise<void> {
    await this.locked(() => this.http.callJson(this.port, "POST", "/pressKey", { key }, CALL_TIMEOUTS.key));
  }

  async pressButton(button: "home" | "lock"): Promise<void> {
    await this.locked(() => this.http.callJson(this.port, "POST", "/pressButton", { button }, CALL_TIMEOUTS.key));
  }

  screenshot(): Promise<Buffer> {
    return this.locked(() => this.http.callBytes(this.port, "/screenshot", CALL_TIMEOUTS.screenshot));
  }

  async isScreenStatic(): Promise<boolean> {
    const r = await this.locked(() =>
      this.http.callJson<{ isScreenStatic: boolean }>(this.port, "GET", "/isScreenStatic", undefined, CALL_TIMEOUTS.isScreenStatic),
    );
    return r.isScreenStatic;
  }

  deviceInfo(): Promise<{ widthPixels: number; heightPixels: number }> {
    return this.call(() => this.http.callJson(this.port, "GET", "/deviceInfo", undefined, CALL_TIMEOUTS.deviceInfo));
  }
}
