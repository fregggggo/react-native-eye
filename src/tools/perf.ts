import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deviceContext } from "./context.js";
import { text, truncate } from "../core/format.js";
import { toToolError, UserInputError } from "../core/errors.js";
import type { Connection } from "../core/registry.js";
import type { CpuSample, CpuThread, DeviceDriver, FrameStats } from "../drivers/types.js";

const DEFAULT_SAMPLE_S = 3;
const MAX_SAMPLE_S = 30;
const DEFAULT_FPS_MS = 2000;
const MAX_FPS_MS = 15000;
/** Threads worth printing: enough to show main/js plus whatever else is hot. */
const MAX_THREAD_ROWS = 8;
const MAX_FRAMES_PER_THREAD = 5;

function clamp(v: number | undefined, def: number, min: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, Math.round(v)));
}

// Padded to 6 so "100.0%" does not push the column it sits in out of line.
function pct(x: number | undefined): string {
  return (x === undefined ? "n/a" : `${(x * 100).toFixed(1)}%`).padStart(6);
}

function ms(x: number | undefined): string {
  return x === undefined ? "n/a" : `${x.toFixed(1)}ms`;
}

/** Nearest-rank percentile over an unsorted list; undefined for an empty one. */
function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function threadLabel(t: CpuThread): string {
  return truncate(t.name ?? `Thread_${t.id}`, 52);
}

function formatCpu(sample: CpuSample, appId: string, deviceName: string, platform: string): string {
  if (sample.unparsed) {
    return (
      `CPU sample — ${appId} (pid ${sample.pid}) on ${deviceName}: could not parse the ${platform} output.\n\n` +
      sample.unparsed
    );
  }
  const counts =
    sample.totalSamples !== undefined
      ? `, ${sample.totalSamples} samples (${sample.busySamples ?? 0} off a blocking syscall)`
      : "";
  const lines = [`CPU sample — ${appId} (pid ${sample.pid}) on ${deviceName}, ${sample.durationS}s${counts}`, ""];

  const rows = [...sample.threads].sort((a, b) => b.share - a.share);
  const shown = rows.slice(0, MAX_THREAD_ROWS);
  const hasBusy = shown.some((t) => t.busyFraction !== undefined);
  const hasCpu = shown.some((t) => t.cpuPercent !== undefined);
  lines.push(`role     share${hasBusy ? "   busy" : ""}${hasCpu ? "   %cpu" : ""}  thread`);
  for (const t of shown) {
    const busy = hasBusy ? `  ${pct(t.busyFraction)}` : "";
    const cpu = hasCpu ? `  ${(t.cpuPercent ?? 0).toFixed(1).padStart(6)}` : "";
    lines.push(`${t.role.padEnd(7)} ${pct(t.share)}${busy}${cpu}  ${threadLabel(t)}`);
  }
  if (rows.length > shown.length) lines.push(`… ${rows.length - shown.length} more threads, all below the shown ones`);
  lines.push("");
  lines.push(
    hasBusy
      ? "share = this thread's cut of the app's CPU work; busy = how much of the window it spent NOT parked in a blocking syscall."
      : "share = this thread's cut of the app's CPU; %cpu is per core, so 100% is one full core.",
  );

  // Only the two threads the caller is actually deciding between: a frame list
  // for every worker would bury them.
  for (const role of ["main", "js"] as const) {
    const t = rows.find((x) => x.role === role);
    if (!t?.topFrames?.length) continue;
    lines.push("", `${role} thread — hottest frames (blocking syscalls excluded)`);
    for (const f of t.topFrames.slice(0, MAX_FRAMES_PER_THREAD)) {
      lines.push(`  ${pct(f.share)}  ${truncate(f.frame, 96)}`);
    }
  }
  if (sample.note) lines.push("", `Note: ${sample.note}`);
  return lines.join("\n");
}

