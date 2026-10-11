import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AdbShell } from "../../src/drivers/adbShell.js";

function fakeChild() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function shellWithChildren() {
  const children: any[] = [];
  const shell = new AdbShell("SER", (() => {
    const c = fakeChild();
    children.push(c);
    return c;
  }) as any);
  return { shell, children };
}

describe("AdbShell", () => {
  it("writes the command with an exit-status marker and resolves on it", async () => {
    const { shell, children } = shellWithChildren();
    const p = shell.exec("input tap 1 2");
    await new Promise((r) => setTimeout(r, 10)); // exec spawns on the next tick
    const written: string = await new Promise((r) => children[0].stdin.once("data", (d: Buffer) => r(d.toString())));
    expect(written).toBe("{ input tap 1 2; } 2>&1; echo __RNE_DONE_1__:$?\n");
    children[0].stdout.write("__RNE_DONE_1__:0\n");
    await expect(p).resolves.toBe("");
  });

  it("rejects when the command exits non-zero, surfacing the device output", async () => {
    const { shell, children } = shellWithChildren();
    const p = shell.exec("input tap 1 2");
    await new Promise((r) => setTimeout(r, 10));
    children[0].stdout.write("Error: Injecting to another application requires INJECT_EVENTS\n__RNE_DONE_1__:255\n");
    await expect(p).rejects.toThrow(/exit 255.*INJECT_EVENTS/s);
  });

  it("folds stderr into the reported output", async () => {
    const { shell, children } = shellWithChildren();
    const p = shell.exec("boom");
    await new Promise((r) => setTimeout(r, 10));
    children[0].stderr.write("device says no\n");
    children[0].stdout.write("__RNE_DONE_1__:1\n");
    await expect(p).rejects.toThrow(/device says no/);
  });

  it("times out and drops the shell so later commands are not blocked", async () => {
    const { shell, children } = shellWithChildren();
    const p = shell.exec("hangs", { timeoutMs: 30 });
    await expect(p).rejects.toThrow(/timed out/);
    const p2 = shell.exec("next");
    await new Promise((r) => setTimeout(r, 10));
    expect(children).toHaveLength(2);
    children[1].stdout.write("__RNE_DONE_2__:0\n");
    await expect(p2).resolves.toBe("");
  });

  it("serializes commands (second not sent until first completes)", async () => {
    const { shell, children } = shellWithChildren();
    const p1 = shell.exec("first");
    const p2 = shell.exec("second");
    await new Promise((r) => setTimeout(r, 10)); // exec spawns on the next tick
    let buf = "";
    children[0].stdin.on("data", (d: Buffer) => {
      buf += d.toString();
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(buf).toContain("first");
    expect(buf).not.toContain("second");
    children[0].stdout.write("__RNE_DONE_1__:0\n");
    await p1;
    await new Promise((r) => setTimeout(r, 50));
    expect(buf).toContain("second");
    children[0].stdout.write("__RNE_DONE_2__:0\n");
    await p2;
  });

  it("rejects on shell death and respawns for the next command", async () => {
    const { shell, children } = shellWithChildren();
    const p = shell.exec("doomed");
    await new Promise((r) => setTimeout(r, 10));
    children[0].exitCode = 1;
    children[0].emit("exit", 1);
    await expect(p).rejects.toThrow(/died/);
    const p2 = shell.exec("revived");
    await new Promise((r) => setTimeout(r, 10));
    expect(children).toHaveLength(2);
    children[1].stdout.write("__RNE_DONE_2__:0\n");
    await p2;
  });

  it("names the in-flight command and any output already received when the shell dies mid-command", async () => {
    // A bare "adb shell died" tells the caller nothing about which input
    // command was interrupted or whether it had already produced output —
    // an agent can't tell a lost tap from a lost keystroke from this alone.
    const { shell, children } = shellWithChildren();
    const p = shell.exec("input tap 5 6");
    await new Promise((r) => setTimeout(r, 10));
    children[0].stdout.write("partial output before crash\n");
    children[0].exitCode = 1;
    children[0].emit("exit", 1);
    await expect(p).rejects.toThrow(/input tap 5 6/);
    await expect(p).rejects.toThrow(/partial output before crash/);
  });

  it("names the command that failed to write to the shell", async () => {
    const child = fakeChild();
    child.stdin.write = () => {
      throw new Error("EPIPE");
    };
    const shell = new AdbShell("SER", (() => child) as any);
    const p = shell.exec("input tap 5 6");
    await expect(p).rejects.toThrow(/input tap 5 6/);
    await expect(p).rejects.toThrow(/EPIPE/);
  });
});
