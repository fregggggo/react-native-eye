import type { NativePool } from "../native/pool.js";

export type ShutdownProc = {
  on(event: string, fn: () => void): unknown;
  exit(code: number): unknown;
  stdin: { on(event: string, fn: () => void): unknown };
};

/** How long before the grace period ends xcodebuild children get SIGKILL. */
const KILL_MARGIN_MS = 1000;

/**
 * The server's only shutdown path. What dies with the session: an iOS runner
 * started by the xcodebuild fallback and any in-flight start (pool.shutdown()),
 * and an Android start still in flight (its instrumentation, forward and
 * package are stopped). What survives on purpose, so the next session reuses
 * it in ~0.3 s instead of starting in ~6 s: the simctl-launched runner; a
 * ready Android server survives too, like the simctl-launched runner.
 *
 * xcodebuild takes a while to tear down on SIGINT, and nothing sends the
 * SIGKILL once this process has exited, so the pool is told to escalate to
 * SIGKILL KILL_MARGIN_MS before the grace period ends: no child outlives it.
 */
export function installShutdownHooks(opts: {
  pool: Pick<NativePool, "shutdown">;
  proc?: ShutdownProc;
  graceMs?: number;
  log?: (msg: string) => void;
}): { shutdown(reason: string, code: number): Promise<void> } {
  const proc: ShutdownProc = opts.proc ?? process;
  const graceMs = opts.graceMs ?? 3000;
  const log = opts.log ?? ((m: string) => console.error(`[react-native-eye] ${m}`));
  let running: Promise<void> | undefined;

  const shutdown = (reason: string, code: number): Promise<void> => {
    if (running) return running;
    running = (async () => {
      log(`shutting down (${reason})`);
      let timer: NodeJS.Timeout | undefined;
      // A stuck xcodebuild must not keep a dead session's process around.
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      });
      await Promise.race([
        opts.pool.shutdown({ killAfterMs: Math.max(0, graceMs - KILL_MARGIN_MS) }).catch((err: unknown) => {
          log(`native driver shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
        }),
        grace,
      ]);
      clearTimeout(timer);
      proc.exit(code);
    })();
    return running;
  };

  proc.on("SIGINT", () => void shutdown("SIGINT", 130));
  proc.on("SIGTERM", () => void shutdown("SIGTERM", 143));
  // An MCP client ends a stdio session by closing our stdin; the SDK's stdio
  // transport does not report that as a close.
  proc.stdin.on("end", () => void shutdown("stdin closed", 0));
  return { shutdown };
}
