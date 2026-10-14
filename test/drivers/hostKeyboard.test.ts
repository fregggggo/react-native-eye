import { describe, it, expect } from "vitest";
import { activeKeyboardLayout, isAsciiSafeLayout } from "../../src/drivers/hostKeyboard.js";
import { DriverError } from "../../src/core/errors.js";
import { TIMEOUTS } from "../../src/core/exec.js";

function stubRunner(result: { stdout?: string; throws?: Error }) {
  const calls: { cmd: string; args: string[]; timeoutMs?: number }[] = [];
  const runner = async (cmd: string, args: string[], opts?: { timeoutMs?: number }) => {
    calls.push({ cmd, args, timeoutMs: opts?.timeoutMs });
    if (result.throws) throw result.throws;
    return { stdout: result.stdout ?? "", stdoutBuffer: Buffer.from(result.stdout ?? ""), stderr: "" };
  };
  return { calls, runner: runner as any };
}

describe("activeKeyboardLayout", () => {
  it("reads the id out of defaults and trims the trailing newline", async () => {
    const { calls, runner } = stubRunner({ stdout: "com.apple.keylayout.Greek\n" });
    expect(await activeKeyboardLayout(runner)).toBe("com.apple.keylayout.Greek");
    expect(calls).toEqual([
      {
        cmd: "defaults",
        args: ["read", "com.apple.HIToolbox", "AppleCurrentKeyboardLayoutInputSourceID"],
        timeoutMs: TIMEOUTS.key,
      },
    ]);
  });

  it("returns undefined when the key is absent and defaults exits non-zero", async () => {
    const { runner } = stubRunner({
      throws: new DriverError(
        "defaults failed: The domain/default pair of (com.apple.HIToolbox, " +
          "AppleCurrentKeyboardLayoutInputSourceID) does not exist",
      ),
    });
    expect(await activeKeyboardLayout(runner)).toBeUndefined();
  });

  it("treats an empty value as unreadable", async () => {
    const { runner } = stubRunner({ stdout: "\n" });
    expect(await activeKeyboardLayout(runner)).toBeUndefined();
  });
});

describe("isAsciiSafeLayout", () => {
  it("accepts an unreadable layout — not knowing is not evidence of a bad one", () => {
    expect(isAsciiSafeLayout(undefined)).toBe(true);
  });

  it("accepts U.S.", () => {
    expect(isAsciiSafeLayout("com.apple.keylayout.US")).toBe(true);
  });

  it("accepts the ABC variants", () => {
    expect(isAsciiSafeLayout("com.apple.keylayout.ABC")).toBe(true);
    expect(isAsciiSafeLayout("com.apple.keylayout.ABC-AZERTY")).toBe(true);
  });

  it("refuses a non-Latin layout (Greek)", () => {
    expect(isAsciiSafeLayout("com.apple.keylayout.Greek")).toBe(false);
  });

  it("denies by default — an unlisted layout is unsafe", () => {
    expect(isAsciiSafeLayout("com.apple.keylayout.Greek")).toBe(false);
    expect(isAsciiSafeLayout("com.apple.inputmethod.SCIM.ITABC")).toBe(false);
  });
});
