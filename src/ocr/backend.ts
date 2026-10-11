import { run } from "../core/exec.js";
import { DriverError } from "../core/errors.js";
import { VisionOcr } from "./vision.js";

/** One recognized text run, in screenshot pixels with a top-left origin. */
export type OcrLine = { text: string; x: number; y: number; w: number; h: number; confidence: number };

export type OcrResult = { width: number; height: number; lines: OcrLine[]; backend: "vision" };

export interface OcrBackend {
  readonly name: "vision";
  recognize(pngPath: string, opts?: { languages?: string[] }): Promise<OcrResult>;
}

export const OCR_NEEDS_MACOS =
  "read_screen_text needs a macOS host in this version: OCR runs on the machine running the MCP server through the Vision framework. Run the server on a Mac, or use get_layout for text from the app's tree.";

// `platform` is a parameter only so the non-macOS branch is testable without
// patching process.platform.
export function selectOcrBackend(runner: typeof run = run, platform: NodeJS.Platform = process.platform): OcrBackend {
  if (platform !== "darwin") throw new DriverError(OCR_NEEDS_MACOS);
  return new VisionOcr(runner);
}