/**
 * Counts requestAnimationFrame callbacks for `durationMs` and reports the gaps
 * between them. ES5 and promise-returning, per core/evaluate.ts: Hermes has no
 * async/await in evaluated code, and the wrapper picks the value up by polling.
 *
 * This measures the JS thread's callback rate, which is not the frame rate the
 * screen showed — the UI thread can keep presenting frames while JS is blocked,
 * and vice versa. It is the only frame signal available with nothing installed
 * into the app, which is why it is labelled so loudly in the output.
 */
export function rafSnippet(durationMs: number): string {
  return `(function () {
  var raf = globalThis.requestAnimationFrame;
  if (typeof raf !== "function") return { error: "this runtime has no requestAnimationFrame" };
  if (typeof globalThis.Promise !== "function") return { error: "this runtime has no Promise" };
  return new globalThis.Promise(function (resolve) {
    var t0 = Date.now(), last = t0, frames = 0, maxGap = 0, slow = 0;
    function tick() {
      var now = Date.now(), gap = now - last;
      last = now;
      frames++;
      if (frames > 1) {
        if (gap > maxGap) maxGap = gap;
        if (gap > 32) slow++;
      }
      if (now - t0 >= ${durationMs}) {
        resolve({ frames: frames, elapsedMs: now - t0, maxGapMs: maxGap, slowGaps: slow });
        return;
      }
      raf(tick);
    }
    raf(tick);
  });
})()`;
}

type RafResult = { frames?: number; elapsedMs?: number; maxGapMs?: number; slowGaps?: number; error?: string };

function formatRaf(raf: RafResult | undefined, failure?: string): string[] {
  const lines = ["JS-thread FPS (rAF)"];
  if (failure) {
    lines.push(`  unavailable: ${failure}`);
    return lines;
  }
  if (!raf || raf.error) {
    lines.push(`  unavailable: ${raf?.error ?? "the app returned nothing"}`);
    return lines;
  }
  const frames = raf.frames ?? 0;
  const elapsed = raf.elapsedMs ?? 0;
  const fps = elapsed > 0 ? (frames / elapsed) * 1000 : 0;
  lines.push(`  ${frames} callbacks in ${elapsed}ms → ${fps.toFixed(1)} fps on the JS thread`);
  lines.push(
    `  worst gap ${raf.maxGapMs ?? 0}ms; ${raf.slowGaps ?? 0} gap(s) over 32ms (two dropped frames at 60Hz)`,
  );
  lines.push("  This is how often JS ran a frame callback, not what the screen presented.");
  return lines;
}

function formatFrameStats(stats: FrameStats): string[] {
  const lines = ["UI-thread frames (dumpsys gfxinfo)"];
  if (stats.unparsed) {
    lines.push(`  no frame data in the dump: ${truncate(stats.unparsed.split("\n")[0], 120)}`);
    lines.push("  The app renders only when something changes — a still screen produces no frames at all.");
    return lines;
  }
  const d = stats.frameDurationsMs;
  const produced = (d.length / stats.durationMs) * 1000;
  const janky = stats.jankyFrames !== undefined ? ` janky ${stats.jankyFrames} (${(stats.jankyPct ?? 0).toFixed(1)}%)` : "";
  const plural = d.length === 1 ? "frame" : "frames";
  lines.push(`  ${d.length} ${plural} in ${stats.durationMs}ms → ${produced.toFixed(1)} frames/s produced;${janky}`);
  lines.push(
    `  frame latency (vsync → completed): p50 ${ms(percentile(d, 50))}  p90 ${ms(percentile(d, 90))}  p99 ${ms(
      percentile(d, 99),
    )}`,
  );
  lines.push("  Over ~16.7ms at 60Hz is a missed frame. Only frames the app actually produced are counted:");
  lines.push("  an idle screen renders a handful of frames, which is not a low frame rate.");
  return lines;
}

