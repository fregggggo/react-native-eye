import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegistry, type Connection } from "../core/registry.js";
import { symbolicate, type SymbolicateFrame } from "../core/metro.js";
import { summarizeProfile, type CpuProfile, type Entry } from "../profile/cpuprofile.js";
import { text } from "../core/format.js";
import { toToolError, ConnectionError, RuntimeError } from "../core/errors.js";

const DEFAULT_DURATION_MS = 5000;
const MAX_DURATION_MS = 120000;
const DEFAULT_TOP = 20;

/**
 * Extra time `Profiler.stop` gets on top of the profile's own length.
 *
 * Stopping only answers once the JS thread returns to the event loop, and the
 * app worth profiling is usually the one that is busy — so the normal 15s CDP
 * deadline would fire on exactly the runs that matter most.
 */
export const STOP_GRACE_MS = 30000;

/** Metro is asked about the top rows only; a full profile has thousands of frames. */
const MAX_SYMBOLICATE_FRAMES = 200;

/** The part of CdpClient this tool needs — narrow so tests can hand in a stub. */
export type CdpSender = {
  send(method: string, params?: object, opts?: { timeoutMs?: number }): Promise<any>;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The Profiler domain has no Runtime.evaluate equivalent — a sampling profiler
 * lives in the VM and can only be driven over CDP — so this is the one tool
 * that takes Connection.cdp instead of evaluate().
 */
function cdpOf(conn: Connection): CdpSender {
  return conn.cdp;
}

/**
 * Runs one sampling profile and hands back the raw `.cpuprofile`. Separate from
 * the tool so the CDP choreography — especially the stop deadline — is testable
 * without a server.
 */
export async function captureProfile(
  cdp: CdpSender,
  opts: { durationMs: number; samplingIntervalUs?: number },
): Promise<{ profile: CpuProfile; notes: string[] }> {
  const notes: string[] = [];
  try {
    // Hermes' CDP agent takes Profiler.enable, but the domain works without it
    // in some builds — a rejection here is not a reason to give up the profile.
    await cdp.send("Profiler.enable").catch(() => {});

    if (opts.samplingIntervalUs) {
      await cdp.send("Profiler.setSamplingInterval", { interval: opts.samplingIntervalUs }).catch(() => {
        // Hermes' sampling profiler has historically run at its own fixed
        // interval; silently sampling at a different rate than asked would make
        // the numbers below quietly wrong, so say it out loud instead.
        notes.push(
          `Hermes rejected sampling_interval_us (${opts.samplingIntervalUs}µs) — it sampled at its own default interval.`,
        );
      });
    }

    try {
      await cdp.send("Profiler.start");
    } catch (err) {
      throw new RuntimeError(
        `could not start the sampling profiler: ${
          err instanceof Error ? err.message : String(err)
        } — this app's Hermes build may not expose the Profiler domain.`,
      );
    }
    await sleep(opts.durationMs);

    let result: any;
    try {
      result = await cdp.send("Profiler.stop", {}, { timeoutMs: opts.durationMs + STOP_GRACE_MS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/timed out/i.test(message)) {
        // The generic "target is stale" wording is wrong here: the socket is
        // fine, the thread is simply not coming back to answer.
        throw new RuntimeError(
          `the profile ran but Profiler.stop did not answer within ${
            opts.durationMs + STOP_GRACE_MS
          }ms — the JS thread is blocked (a synchronous loop, or a native call it is waiting on). Retry with a longer duration_ms, or check sample_cpu to see whether the thread is busy at all.`,
        );
      }
      throw err;
    }

    const profile = result?.profile;
    if (!profile || !Array.isArray(profile.nodes)) {
      throw new RuntimeError(
        "the app answered Profiler.stop with no profile — this Hermes build may have the sampling profiler compiled out",
      );
    }
    return { profile: profile as CpuProfile, notes };
  } finally {
    // Leaving the domain enabled keeps the VM sampling after we stop reading,
    // so this runs even when the profile itself failed.
    await cdp.send("Profiler.disable").catch(() => {});
  }
}

/** Same convention as record_video: RNE_OUTPUT_DIR, else ~/Downloads. */
function defaultProfilePath(): string {
  const dir = process.env.RNE_OUTPUT_DIR || join(homedir(), "Downloads");
  // Colons are legal in a POSIX filename but break the file on Windows shares
  // and in most shells, so the ISO stamp is flattened the way recordings are.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dir, `rne-profile-${stamp}.cpuprofile`);
}

type Display = { name: string; file: string; line: number };

function positionKey(e: Entry): string {
  return `${e.url}:${e.line}:${e.col}`;
}

/** `http://localhost:8081/index.bundle?platform=ios` -> `index.bundle`. */
function shortFile(file: string): string {
  if (!file) return "<native>";
  return basename(file.split(/[?#]/)[0]) || file;
}

/**
 * Best-effort source positions for the rows we are about to print.
 *
 * The entries already carry 1-based line/column (profile/cpuprofile.ts converts
 * CDP's 0-based numbers once), which is exactly what Metro's /symbolicate
 * expects, so the frames go out as they are.
 */
async function resolveDisplay(
  entries: Entry[],
  port: number,
): Promise<{ display: Map<string, Display>; note?: string }> {
  const display = new Map<string, Display>();
  const unique = new Map<string, Entry>();
  for (const e of entries) {
    if (!e.url) continue;
    const key = positionKey(e);
    if (!unique.has(key)) unique.set(key, e);
  }

  const keys = [...unique.keys()].slice(0, MAX_SYMBOLICATE_FRAMES);
  if (keys.length === 0) return { display };

  const frames: SymbolicateFrame[] = keys.map((key) => {
    const e = unique.get(key)!;
    return { file: e.url, lineNumber: e.line, column: e.col, methodName: e.name };
  });

  const resolved = await symbolicate(port, frames);
  if (!resolved) {
    return {
      display,
      note: `Metro (port ${port}) could not symbolicate these frames — positions below are bundle offsets.`,
    };
  }

  keys.forEach((key, i) => {
    const frame = resolved[i];
    if (!frame?.file) return;
    const original = unique.get(key)!;
    display.set(key, {
      // Metro's methodName is only an improvement when the profile had nothing
      // useful; a real function name from the VM beats a guessed one.
      name: original.name === "(anonymous)" && frame.methodName ? frame.methodName : original.name,
      file: frame.file,
      line: typeof frame.lineNumber === "number" ? frame.lineNumber : original.line,
    });
  });
  return { display, note: undefined };
}

/** Longest function name a row prints; anything longer is cut so the columns stay aligned. */
const MAX_NAME_WIDTH = 32;

function displayName(e: Entry, display: Map<string, Display>): string {
  return display.get(positionKey(e))?.name ?? e.name;
}

function row(e: Entry, display: Map<string, Display>, nameWidth: number): string {
  const d = display.get(positionKey(e));
  const name = displayName(e, display);
  const file = shortFile(d?.file ?? e.url);
  const line = d?.line ?? e.line;
  return [
    `${e.selfMs.toFixed(1)}ms`.padStart(9),
    `${Math.round(e.selfPct)}%`.padStart(5),
    `${e.inclusiveMs.toFixed(1)}ms`.padStart(9),
    `  ${(name.length > nameWidth ? `${name.slice(0, nameWidth - 1)}…` : name).padEnd(nameWidth)}  ${file}:${line}`,
  ].join("");
}

function renderTable(title: string, entries: Entry[], display: Map<string, Display>): string[] {
  const nameWidth = Math.min(
    MAX_NAME_WIDTH,
    Math.max(8, ...entries.map((e) => displayName(e, display).length)),
  );
  const header = `${"self".padStart(9)}${"%".padStart(5)}${"incl".padStart(9)}  ${"function".padEnd(nameWidth)}  file:line`;
  return [title, header, ...entries.map((e) => row(e, display, nameWidth))];
}

function formatDuration(totalMs: number): string {
  return totalMs >= 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${Math.round(totalMs)}ms`;
}

export function registerJsProfileTools(server: McpServer): void {
  server.registerTool(
    "profile_js",
    {
      title: "Profile JS",
      description:
        "Record a Hermes CPU profile for duration_ms, then report where the JS thread spent its time: busy/idle/GC split, the functions with the most self time, and the ones with the most inclusive time (symbolicated through Metro when it can). The raw .cpuprofile is saved to disk and opens in Chrome DevTools → Performance → Load. Drive the app (or leave it alone) while this runs — the profile covers whatever happens during the window.",
      inputSchema: {
        duration_ms: z
          .number()
          .int()
          .positive()
          .max(MAX_DURATION_MS)
          .optional()
          .describe(`How long to sample for (default ${DEFAULT_DURATION_MS}, max ${MAX_DURATION_MS}).`),
        top: z.number().int().positive().max(100).optional().describe(`Rows per table (default ${DEFAULT_TOP}).`),
        sampling_interval_us: z
          .number()
          .int()
          .min(100)
          .optional()
          .describe("Sampling interval in microseconds. Hermes may ignore it and keep its own default."),
        save: z
          .boolean()
          .optional()
          .describe("Write the raw .cpuprofile to disk (default true). Set false to get the summary only."),
      },
    },
    async ({ duration_ms, top, sampling_interval_us, save }) => {
      try {
        const durationMs = duration_ms ?? DEFAULT_DURATION_MS;
        const limit = top ?? DEFAULT_TOP;
        const conn = await getRegistry().ensure();
        const { profile, notes } = await captureProfile(cdpOf(conn), {
          durationMs,
          samplingIntervalUs: sampling_interval_us,
        });

        let savedPath: string | undefined;
        if (save !== false) {
          savedPath = defaultProfilePath();
          await writeFile(savedPath, JSON.stringify(profile));
        }

        const summary = summarizeProfile(profile);
        const lines: string[] = [];
        const head = [
          `${formatDuration(summary.totalMs)} profile`,
          `busy ${Math.round(summary.busyPct)}% · idle ${Math.round(summary.idlePct)}% · GC ${Math.round(summary.gcPct)}%`,
          `${summary.sampleCount} samples`,
          ...(savedPath ? [`saved ${savedPath}`] : []),
        ];
        lines.push(head.join(" · "));

        if (summary.sampleCount === 0 || summary.bySelf.length === 0) {
          lines.push(
            "no samples landed in JS code — the thread was idle for the whole window, or this Hermes build does not sample.",
          );
        } else {
          const bySelf = summary.bySelf.slice(0, limit);
          const byInclusive = summary.byInclusive.slice(0, limit);
          const { display, note } = await resolveDisplay([...bySelf, ...byInclusive], conn.meta.port);
          lines.push("", ...renderTable("Top self:", bySelf, display));
          lines.push("", ...renderTable("Top inclusive:", byInclusive, display));
          if (note) notes.push(note);
        }
        if (notes.length > 0) lines.push("", ...notes);

        if (savedPath) lines.push("", "Open the .cpuprofile in Chrome DevTools → Performance → Load.");
        return text(lines.join("\n"));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
