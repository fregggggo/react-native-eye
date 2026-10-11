import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegistry } from "../core/registry.js";
import { text } from "../core/format.js";
import { toToolError, UserInputError, RuntimeError } from "../core/errors.js";
import { startJob } from "../core/jobs.js";
import {
  RENDER_PROFILER_SOURCE,
  renderProfileExpression,
  formatReport,
  isRenderReport,
} from "../profile/renders.js";

const DEFAULT_DURATION_MS = 5000;
const MAX_DURATION_MS = 60000;
const DEFAULT_TOP = 15;

/**
 * The snippet resolves itself after `duration_ms`, so the only thing this slack
 * covers is the round trip plus a JS thread that is busy enough to queue our
 * poll behind the very work being measured.
 */
const SETTLE_SLACK_MS = 15000;

export function registerRenderTools(server: McpServer): void {
  server.registerTool(
    "profile_renders",
    {
      title: "Profile renders",
      description:
        "Count React re-renders over a window: which components rendered, how many times, how long they spent, and which update started each commit. Installs a switchable hook on the React DevTools global hook (dev builds only) that prunes untouched subtrees, so it costs roughly what the commits cost rather than what the tree costs. Nothing re-renders on its own — drive the app during the window, which usually means background: true plus tap/swipe, then get_job to collect.",
      inputSchema: {
        duration_ms: z
          .number()
          .int()
          .positive()
          .max(MAX_DURATION_MS)
          .optional()
          .describe(`How long to profile (default ${DEFAULT_DURATION_MS}, max ${MAX_DURATION_MS}).`),
        top: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe(`How many components to list by render count (default ${DEFAULT_TOP}).`),
        background: z
          .boolean()
          .optional()
          .describe("Start profiling and return a job id immediately, so you can drive the app while it runs."),
        label: z.string().optional().describe("Name for the background job, shown by get_job."),
      },
    },
    async ({ duration_ms, top, background, label }) => {
      try {
        const duration = duration_ms ?? DEFAULT_DURATION_MS;
        if (duration > MAX_DURATION_MS) {
          throw new UserInputError(
            `duration_ms must be at most ${MAX_DURATION_MS} (60s) — for a longer session, profile in slices with background: true.`,
          );
        }
        const conn = await getRegistry().ensure();

        const status = await conn.evaluate(RENDER_PROFILER_SOURCE);
        if (status === "no-hook") {
          throw new UserInputError(
            "this app has no React DevTools global hook, so commits cannot be observed — profile_renders needs a dev build (a release/production bundle strips the hook).",
          );
        }
        if (status === "stale") {
          throw new UserInputError(
            "an older build of the render profiler is still wrapped around the commit hook and cannot be unwrapped — reload the app (reload_app) and try again.",
          );
        }

        const code = renderProfileExpression(duration);
        const timeoutMs = duration + SETTLE_SLACK_MS;

        if (background) {
          const job = startJob(conn, code, { timeoutMs, label: label ?? `profile_renders ${duration}ms` });
          return text(`job ${job.id} started — poll get_job({ id: "${job.id}" })`);
        }

        const report = await conn.evaluate(code, { timeoutMs });
        if (!isRenderReport(report)) {
          // Not our report shape: an older profiler still resident, or the app
          // reloaded mid-window and cleared the hook. Saying so beats printing
          // a header built out of undefined.
          throw new RuntimeError(
            `the render profiler returned something this build cannot read (${JSON.stringify(report)?.slice(0, 200)}) — reload the app and try again.`,
          );
        }
        return text(formatReport(report, top ?? DEFAULT_TOP));
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
