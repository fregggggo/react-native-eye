import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { installShutdownHooks } from "../../src/core/shutdown.js";

function fakeProc() {
  const proc = Object.assign(new EventEmitter(), { stdin: new EventEmitter(), exits: [] as number[] });
  (proc as any).exit = (code: number) => void proc.exits.push(code);
  return proc as typeof proc & { exit(code: number): void };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("installShutdownHooks", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)("%s shuts the pool down, then exits %i", async (signal, code) => {
    const proc = fakeProc();
    let shut = 0;
    installShutdownHooks({ pool: { shutdown: async () => void shut++ }, proc, log: () => {} });
    proc.emit(signal);
    await tick();
    expect(shut).toBe(1);
    expect(proc.exits).toEqual([code]);
  });

  it("treats the client closing stdin as the end of the session", async () => {
    const proc = fakeProc();
    let shut = 0;
    installShutdownHooks({ pool: { shutdown: async () => void shut++ }, proc, log: () => {} });
    proc.stdin.emit("end");
    await tick();
    expect(shut).toBe(1);
    expect(proc.exits).toEqual([0]);
  });

  it("runs once however many triggers fire", async () => {
    const proc = fakeProc();
    let shut = 0;
    const hooks = installShutdownHooks({ pool: { shutdown: async () => void shut++ }, proc, log: () => {} });
    proc.emit("SIGTERM");
    proc.emit("SIGINT");
    await hooks.shutdown("transport closed", 0);
    await tick();
    expect(shut).toBe(1);
    expect(proc.exits).toEqual([143]);
  });

  it("exits after the grace period when the pool hangs", async () => {
    const proc = fakeProc();
    const hooks = installShutdownHooks({ pool: { shutdown: () => new Promise(() => {}) }, proc, graceMs: 20, log: () => {} });
    await hooks.shutdown("transport closed", 0);
    expect(proc.exits).toEqual([0]);
  });

  it("M-1: asks the pool to SIGKILL xcodebuild children inside the grace period", async () => {
    const proc = fakeProc();
    const seen: Array<{ killAfterMs?: number } | undefined> = [];
    const hooks = installShutdownHooks({
      pool: { shutdown: async (o?: { killAfterMs?: number }) => void seen.push(o) },
      proc,
      graceMs: 3000,
      log: () => {},
    });
    await hooks.shutdown("SIGTERM", 143);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.killAfterMs).toBeGreaterThanOrEqual(0);
    expect(seen[0]?.killAfterMs).toBeLessThan(3000);
  });

  it("still exits when the pool's shutdown throws, and logs it", async () => {
    const proc = fakeProc();
    const logs: string[] = [];
    const hooks = installShutdownHooks({
      pool: { shutdown: async () => Promise.reject(new Error("xcodebuild would not stop")) },
      proc,
      log: (m) => void logs.push(m),
    });
    await hooks.shutdown("SIGTERM", 143);
    expect(proc.exits).toEqual([143]);
    expect(logs.join("\n")).toContain("xcodebuild would not stop");
  });
});
