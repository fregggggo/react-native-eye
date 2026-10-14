import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deviceContext } from "./context.js";
import { captureLayoutWithSource } from "./layout.js";
import { isVisible, type Element } from "../layout/elements.js";
import { text } from "../core/format.js";
import { toToolError } from "../core/errors.js";
import type { run } from "../core/exec.js";
import type { DeviceDriver } from "../drivers/types.js";
import { selectOcrBackend, type OcrBackend, type OcrLine } from "../ocr/backend.js";
import { recognizeScreen, type RecognizedScreen } from "../ocr/recognize.js";

type Rect = { x: number; y: number; w: number; h: number };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Which OCR lines also exist as visible, labelled elements at the same place.
 * Containers carry every child's label glued together and would swallow any
 * substring; decorative icons have no text. Neither counts.
 */
export function markInTree(lines: OcrLine[], els: Element[]): boolean[] {
  const cands = els
    .filter((e) => isVisible(e) && !e.container && e.text && norm(e.text).length > 0)
    .map((e) => ({ t: norm(e.text!), b: e.visible ?? e }));
  return lines.map((l) => {
    const t = norm(l.text);
    if (!t) return false;
    return cands.some((c) => (c.t.includes(t) || t.includes(c.t)) && intersects(l, c.b));
  });
}

/** Vision's own order is only roughly top-to-bottom: group into rows, then left to right. */
export function readingOrder(lines: OcrLine[]): OcrLine[] {
  const byY = [...lines].sort((a, b) => a.y - b.y);
  const rows: OcrLine[][] = [];
  for (const l of byY) {
    const row = rows[rows.length - 1];
    if (row && l.y < row[0].y + row[0].h / 2) row.push(l);
    else rows.push([l]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x));
}

export type ShownLine = { line: OcrLine; inTree?: boolean };

export function formatOcr(
  r: RecognizedScreen,
  o: { shown: ShownLine[]; inTreeTotal?: number; notes: string[]; search?: string[] },
): string {
  const body = o.shown.length
    ? o.shown
        .map(
          ({ line: l, inTree }) =>
            `${l.text} @${Math.round(l.x + l.w / 2)},${Math.round(l.y + l.h / 2)}` +
            (inTree ? " [tree]" : "") +
            (l.confidence < 0.5 ? " (low confidence)" : ""),
        )
        .join("\n")
    : o.search?.length
      ? `(no text matching ${o.search.map((s) => JSON.stringify(s)).join(", ")})`
      : "(no text recognized)";
  const counts = `${r.lines.length} lines${o.inTreeTotal === undefined ? "" : `, ${o.inTreeTotal} in tree`}`;
  const scale = Number(r.scale.toFixed(3));
  const notes = o.notes.length ? ` — ${o.notes.join("; ")}` : "";
  return `${body}\n(ocr: ${r.backend} — ${counts}; scale ${scale} px/pt; ${r.ms}ms${notes})`;
}

export function registerOcrTools(
  server: McpServer,
  opts?: { drivers?: DeviceDriver[]; runner?: typeof run; ocr?: OcrBackend },
): void {
  server.registerTool(
    "read_screen_text",
    {
      title: "Read screen text",
      description:
        "Read the visible text off the screen with on-host OCR (Apple Vision). Works without a Metro connection and sees text the layout tree cannot: images, canvases, WebViews, native dialogs. Returns one line per recognized text run as `<text> @x,y` — x,y is the centre in tap units and can be passed straight to tap {x,y}. Lines that also exist in the app's JS layout are marked [tree]: prefer tap {text} for those, since an OCR box is just text, not a control. Optional: search (substring filters, case-insensitive), languages (e.g. [\"de\",\"en\"]; auto-detected by default), compare_tree (default true). macOS host only; the first call compiles a small Vision helper (~10–30s, cached).",
      inputSchema: {
        search: z.array(z.string()).optional(),
        languages: z.array(z.string()).optional(),
        compare_tree: z.boolean().optional(),
        device: z.string().optional(),
      },
    },
    async ({ search, languages, compare_tree, device }) => {
      try {
        const { driver, udid, conn } = await deviceContext({ ...opts, device });
        // Selected per call: registering the tool must not throw on a host that cannot OCR.
        const backend = opts?.ocr ?? selectOcrBackend(opts?.runner);
        const r = await recognizeScreen(driver, udid, { backend, conn, languages });
        const notes: string[] = r.note ? [r.note] : [];
        const ordered = readingOrder(r.lines);
        let inTree: boolean[] | undefined;
        if (compare_tree ?? true) {
          if (!conn) {
            notes.push("tree comparison skipped: no Metro connection");
          } else {
            // JS path only: the OS tree (axe) can take seconds and this is a hint, not a result.
            try {
              const { els } = await captureLayoutWithSource(driver, udid, { conn, source: "js" });
              inTree = markInTree(ordered, els);
            } catch (err) {
              notes.push(`tree comparison skipped: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
        const terms = (search ?? []).map(norm).filter(Boolean);
        const shown = ordered
          .map((line, i) => ({ line, inTree: inTree?.[i] }))
          .filter(({ line }) => terms.length === 0 || terms.some((t) => norm(line.text).includes(t)));
        return text(
          formatOcr(r, { shown, inTreeTotal: inTree ? inTree.filter(Boolean).length : undefined, notes, search }),
        );
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
