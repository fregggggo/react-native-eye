import { describe, it, expect, afterEach } from "vitest";
import { selectOcrBackend } from "../../src/ocr/backend.js";
import { defaultOcrCacheDir } from "../../src/ocr/vision.js";
import { DriverError } from "../../src/core/errors.js";

const noRunner = (async () => {
  throw new Error("runner must not be called during backend selection");
}) as any;

describe("selectOcrBackend", () => {
  it("selects the Vision backend on macOS", () => {
    expect(selectOcrBackend(noRunner, "darwin").name).toBe("vision");
  });

  it("tells non-macOS hosts what to do instead", () => {
    expect(() => selectOcrBackend(noRunner, "linux")).toThrow(DriverError);
    expect(() => selectOcrBackend(noRunner, "win32")).toThrow(/macOS/);
  });
});

describe("defaultOcrCacheDir", () => {
  const saved = process.env.RNE_CACHE_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.RNE_CACHE_DIR;
    else process.env.RNE_CACHE_DIR = saved;
  });

  it("honours RNE_CACHE_DIR", () => {
    process.env.RNE_CACHE_DIR = "/tmp/rne-cache-x";
    expect(defaultOcrCacheDir()).toBe("/tmp/rne-cache-x");
  });

  it("defaults to the user's Library/Caches", () => {
    delete process.env.RNE_CACHE_DIR;
    expect(defaultOcrCacheDir().endsWith("Library/Caches/react-native-eye")).toBe(true);
  });
});
