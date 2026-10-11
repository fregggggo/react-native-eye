import { execFile, spawn } from "node:child_process";
import { DriverError } from "./errors.js";

// One 15s budget for everything was wrong in both directions: `axe describe-ui`
// on a busy screen needs more, and installing a 150MB bundle needs vastly more.
export const TIMEOUTS = {
  /**
   * Touch delivery. Measured 17–29.8s against a "hot" RN app in the iOS
   * simulator, versus 1.4s when the same app is backgrounded — the cost is per
   * touch event and cannot be amortised (axe batch: 3 steps 57s, 6 steps 117s).
   * 3x the worst measurement.
   */
  touch: 90_000,
  /** HID keyboard and hardware buttons: 0.3–0.6s even while touch is degraded. */
  key: 10_000,
  /** simctl/adb enumeration */
  list: 20_000,
  screenshot: 30_000,
  /** axe describe-ui / uiautomator dump — seconds on a heavy screen, worse under animation */
  layout: 45_000,
  install: 300_000,
  launch: 120_000,
  /** one OCR helper run over a full-resolution screenshot */
  ocr: 30_000,
  /** one-off swiftc of the OCR helper; a cold module cache makes the first build slow */
  compile: 180_000,
} as const;

export function run(
  cmd: string,
  args: string[],
  opts?: { input?: string; timeoutMs?: number; env?: Record<string, string>; hint?: string },
): Promise<{ stdout: string; stdoutBuffer: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      {
        timeout: opts?.timeoutMs ?? TIMEOUTS.key,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
        env: opts?.env ? { ...process.env, ...opts.env } : undefined,
      },
      (err, stdout, stderr) => {
        const outBuf = stdout as unknown as Buffer;
        const errStr = (stderr as unknown as Buffer)?.toString() ?? "";
        if (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return reject(new DriverError(`${cmd} not found — is it installed and on PATH?`));
          }
          const timeoutMs = opts?.timeoutMs ?? TIMEOUTS.key;
          if ((err as { killed?: boolean }).killed) {
            const what = `${cmd} ${args[0] ?? ""}`.trim();
            return reject(
              new DriverError(
                `${what} timed out after ${timeoutMs}ms (killed).${opts?.hint ? ` ${opts.hint}` : ""}`,
              ),
            );
          }
          return reject(new DriverError(`${cmd} failed: ${errStr || err.message}`));
        }
        resolve({ stdout: outBuf.toString(), stdoutBuffer: outBuf, stderr: errStr });
      },
    );
    if (opts?.input) {
      child.stdin?.end(opts.input);
    }
  });
}

export type LongRunningHandle = {
  exited(): boolean;
  stderr(): string;
  /** Throws if the process died right after spawn (missing binary, bad args). */
  assertAlive(ms?: number): Promise<void>;
  /**
   * Sends `signal` (SIGINT by default), then SIGKILL if the child is still
   * alive after `killAfterMs` (10 s by default).
   */
  stop(signal?: NodeJS.Signals, killAfterMs?: number): Promise<void>;
};

const STOP_KILL_AFTER_MS = 10_000;

export function spawnLongRunning(
  cmd: string,
  args: string[],
  opts?: { env?: Record<string, string> },
): LongRunningHandle {
  const child = spawn(cmd, args, {
    env: opts?.env ? { ...process.env, ...opts.env } : undefined,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderrBuf = "";
  let exited = false;
  let exitCode: number | null = null;
  child.stderr?.on("data", (d: Buffer) => {
    stderrBuf = (stderrBuf + d.toString()).slice(-8192);
  });
  const exitPromise = new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      resolve();
    });
    child.on("error", () => {
      exited = true;
      exitCode = -1;
      resolve();
    });
  });
  return {
    exited: () => exited,
    stderr: () => stderrBuf,
    assertAlive: async (ms = 400) => {
      const settled = await Promise.race([
        exitPromise.then(() => "exited" as const),
        new Promise<"alive">((r) => setTimeout(() => r("alive"), ms).unref()),
      ]);
      if (settled === "exited") {
        throw new DriverError(
          `${cmd} exited immediately (code ${exitCode}): ${stderrBuf.trim() || "(no stderr)"}`,
        );
      }
    },
    stop: async (signal: NodeJS.Signals = "SIGINT", killAfterMs: number = STOP_KILL_AFTER_MS) => {
      if (exited) {
        if (exitCode !== 0) {
          throw new DriverError(`${cmd} exited early (code ${exitCode}): ${stderrBuf || "(no stderr)"}`);
        }
        return;
      }
      child.kill(signal);
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), killAfterMs).unref());
      if ((await Promise.race([exitPromise, timeout])) === "timeout") {
        child.kill("SIGKILL");
        await exitPromise;
      }
    },
  };
}
