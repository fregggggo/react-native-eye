import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run as defaultRun, TIMEOUTS } from "../core/exec.js";
import { DriverError } from "../core/errors.js";
import { VISION_OCR_SOURCE } from "./visionSource.js";
import type { OcrBackend, OcrLine, OcrResult } from "./backend.js";

export function defaultOcrCacheDir(): string {
  return process.env.RNE_CACHE_DIR ?? join(homedir(), "Library", "Caches", "react-native-eye");
}

export function ocrSourceHash(): string {
  return createHash("sha1").update(VISION_OCR_SOURCE).digest("hex").slice(0, 12);
}

// Two first calls in flight at once must not both run swiftc into the same path.
const inflight = new Map<string, Promise<string>>();

function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Apple Vision, driven through a small Swift helper that is compiled once per
 * source version into the cache dir and reused from then on.
 */
export class VisionOcr implements OcrBackend {
  readonly name = "vision" as const;
  constructor(
    private runner: typeof defaultRun = defaultRun,
    private cacheDir: string = defaultOcrCacheDir(),
  ) {}

  /** Named after the source hash, so editing the Swift can never serve a stale helper. */
  binPath(): string {
    return join(this.cacheDir, `rne-ocr-${ocrSourceHash()}`);
  }

  async ensureBinary(): Promise<string> {
    const bin = this.binPath();
    if (await exists(bin)) return bin;
    let p = inflight.get(bin);
    if (!p) {
      p = this.compile(bin).finally(() => inflight.delete(bin));
      inflight.set(bin, p);
    }
    return p;
  }

  private async compile(bin: string): Promise<string> {
    const src = `${bin}.swift`;
    const tmp = `${bin}.tmp-${process.pid}`;
    try {
      await mkdir(this.cacheDir, { recursive: true });
      await writeFile(src, VISION_OCR_SOURCE);
      await this.runner("swiftc", ["-O", "-o", tmp, src], {
        timeoutMs: TIMEOUTS.compile,
        hint: "First use compiles a small Swift helper for Apple Vision; this happens once per version.",
      });
      await rename(tmp, bin); // atomic: a half-written binary is never at `bin`
      return bin;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/^swiftc not found/.test(msg)) {
        throw new DriverError(
          "OCR needs the Swift compiler. Install the Xcode Command Line Tools with `xcode-select --install` (or Xcode), then retry.",
        );
      }
      throw new DriverError(
        `OCR helper failed to compile (cache dir ${this.cacheDir}, override with RNE_CACHE_DIR): ${msg.slice(-1500)}`,
      );
    } finally {
      await rm(src, { force: true }).catch(() => {});
      await rm(tmp, { force: true }).catch(() => {});
    }
  }

  async recognize(pngPath: string, opts?: { languages?: string[] }): Promise<OcrResult> {
    const bin = await this.ensureBinary();
    const args = [pngPath];
    if (opts?.languages?.length) args.push("--languages", opts.languages.join(","));
    // A non-zero exit surfaces from run() as "<bin> failed: <stderr>" — the
    // helper's own message (bad language, undecodable image), which is what
    // the agent should read.
    const { stdout } = await this.runner(bin, args, {
      timeoutMs: TIMEOUTS.ocr,
      hint: "Vision OCR on one screenshot normally takes about a second.",
    });
    let parsed: any;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new DriverError(`OCR helper returned invalid JSON: ${stdout.slice(0, 200)}`);
    }
    if (!parsed || typeof parsed.width !== "number" || typeof parsed.height !== "number" || !Array.isArray(parsed.lines)) {
      throw new DriverError("OCR helper returned an unexpected result shape");
    }
    const lines: OcrLine[] = parsed.lines
      .map((l: any) => ({
        text: String(l?.text ?? "").trim(),
        x: Number(l?.x),
        y: Number(l?.y),
        w: Number(l?.w),
        h: Number(l?.h),
        confidence: Number(l?.confidence),
      }))
      .filter((l: OcrLine) => l.text.length > 0 && [l.x, l.y, l.w, l.h].every(Number.isFinite));
    return { width: parsed.width, height: parsed.height, lines, backend: "vision" };
  }
}
