import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AdbShell, commandNotSent } from "../../src/drivers/adbShell.js";

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

  // Review #11: only these two prove nothing ran, so only these may be retried.
  it("marks a failed write as not sent, but not a death or a timeout after the write", async () => {
    const child = fakeChild();
    child.stdin.write = () => {
      throw new Error("EPIPE");
    };
    const w = await new AdbShell("SER", (() => child) as any).exec("input tap 5 6").catch((e) => e);
    expect(commandNotSent(w)).toBe(true);

    const { shell, children } = shellWithChildren();
    const p = shell.exec("input tap 5 6");
    await new Promise((r) => setTimeout(r, 10));
    children[0].exitCode = 1;
    children[0].emit("exit", 1);
    expect(commandNotSent(await p.catch((e) => e))).toBe(false);

    const t = await shellWithChildren().shell.exec("hangs", { timeoutMs: 20 }).catch((e) => e);
    expect(commandNotSent(t)).toBe(false);
  });

  it("an adb that cannot be spawned rejects as not sent instead of crashing the process, and is not reused", async () => {
    const children: any[] = [];
    const shell = new AdbShell("SER", (() => {
      const c = fakeChild();
      c.pid = undefined;
      children.push(c);
      // Node reports a failed spawn asynchronously, as an 'error' event.
      setTimeout(() => c.emit("error", new Error("spawn adb ENOENT")), 5);
      return c;
    }) as any);
    const err = await shell.exec("input tap 1 2").catch((e) => e);
    expect(err.message).toMatch(/spawn adb ENOENT/);
    expect(commandNotSent(err)).toBe(true);
    await shell.exec("input tap 1 2").catch(() => {});
    expect(children).toHaveLength(2);
  });

  it("an EPIPE emitted on stdin after the shell died does not crash the process", async () => {
    const { shell, children } = shellWithChildren();
    const p = shell.exec("input tap 1 2");
    await new Promise((r) => setTimeout(r, 10));
    children[0].stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    const err = await p.catch((e) => e);
    expect(commandNotSent(err)).toBe(true);
    // A late one, with no command in flight, is swallowed too.
    expect(() => children[0].stdin.emit("error", new Error("write EPIPE"))).not.toThrow();
  });
});
