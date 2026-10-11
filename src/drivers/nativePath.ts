import { DriverError } from "../core/errors.js";
import { NativeCallError } from "../native/httpClient.js";
import type { NativeBackend } from "../native/nativeBackend.js";
import { notReadyReason, type NativePool, type PoolEntryView } from "../native/pool.js";
import type { OsPath } from "./types.js";

export type RunnerPool = Pick<NativePool, "get" | "view" | "markDead" | "markFailed"> & Partial<Pick<NativePool, "settled">>;

/**
 * Why the runner was not used, for OsPath.reason — the pool's own wording
 * ("runner starting", "runner <state>: <reason>"). undefined when the user
 * switched it off (RNE_NATIVE_DRIVER=off): the marker then reads exactly as it
 * did before the runner existed, which is what the kill switch promises.
 */
export function fallbackReason(view: PoolEntryView | undefined): string | undefined {
  if (view?.state === "failed" && /^disabled\b/.test(view.reason ?? "")) return undefined;
  return notReadyReason(view);
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The fallback table of spec "Error handling and fallback", shared by the iOS
 * and Android drivers. `label` names the on-device side in errors ("iOS
 * runner", "Android server"); `fallbackPath` is the OS path used instead.
 */
export class NativePath {
  constructor(
    private pool: RunnerPool,
    private platform: "ios" | "android",
    private label: string,
    private fallbackPath: "axe" | "adb",
  ) {}

  backendFor(id: string): { backend?: NativeBackend; reason?: string } {
    const backend = this.pool.get(this.platform, id);
    if (backend) return { backend };
    return { reason: fallbackReason(this.pool.view(this.platform, id)) };
  }

  /**
   * backendFor, but a start in flight is waited for (at most `maxWaitMs`)
   * instead of answered with "runner starting" — for a fallback that would
   * break the start (D22: `uiautomator dump` takes UiAutomation from the
   * instrumentation coming up). `pending`: the start is still in flight
   * after the wait. A pool without settled() is never waited for.
   */
  async backendAfterStart(id: string, maxWaitMs: number): Promise<{ backend?: NativeBackend; reason?: string; pending?: boolean }> {
    const now = this.backendFor(id);
    // After get(): an absent entry has just been given its start.
    const inflight = now.backend ? undefined : this.pool.settled?.(this.platform, id);
    if (!inflight) return now;
    let timer: NodeJS.Timeout | undefined;
    const done = await Promise.race([
      inflight.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), maxWaitMs);
      }),
    ]);
    clearTimeout(timer);
    return done ? this.backendFor(id) : { ...now, pending: true };
  }

  osPath(why?: string): OsPath {
    return why ? { path: this.fallbackPath, reason: why } : { path: this.fallbackPath };
  }

  /**
   * A gesture failed on the runner. Returns the fallback reason when nothing was
   * delivered (refused, unsupported) so the fallback may run; throws when a
   * fallback would risk a double action (lost) or the runner said no on purpose
   * (rejected). `backend` is the one the call used: the pool ignores a report
   * about a runner it has already replaced or written off.
   */
  gestureFailure(id: string, backend: NativeBackend, op: string, err: unknown): string {
    const e = err instanceof NativeCallError ? err : new NativeCallError("lost", messageOf(err));
    switch (e.kind) {
      case "refused":
        // Same wording the pool's view gives while it re-warms ({dead, reason}),
        // so this call's marker and the next call's read alike.
        this.pool.markDead(this.platform, id, e.message, backend);
        return `runner dead: ${e.message}`;
      case "unsupported":
        // e.message is exactly the runner's errorMessage: the missing symbol.
        this.pool.markFailed(this.platform, id, `unsupported: ${e.message}`, backend);
        return `unsupported: ${e.message}`;
      case "lost":
        this.pool.markDead(this.platform, id, e.message, backend);
        throw new DriverError(
          `${this.label} connection lost during the ${op} (${e.message}) — the gesture may not have been delivered — check the screen before retrying.`,
        );
      case "rejected":
        throw new DriverError(`${this.label} refused the ${op}: ${e.message}`);
    }
  }

  /** A read failed on the runner: never throws, always falls back, says why. */
  readFailure(id: string, backend: NativeBackend, err: unknown): string {
    if (!(err instanceof NativeCallError)) return `runner error: ${messageOf(err)}`;
    switch (err.kind) {
      case "refused":
      case "lost":
        this.pool.markDead(this.platform, id, err.message, backend);
        return `runner dead: ${err.message}`;
      case "unsupported":
        this.pool.markFailed(this.platform, id, `unsupported: ${err.message}`, backend);
        return `unsupported: ${err.message}`;
      case "rejected":
        return `runner rejected: ${err.message}`;
    }
  }

  /** `viaFallback` gets the reason the runner was not used (e.g. to name it in a guard's error). */
  async gesture(
    id: string,
    op: string,
    viaRunner: (b: NativeBackend) => Promise<void>,
    viaFallback: (why?: string) => Promise<void>,
  ): Promise<OsPath> {
    const { backend, reason } = this.backendFor(id);
    let why = reason;
    if (backend) {
      try {
        await viaRunner(backend);
        return { path: "runner" };
      } catch (err) {
        why = this.gestureFailure(id, backend, op, err);
      }
    }
    await viaFallback(why);
    return this.osPath(why);
  }
}
