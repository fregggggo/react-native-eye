import type { FrameStats } from "../drivers/types.js";

const MARKER = "---PROFILEDATA---";

type Block = { summary: Summary; durationsMs: number[] };
type Summary = Omit<FrameStats, "durationMs" | "frameDurationsMs" | "unparsed">;

function num(re: RegExp, line: string): number | undefined {
  const m = re.exec(line);
  return m ? Number(m[1]) : undefined;
}

/**
 * Turns one CSV block into per-frame durations. Columns are looked up by NAME:
 * Android 12 inserted FrameTimelineVsyncId as the second column, so every fixed
 * index after Flags moved, and a hard-coded index silently reads the wrong
 * nanosecond counter rather than failing.
 */
function parseBlock(header: string, rows: string[]): number[] {
  const cols = header.split(",").map((c) => c.trim());
  const flags = cols.indexOf("Flags");
  const intended = cols.indexOf("IntendedVsync");
  const completed = cols.indexOf("FrameCompleted");
  if (intended < 0 || completed < 0) return [];
  const out: number[] = [];
  for (const row of rows) {
    const cells = row.split(",");
    if (cells.length <= completed) continue;
    // A non-zero Flags cell is the framework saying "do not count this frame"
    // (window layout changed, first draw). Those frames run into the hundreds
    // of ms and would be reported as jank the user cannot do anything about.
    if (flags >= 0 && cells[flags].trim() !== "0") continue;
    const a = Number(cells[intended]);
    const b = Number(cells[completed]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    out.push((b - a) / 1e6);
  }
  return out;
}

/**
 * Parses `dumpsys gfxinfo <package> framestats`. The dump carries one section
 * per window, each with its own summary and its own PROFILEDATA block, and the
 * app's own window is rarely the first: reading block #1 reported "0 frames"
 * for a busy app because the ScreenDecorOverlay's block is always empty. The
 * block with the most frames is the one the app rendered into.
 */
export function parseGfxinfo(out: string): Omit<FrameStats, "durationMs"> {
  const lines = out.split("\n");
  const blocks: Block[] = [];
  let summary: Summary = {};

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith(MARKER)) {
      const header = lines[++i] ?? "";
      const rows: string[] = [];
      while (i + 1 < lines.length && !lines[i + 1].trim().startsWith(MARKER)) rows.push(lines[++i]);
      i++; // the closing marker
      blocks.push({ summary, durationsMs: parseBlock(header, rows) });
      summary = {};
      continue;
    }
    const total = num(/^Total frames rendered:\s*(\d+)/, line);
    if (total !== undefined) summary.totalRendered = total;
    const janky = /^Janky frames:\s*(\d+)\s*\(([\d.]+)%\)/.exec(line);
    if (janky) {
      summary.jankyFrames = Number(janky[1]);
      summary.jankyPct = Number(janky[2]);
    }
    const pct = /^(50|90|95|99)th percentile:\s*(\d+)ms/.exec(line);
    if (pct) {
      summary.percentilesMs = { ...summary.percentilesMs, [`p${pct[1]}`]: Number(pct[2]) };
    }
  }

  const best = blocks.reduce<Block | undefined>(
    (a, b) => (a && a.durationsMs.length >= b.durationsMs.length ? a : b),
    undefined,
  );
  if (!best || best.durationsMs.length === 0) {
    return {
      frameDurationsMs: [],
      ...(best?.summary ?? {}),
      unparsed: out.trim().split("\n").slice(0, 5).join("\n"),
    };
  }
  return { frameDurationsMs: best.durationsMs, ...best.summary };
}
