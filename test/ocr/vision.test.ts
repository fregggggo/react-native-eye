import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { VisionOcr } from "../../src/ocr/vision.js";
import { DriverError } from "../../src/core/errors.js";

const RESULT = {
  width: 1206,
  height: 2622,
  lines: [{ text: "Sign in", x: 300, y: 1200, w: 522, h: 72, confidence: 0.95 }],
};

function fakeRunner(o?: { swiftc?: "ok" | "enoent" | "fail"; stdout?: string }) {
  const calls: string[][] = [];
  const runner = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd === "swiftc") {
      if (o?.swiftc === "enoent") throw new DriverError("swiftc not found — is it installed and on PATH?");
      if (o?.swiftc === "fail") throw new DriverError("swiftc failed: error: cannot find 'VNFoo' in scope");
      await writeFile(args[args.indexOf("-o") + 1], "#!/bin/sh\n", { mode: 0o755 });
      return { stdout: "", stdoutBuffer: Buffer.from(""), stderr: "" };
    }
    const stdout = o?.stdout ?? JSON.stringify(RESULT);
    return { stdout, stdoutBuffer: Buffer.from(stdout), stderr: "" };
  };
  return { runner: runner as any, calls };
}

const swiftcCalls = (calls: string[][]) => calls.filter((c) => c[0] === "swiftc");

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rne-ocr-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("VisionOcr", () => {
  it("compiles the helper once with swiftc, then runs the cached binary", async () => {
    const { runner, calls } = fakeRunner();
    const ocr = new VisionOcr(runner, dir);
    const r = await ocr.recognize("/x.png");
    expect(calls[0][0]).toBe("swiftc");
    expect(calls[0]).toContain("-o");
    expect(calls[0].some((a) => a.endsWith(".swift"))).toBe(true);
    expect(calls[1][0]).toBe(ocr.binPath());
    expect(calls[1][1]).toBe("/x.png");
    expect(existsSync(ocr.binPath())).toBe(true);
    expect(existsSync(`${ocr.binPath()}.swift`)).toBe(false);
    expect(r.backend).toBe("vision");
    expect(r.width).toBe(1206);
    expect(r.lines[0]).toEqual({ text: "Sign in", x: 300, y: 1200, w: 522, h: 72, confidence: 0.95 });
  });

  it("does not recompile on the second call", async () => {
    const { runner, calls } = fakeRunner();
    const ocr = new VisionOcr(runner, dir);
    await ocr.recognize("/a.png");
    await ocr.recognize("/b.png");
    expect(swiftcCalls(calls).length).toBe(1);
  });

  it("reuses a binary another instance already compiled into the cache dir", async () => {
    const first = fakeRunner();
    await new VisionOcr(first.runner, dir).recognize("/a.png");
    const second = fakeRunner();
    await new VisionOcr(second.runner, dir).recognize("/b.png");
    expect(swiftcCalls(second.calls).length).toBe(0);
  });

  it("compiles once when two first calls race", async () => {
    const { runner, calls } = fakeRunner();
    const ocr = new VisionOcr(runner, dir);
    const [a, b] = await Promise.all([ocr.recognize("/a.png"), ocr.recognize("/b.png")]);
    expect(swiftcCalls(calls).length).toBe(1);
    expect(a).toEqual(b);
  });

  it("passes languages through to the helper", async () => {
    const { runner, calls } = fakeRunner();
    const ocr = new VisionOcr(runner, dir);
    await ocr.recognize("/a.png", { languages: ["ru", "en"] });
    expect(calls.at(-1)!.slice(1)).toEqual(["/a.png", "--languages", "ru,en"]);
    await ocr.recognize("/b.png");
    expect(calls.at(-1)!.slice(1)).toEqual(["/b.png"]);
  });

  it("points at the Command Line Tools when swiftc is missing", async () => {
    const { runner } = fakeRunner({ swiftc: "enoent" });
    const ocr = new VisionOcr(runner, dir);
    await expect(ocr.recognize("/a.png")).rejects.toThrow(/xcode-select --install/);
    expect(existsSync(`${ocr.binPath()}.swift`)).toBe(false);
  });

  it("surfaces the compiler output when the helper fails to build, and recovers", async () => {
    const broken = fakeRunner({ swiftc: "fail" });
    const ocr = new VisionOcr(broken.runner, dir);
    await expect(ocr.recognize("/a.png")).rejects.toThrow(/cannot find 'VNFoo'/);
    expect(existsSync(ocr.binPath())).toBe(false);
    const fixed = fakeRunner();
    await new VisionOcr(fixed.runner, dir).recognize("/a.png");
    expect(swiftcCalls(fixed.calls).length).toBe(1);
  });

  it("rejects malformed helper output", async () => {
    await expect(new VisionOcr(fakeRunner({ stdout: "not json" }).runner, dir).recognize("/a.png")).rejects.toThrow(
      /invalid JSON/,
    );
    await expect(new VisionOcr(fakeRunner({ stdout: "{}" }).runner, dir).recognize("/a.png")).rejects.toThrow(
      /unexpected result shape/,
    );
  });

  it("drops empty and unmeasurable lines", async () => {
    const stdout = JSON.stringify({
      width: 10,
      height: 10,
      lines: [
        { text: "   ", x: 1, y: 2, w: 3, h: 4, confidence: 1 },
        { text: "bad", x: "nope", y: 2, w: 3, h: 4, confidence: 1 },
        { text: " Hi ", x: 1, y: 2, w: 3, h: 4, confidence: 1 },
      ],
    });
    const r = await new VisionOcr(fakeRunner({ stdout }).runner, dir).recognize("/a.png");
    expect(r.lines).toEqual([{ text: "Hi", x: 1, y: 2, w: 3, h: 4, confidence: 1 }]);
  });

  it("names the binary after the source hash", () => {
    expect(basename(new VisionOcr(fakeRunner().runner, dir).binPath())).toMatch(/^rne-ocr-[0-9a-f]{12}$/);
  });
});