export function registerPerfTools(server: McpServer, opts?: { drivers?: DeviceDriver[] }): void {
  const resolveApp = (conn: Connection | undefined, appId: string | undefined): string => {
    // The CDP target reports the bundle id / package of the app being debugged;
    // reuse it rather than making the caller repeat it (as set_permission does).
    const id = appId ?? conn?.meta.appId;
    if (!id) throw new UserInputError("No app is connected — pass app_id (the bundle id / package name).");
    return id;
  };

  server.registerTool(
    "sample_cpu",
    {
      title: "Sample CPU by thread",
      description:
        "Profile the running app's threads for a few seconds and report which one is hot — the UI/main thread, the JS thread, or something else. iOS simulator: macOS `sample`, with native call-graph frames. Android: `top -H`, per-thread %CPU only (no frames).",
      inputSchema: {
        duration_s: z.number().optional(),
        app_id: z.string().optional(),
        device: z.string().optional(),
      },
    },
    async ({ duration_s, app_id, device }) => {
      try {
        const { driver, udid, name, conn } = await deviceContext({ ...opts, device });
        if (!driver.cpuSample) {
          throw new UserInputError(`sample_cpu is not supported on ${driver.platform}.`);
        }
        const durationS = clamp(duration_s, DEFAULT_SAMPLE_S, 1, MAX_SAMPLE_S);
        const appId = resolveApp(conn, app_id);
        const sample = await driver.cpuSample(udid, appId, durationS);
        return text(formatCpu(sample, appId, name, driver.platform));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "get_fps",
    {
      title: "Measure frame timing",
      description:
        "Measure frame timing for a short window. Android also reports real UI-thread frames from dumpsys gfxinfo; on the iOS simulator only the JS-thread requestAnimationFrame rate is available (UI-thread frames need a physical device and xctrace).",
      inputSchema: {
        duration_ms: z.number().optional(),
        app_id: z.string().optional(),
        device: z.string().optional(),
      },
    },
    async ({ duration_ms, app_id, device }) => {
      try {
        const { driver, udid, name, conn } = await deviceContext({ ...opts, device });
        const durationMs = clamp(duration_ms, DEFAULT_FPS_MS, 100, MAX_FPS_MS);
        const appId = resolveApp(conn, app_id);

        // Both measurements cover the same window, so they are started together
        // — running them back to back would double the wall time and compare two
        // different moments of the app's life.
        const [native, raf] = await Promise.all([
          driver.frameStats
            ? driver.frameStats(udid, appId, durationMs).then(
                (v) => ({ ok: true as const, v }),
                (e: unknown) => ({ ok: false as const, e: e instanceof Error ? e.message : String(e) }),
              )
            : Promise.resolve(undefined),
          conn
            ? conn.evaluate(rafSnippet(durationMs), { timeoutMs: durationMs + 8000 }).then(
                (v: RafResult) => ({ ok: true as const, v }),
                (e: unknown) => ({ ok: false as const, e: e instanceof Error ? e.message : String(e) }),
              )
            : Promise.resolve(undefined),
        ]);

        const lines = [`Frame timing — ${appId} on ${name}, ${durationMs}ms window`, ""];
        if (!native) {
          lines.push("UI-thread frames: not available on the iOS simulator.");
          lines.push(
            "  CADisplayLink needs native code inside the app, and xctrace's Core Animation FPS instrument",
          );
          lines.push("  only runs against a physical device. The JS-thread figure below is the proxy.");
        } else if (native.ok) {
          lines.push(...formatFrameStats(native.v));
        } else {
          lines.push("UI-thread frames (dumpsys gfxinfo)", `  unavailable: ${native.e}`);
        }
        lines.push("");
        lines.push(
          ...formatRaf(
            raf?.ok ? raf.v : undefined,
            raf === undefined ? "no app runtime is connected — run connect first" : raf.ok ? undefined : raf.e,
          ),
        );
        return text(lines.join("\n"));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
