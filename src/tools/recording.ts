import { z } from "zod";
import { join } from "node:path";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { deviceContext } from "./context.js";
import { text } from "../core/format.js";
import { toToolError, UserInputError } from "../core/errors.js";
import type { DeviceDriver } from "../drivers/types.js";

let active: { path: string; finalize(): Promise<void> } | null = null;

export function resetRecordingState(): void {
  active = null;
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
        output_path: z.string().optional(),
        codec: z.enum(["hevc", "h264"]).optional(),
        device: z.string().optional(),
      },
    },
    async ({ output_path, codec, device }) => {
      try {
        if (active) {
          throw new UserInputError(`A recording is already in progress: ${active.path}. Call stop_recording first.`);
        }
        const { driver, udid } = await deviceContext({ ...opts, device });
        const path = output_path ?? defaultPath();
        const handle = await driver.recordStart(udid, path, { codec });
        active = { path, finalize: () => handle.finalize() };
        return text(`Recording to ${path}. Call stop_recording to finish.`);
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
    },
    async () => {
      try {
        if (!active) throw new UserInputError("No recording in progress.");
        const rec = active;
        // State is cleared only once finalize succeeds: dropping it first made a
        // failed finalize unrecoverable — no retry, no path.
        await rec.finalize();
        active = null;
        const size = await stat(rec.path)
          .then((s) => ` (${Math.round(s.size / 1024)} KB)`)
          .catch(() => "");
        return text(`Recording saved to ${rec.path}${size}`);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
