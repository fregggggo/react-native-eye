import { describe, it, expect } from "vitest";
import { run, spawnLongRunning } from "../../src/core/exec.js";

describe("run", () => {
  it("captures stdout", async () => {
    const { stdout } = await run("node", ["-e", "process.stdout.write('hi')"]);
    expect(stdout).toBe("hi");
  });

  it("throws DriverError with install-ish message when binary missing", async () => {
    await expect(run("definitely-not-a-real-binary-xyz", [])).rejects.toThrow(/not found/i);
  });

  it("throws on non-zero exit", async () => {
    await expect(run("node", ["-e", "process.exit(3)"])).rejects.toThrow();
  });

  it("passes stdin input", async () => {
    const { stdout } = await run("node", ["-e", "process.stdin.pipe(process.stdout)"], { input: "echoed" });
    expect(stdout).toBe("echoed");
  });

  it("reports a timeout kill as a timeout, not a bare 'Command failed'", async () => {
    await expect(
      run("node", ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 100 }),
    ).rejects.toThrow(/timed out after 100ms/i);
  });

  it("merges extra env into the child environment", async () => {
    const { stdout } = await run(
      "node",
      ["-e", "process.stdout.write(process.env.RNE_TEST_VAR ?? 'unset')"],
      { env: { RNE_TEST_VAR: "hello" } },
    );
    expect(stdout).toBe("hello");
  });
});

describe("spawnLongRunning", () => {
  it("keeps the child alive until stop(), then resolves", async () => {
    const h = spawnLongRunning("node", [
      "-e",
      "setInterval(() => {}, 1000); process.on('SIGINT', () => process.exit(0));",
    ]);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.exited()).toBe(false);
    await h.stop();
    expect(h.exited()).toBe(true);
  });

  it("stop(signal, killAfterMs) SIGKILLs a child that ignores the signal once killAfterMs passes", async () => {
    const h = spawnLongRunning("node", ["-e", "process.on('SIGINT', () => {}); setInterval(() => {}, 1000);"]);
    await new Promise((r) => setTimeout(r, 300));
    const t0 = Date.now();
    await h.stop("SIGINT", 200);
    expect(h.exited()).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("stop() rejects with captured stderr when the child died early", async () => {
    const h = spawnLongRunning("node", ["-e", "process.stderr.write('boom'); process.exit(1);"]);
    await new Promise((r) => setTimeout(r, 400));
    expect(h.exited()).toBe(true);
    await expect(h.stop()).rejects.toThrow(/boom/);
  });
});
