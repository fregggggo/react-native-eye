import { spawn, type ChildProcess } from "node:child_process";
import { DriverError } from "../core/errors.js";

// One long-lived `adb shell` per device: saves the ~50-100ms adb process spawn
// on every input command. Commands are serialized; responses are delimited by an
// echoed marker that also carries the exit status, and stderr is folded into the
// stream — otherwise a failed `input tap` looks exactly like a successful one.
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * The command provably never reached the device: the shell could not be
 * started, or writing to it failed. Only then is a one-shot retry safe — a
 * shell that died or timed out after the write may well have run it.
 */
export function commandNotSent(err: unknown): boolean {
  return (err as { notSent?: boolean } | null)?.notSent === true;
}

const notSent = (message: string) => Object.assign(new DriverError(message), { notSent: true });

export class AdbShell {
  private child: ChildProcess | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(
    private serial: string,
    private spawnFn: typeof spawn = spawn,
  ) {}

  exec(cmd: string, opts?: { timeoutMs?: number }): Promise<string> {
    const runIt = () => this.execNow(cmd, opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const p = this.queue.then(runIt, runIt);
    this.queue = p.catch(() => {});
    return p;
  }

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child;
    const child = this.spawnFn("adb", ["-s", this.serial, "shell"], { stdio: ["pipe", "pipe", "pipe"] });
    // Without listeners, a spawn failure (adb not on PATH) or an EPIPE on a
    // shell that just died is an uncaught 'error' event: it takes the whole
    // MCP server down. A child that failed to spawn never emits 'exit', so it
    // is dropped here or every later command would wait out its timeout on it.
    child.on("error", () => {
      if (this.child === child) this.child = null;
    });
    child.stdin?.on("error", () => {});
    this.child = child;
    return child;
  }

  private execNow(cmd: string, timeoutMs: number): Promise<string> {
    const child = this.ensure();
    const marker = `__RNE_DONE_${++this.seq}__`;
    const markerRe = new RegExp(`${marker}:(-?\\d+)`);
    return new Promise<string>((resolve, reject) => {
      let buf = "";
      let timer: NodeJS.Timeout | undefined;
      const onData = (d: Buffer) => {
        buf += d.toString();
        const hit = markerRe.exec(buf);
        if (!hit) return;
        cleanup();
        const output = buf.slice(0, hit.index).trim();
        const code = Number(hit[1]);
        if (code !== 0) {
          reject(new DriverError(`adb shell \`${cmd}\` failed (exit ${code})${output ? `: ${output}` : ""}`));
          return;
        }
        resolve(output);
      };
      const onErrData = (d: Buffer) => {
        buf += d.toString();
      };
      const onExit = () => {
        cleanup();
        reject(new DriverError(`adb shell \`${cmd}\` died${buf.trim() ? `: ${buf.trim()}` : ""}`));
      };
      const onError = (e: Error) => {
        cleanup();
        // No pid: the process never started, so nothing ran.
        const msg = `adb shell \`${cmd}\` could not run: ${e.message}`;
        reject(child.pid === undefined ? notSent(msg) : new DriverError(msg));
      };
      const onWriteError = (e: Error) => {
        cleanup();
        reject(notSent(`adb shell \`${cmd}\` write failed: ${e.message}`));
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onErrData);
        child.off("exit", onExit);
        child.off("error", onError);
        child.stdin?.off("error", onWriteError);
      };
      timer = setTimeout(() => {
        cleanup();
        // A hung command would otherwise block every later command for this
        // device: drop the shell so the next exec starts a fresh one.
        this.dispose();
        reject(new DriverError(`adb shell \`${cmd}\` timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onErrData);
      child.on("exit", onExit);
      child.on("error", onError);
      child.stdin?.on("error", onWriteError);
      try {
        child.stdin?.write(`{ ${cmd}; } 2>&1; echo ${marker}:$?\n`);
      } catch (e) {
        cleanup();
        reject(notSent(`adb shell \`${cmd}\` write failed: ${String(e)}`));
      }
    });
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
  }
}
