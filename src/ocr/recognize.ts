import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { run } from "../core/exec.js";
import type { DeviceDriver } from "../drivers/types.js";
import { resolveViewport, type EvalConn } from "../tools/layout.js";
import { selectOcrBackend, type OcrBackend, type OcrLine, type OcrResult } from "./backend.js";

export type RecognizedScreen = {
  /** Text runs in the driver's tap units (iOS points, Android pixels), rounded. */
  lines: OcrLine[];
  /** Screenshot pixels per tap unit that was applied. */
  scale: number;
  note?: string;
  backend: OcrResult["backend"];
  /** Screenshot size in pixels. */
  width: number;
  height: number;
  ms: number;
};

let seq = 0;

export function toTapUnits(lines: OcrLine[], scale: number): OcrLine[] {
  const s = scale > 0 ? scale : 1;
  const r = (n: number) => Math.round(n / s);
  return lines.map((l) => ({ ...l, x: r(l.x), y: r(l.y), w: r(l.w), h: r(l.h) }));
}

/**
 * OCR the native-resolution screenshot (never the 800px inline JPEG) and
 * return boxes in tap units. The pixel→tap scale comes from the driver; when
 * it cannot tell, the app's own viewport width is the next best witness.
 */
export async function recognizeScreen(
  driver: DeviceDriver,
  udid: string,
  o?: { backend?: OcrBackend; runner?: typeof run; conn?: EvalConn; languages?: string[] },
): Promise<RecognizedScreen> {
  const t0 = Date.now();
  // Select first: a host that cannot OCR should not pay for a screenshot.
  const backend = o?.backend ?? selectOcrBackend(o?.runner);
  const png = await driver.screenshotPng(udid);
  const path = join(tmpdir(), `rne-ocr-${process.pid}-${++seq}.png`);
  let result: OcrResult;
  try {
    await writeFile(path, png);
    result = await backend.recognize(path, { languages: o?.languages });
  } finally {
    await rm(path, { force: true }).catch(() => {});
  }

  let note: string | undefined;
  let scale = await driver.screenScale?.(udid).catch(() => undefined);
  if (!(typeof scale === "number" && scale > 0)) {
    const vp = o?.conn ? await resolveViewport(driver, udid, o.conn).catch(() => undefined) : undefined;
    if (vp && vp.w > 0 && result.width > 0) {
      scale = result.width / vp.w;
      note = `scale derived from the app viewport (${result.width}px / ${vp.w})`;
    } else {
      scale = 1;
      note = "screen scale unknown — coordinates are screenshot pixels, which may not be tap units";
    }
  }
  return {
    lines: toTapUnits(result.lines, scale),
    scale,
    note,
    backend: result.backend,
    width: result.width,
    height: result.height,
    ms: Date.now() - t0,
  };
}
