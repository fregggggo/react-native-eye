import { z } from "zod";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdir, stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deviceContext } from "./context.js";
import { text } from "../core/format.js";
import { DriverError, toToolError, UserInputError } from "../core/errors.js";
import type { DeviceDriver, RecordingHandle } from "../drivers/types.js";

let active: { path: string; handle: RecordingHandle } | null = null;

export function resetRecordingState(): void {
  active = null;
}

/** A recording whose recorder process is gone: nothing left to stop or retry. */
const ended = (rec: { handle: RecordingHandle }) => rec.handle.running?.() === false;

/**
 * Session shutdown (src/core/shutdown.ts): ends the recording in progress, if
 * any, the way stop_recording does — SIGINT, so simctl writes the movie out;
 * on Android the device file is pulled as well, best effort. Without this the
 * recorder outlived the server and kept recording into a file that was never
 * finalized. Never throws.
 */
export async function stopActiveRecording(): Promise<void> {
  const rec = active;
  if (!rec) return;
  active = null;
  await rec.handle.finalize().catch(() => {});
}

function defaultPath(): string {
  const dir = process.env.RNE_OUTPUT_DIR || join(homedir(), "Downloads");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dir, `rne-recording-${stamp}.mp4`);
}

export function registerRecordingTools(server: McpServer, opts?: { drivers?: DeviceDriver[] }): void {
  server.registerTool(
    "record_video",
    {
      title: "Record video",
      description:
        "Start a screen recording (one at a time). Stop with stop_recording. Android uses screenrecord, which caps a clip at 3 minutes. codec applies to iOS only.",
      inputSchema: {
        output_path: z
          .string()
          .optional()
          .describe("Where to write the .mp4 (missing directories are created). Default: $RNE_OUTPUT_DIR or ~/Downloads."),
        codec: z.enum(["hevc", "h264"]).optional().describe("iOS video codec (default hevc). Ignored on Android."),
        device: z
          .string()
          .optional()
          .describe("Device udid/serial or name (substring). Default: the connected app's device, else the only booted one."),
      },
      // Not additive: an existing file at output_path is overwritten.
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ output_path, codec, device }) => {
      try {
        let note = "";
        if (active) {
          if (!ended(active)) {
            throw new UserInputError(`A recording is already in progress: ${active.path}. Call stop_recording first.`);
          }
          // Its recorder exited on its own: refusing here would leave no way
          // to record again for the rest of the session.
          note = ` (The previous recording to ${active.path} had already stopped on its own and was never collected.)`;
          active = null;
        }
        const { driver, udid } = await deviceContext({ ...opts, device });
        // Absolute, so the path reported back is the one actually written.
        const path = resolve(output_path ?? defaultPath());
        try {
          await mkdir(dirname(path), { recursive: true });
        } catch (err) {
          throw new UserInputError(
            `Cannot create the output directory ${dirname(path)}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        const handle = await driver.recordStart(udid, path, { codec });
        active = { path, handle };
        return text(`Recording to ${path}. Call stop_recording to finish.${note}`);
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "stop_recording",
    {
      title: "Stop recording",
      description: "Stop the active screen recording and return the file path.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        if (!active) throw new UserInputError("No recording in progress.");
        const rec = active;
        try {
          await rec.handle.finalize();
        } catch (err) {
          // Kept for a retry only while the recorder still runs: one that is
          // gone fails the same way every time, and holding on to it refused
          // every later record_video for the rest of the session.
          if (ended(rec)) active = null;
          throw err;
        }
        active = null;
        const size = await stat(rec.path)
          .then((s) => s.size)
          .catch(() => undefined);
        if (size === undefined) {
          return toToolError(new DriverError(`The recording stopped, but no file was written at ${rec.path}.`));
        }
        return text(`Recording saved to ${rec.path} (${Math.round(size / 1024)} KB)`);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
