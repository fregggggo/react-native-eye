import { spawn, type ChildProcess } from "node:child_process";
import { DriverError } from "../core/errors.js";

// One long-lived `adb shell` per device: saves the ~50-100ms adb process spawn
// on every input command. Commands are serialized; responses are delimited by an
// echoed marker that also carries the exit status, and stderr is folded into the
// stream — otherwise a failed `input tap` looks exactly like a successful one.
const DEFAULT_TIMEOUT_MS = 15000;

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
    this.child = this.spawnFn("adb", ["-s", this.serial, "shell"], { stdio: ["pipe", "pipe", "pipe"] });
    return this.child;
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
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onErrData);
        child.off("exit", onExit);
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
      try {
        child.stdin?.write(`{ ${cmd}; } 2>&1; echo ${marker}:$?\n`);
      } catch (e) {
        cleanup();
        reject(new DriverError(`adb shell \`${cmd}\` write failed: ${String(e)}`));
      }
    });
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
  }
}
