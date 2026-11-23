import { z } from "zod";
import { writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deviceContext } from "./context.js";
import { run } from "../core/exec.js";
import { text } from "../core/format.js";
import { toToolError, UserInputError } from "../core/errors.js";
import type { DeviceDriver } from "../drivers/types.js";

let shotSeq = 0;

// --- Inline-image size ceilings ---------------------------------------------
//
// Anthropic's Messages API rejects images over roughly 8000px on either side,
// and images run to roughly 5MB once base64-encoded before they're treated as
// oversized (Anthropic's documented vision image size and dimension limits; the
// URL is deliberately not quoted here — the privacy test forbids any non-local
// URL in source, which is what proves this server talks to nothing). A
// screenshot handed back verbatim
// — no downscaler available, or full_res:true — can clear either ceiling and
// take down the calling agent's session instead of failing cleanly (see
// mobile-next/mobile-mcp#140, mobile-dev-inc/maestro#2952,
// joshuayoes/ios-simulator-mcp#32/#42), so both are enforced below with
// headroom under the documented numbers.
export const MAX_IMAGE_DIMENSION_PX = 7500; // headroom below Anthropic's ~8000px/side limit
export const MAX_IMAGE_BASE64_BYTES = 4.5 * 1024 * 1024; // headroom below Anthropic's ~5MB base64/image limit

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Parses just enough of a PNG to read its pixel dimensions — IHDR is always
// the first chunk, right after the 8-byte signature — with no image library.
// Returns undefined for anything that isn't a PNG (including our own JPEG
// output, which is always downscaled to 800px wide and never needs this
// check).
function readPngDimensions(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// The same for our own JPEG output: the dimensions sit in the first
// start-of-frame segment. Everything before it is skipped by its length.
function readJpegDimensions(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1];
    // SOF0-SOF15, minus DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return undefined;
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Fails loudly instead of ever returning a payload that could blow up the
// caller: measured size, the ceiling, and the exact way out.
function assertWithinInlineLimits(buf: Buffer, fullRes: boolean): void {
  const wayOut = fullRes
    ? "Retry without full_res, or pass output_path to save the full-resolution file to disk instead."
    : "Pass output_path to save the file to disk instead of returning it inline.";

  const dims = readPngDimensions(buf);
  if (dims && (dims.width > MAX_IMAGE_DIMENSION_PX || dims.height > MAX_IMAGE_DIMENSION_PX)) {
    throw new UserInputError(
      `Screenshot is ${dims.width}x${dims.height}px, over the ${MAX_IMAGE_DIMENSION_PX}px-per-side ceiling for an inline image. ${wayOut}`,
    );
  }

  const base64Bytes = Math.ceil(buf.length / 3) * 4;
  if (base64Bytes > MAX_IMAGE_BASE64_BYTES) {
    throw new UserInputError(
      `Screenshot is ${formatMb(base64Bytes)} base64-encoded, over the ${formatMb(MAX_IMAGE_BASE64_BYTES)} ceiling for an inline image. ${wayOut}`,
    );
  }
}

// --- Downscaler chain --------------------------------------------------------
//
// sips is macOS-only, so a Linux or Windows host previously always got the
// raw PNG back — exactly when the size ceiling above bites. Try each
// commonly-available downscaler in turn and use the first that works; a
// missing binary or a failure falls through to the next one.
const DOWNSCALERS: { cmd: string; buildArgs: (src: string, out: string) => string[] }[] = [
  {
    // macOS. Same arguments as before this change, byte-for-byte.
    cmd: "sips",
    buildArgs: (src, out) => [
      "--resampleWidth",
      "800",
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "70",
      src,
      "--out",
      out,
    ],
  },
  { cmd: "magick", buildArgs: (src, out) => [src, "-resize", "800x", "-quality", "70", out] },
  { cmd: "convert", buildArgs: (src, out) => [src, "-resize", "800x", "-quality", "70", out] },
  {
    cmd: "ffmpeg",
    buildArgs: (src, out) => ["-y", "-loglevel", "error", "-i", src, "-vf", "scale=800:-1", "-q:v", "5", out],
  },
];

const NOT_FOUND_RE = /not found/i;

function freshToolAvailability(): Map<string, boolean> {
  const m = new Map<string, boolean>();
  if (process.platform !== "darwin") m.set("sips", false); // sips only exists on macOS — skip the spawn entirely
  return m;
}

let toolAvailable = freshToolAvailability();

/** Test-only: clears the per-process "known missing" cache and re-seeds it for the current platform. */
export function __resetDownscalerAvailabilityForTests(): void {
  toolAvailable = freshToolAvailability();
}

async function tryDownscaler(
  cmd: string,
  buildArgs: (src: string, out: string) => string[],
  png: Buffer,
  runner: typeof run,
): Promise<Buffer | undefined> {
  // Known missing from an earlier call this process — don't re-probe it.
  if (toolAvailable.get(cmd) === false) return undefined;
  const base = join(tmpdir(), `rne-shot-${process.pid}-${++shotSeq}`);
  const src = `${base}.png`;
  const out = `${base}.jpg`;
  try {
    await writeFile(src, png);
    await runner(cmd, buildArgs(src, out));
    const result = await readFile(out);
    toolAvailable.set(cmd, true);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (NOT_FOUND_RE.test(message)) toolAvailable.set(cmd, false);
    return undefined;
  } finally {
    await rm(src, { force: true }).catch(() => {});
    await rm(out, { force: true }).catch(() => {});
  }
}

// Inline screenshots default to an 800px-wide JPEG (~10x smaller than a native
// PNG) — less transfer, far fewer image tokens for the agent. Tries each
// downscaler in DOWNSCALERS order and returns the first that works; returns
// undefined (raw PNG, subject to the ceiling above) if none are available.
async function compressInline(png: Buffer, runner: typeof run): Promise<Buffer | undefined> {
  for (const { cmd, buildArgs } of DOWNSCALERS) {
    const result = await tryDownscaler(cmd, buildArgs, png, runner);
    if (result) return result;
  }
  return undefined;
}

export type ScreenshotImage = { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };

/**
 * How an image pixel maps to a tap coordinate, when the inline image is not at
 * the device's own resolution. Without it a point read off an 800 px wide
 * image of a 1206 px screen is tapped 0.66× from where it is — the most common
 * way a screenshot-guided tap misses.
 */
async function scaleNote(
  driver: DeviceDriver,
  udid: string,
  png: Buffer,
  jpg: Buffer,
): Promise<string | undefined> {
  const orig = readPngDimensions(png);
  if (!orig || orig.width <= 0) return undefined;
  // Every downscaler resamples to 800 px wide; the JPEG says exactly.
  const out = readJpegDimensions(jpg) ?? { width: 800, height: Math.round((orig.height * 800) / orig.width) };
  if (out.width <= 0 || out.width >= orig.width) return undefined;
  const pxPerImagePx = orig.width / out.width;
  const screenScale = await driver.screenScale?.(udid).catch(() => undefined);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  const head = `Image is ${out.width}x${out.height}, downscaled from ${orig.width}x${orig.height} screen pixels:`;
  if (typeof screenScale === "number" && screenScale > 0) {
    return `${head} multiply a point's image coordinates by ${round(pxPerImagePx / screenScale)} to get tap coordinates (${
      driver.platform === "android" ? "pixels" : "points"
    }).`;
  }
  return `${head} multiply a point's image coordinates by ${round(pxPerImagePx)} to get screen pixels.`;
}

/** The inline image, plus the image→tap scale line when it was downscaled. */
export async function captureScreenshot(
  driver: DeviceDriver,
  udid: string,
  opts?: { fullRes?: boolean; runner?: typeof run },
): Promise<{ image: ScreenshotImage; scaleNote?: string }> {
  const png = await driver.screenshotPng(udid);
  const fullRes = opts?.fullRes ?? false;
  let buf: Buffer = png;
  let mimeType: "image/png" | "image/jpeg" = "image/png";
  let note: string | undefined;
  if (!fullRes) {
    const jpg = await compressInline(png, opts?.runner ?? run);
    if (jpg) {
      buf = jpg;
      mimeType = "image/jpeg";
      note = await scaleNote(driver, udid, png, jpg);
    }
  }
  assertWithinInlineLimits(buf, fullRes);
  return { image: { type: "image", data: buf.toString("base64"), mimeType }, scaleNote: note };
}

export async function captureScreenshotContent(
  driver: DeviceDriver,
  udid: string,
  opts?: { fullRes?: boolean; runner?: typeof run },
): Promise<ScreenshotImage> {
  return (await captureScreenshot(driver, udid, opts)).image;
}

export function registerScreenshotTools(
  server: McpServer,
  opts?: { drivers?: DeviceDriver[]; runner?: typeof run },
): void {
  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description:
        "Capture the current screen. Without output_path returns an inline JPEG downscaled to 800px (pass full_res:true for the native PNG); an image that would still be too large for the caller fails with an actionable error instead of being returned. With output_path saves to a file (format png/jpeg; mask is iOS-only) and returns the path.",
      inputSchema: {
        output_path: z
          .string()
          .optional()
          .describe("Save to this file instead of returning the image inline; returns the path."),
        format: z.enum(["png", "jpeg"]).optional().describe("File format with output_path (default png)."),
        mask: z
          .enum(["ignored", "alpha", "black"])
          .optional()
          .describe("iOS only, with output_path: how the device's rounded-corner mask is drawn."),
        full_res: z
          .boolean()
          .optional()
          .describe("Return the native-resolution PNG inline instead of an 800 px wide JPEG."),
        device: z.string().optional().describe("Device udid/serial or name substring; default: the connected or only booted device."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ output_path, format, mask, full_res, device }) => {
      try {
        const { driver, udid } = await deviceContext({ ...opts, device });
        if (!output_path) {
          const shot = await captureScreenshot(driver, udid, { fullRes: full_res, runner: opts?.runner });
          return {
            content: shot.scaleNote ? [shot.image, { type: "text" as const, text: shot.scaleNote }] : [shot.image],
          };
        }
        if (mask && driver.platform !== "ios") throw new UserInputError("mask is iOS-only.");
        await driver.screenshotFile(udid, output_path, { format: format ?? "png", mask });
        return text(`Saved screenshot to ${output_path}`);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
