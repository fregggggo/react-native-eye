import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getRegistry } from "../core/registry.js";
import { text, truncate } from "../core/format.js";
import { toToolError, UserInputError } from "../core/errors.js";
import { startJob, getJob, listJobs, type Job } from "../core/jobs.js";

function render(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function elapsed(job: Job): string {
  return `${(((job.finishedAt ?? Date.now()) - job.startedAt) / 1000).toFixed(1)}s`;
}

function head(job: Job): string {
  return job.label ?? job.code.replace(/\s+/g, " ").slice(0, 60);
}

export function registerRuntimeTools(server: McpServer): void {
  server.registerTool(
    "eval_js",
    {
      title: "Evaluate JS",
      description:
        "Evaluate JavaScript in the app's runtime and return the result. Statements are allowed, and a promise result is awaited (await fetch(...), AsyncStorage.getItem(...)) — pass the promise itself, not `await` (Hermes has no async/await in evaluated code). Pass background: true for work that outlives one tool call (a long measurement, a snippet that samples for 30s) and collect the result with get_job.",
      inputSchema: {
        code: z.string(),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .max(600000)
          .optional()
          .describe("How long to wait for a promise result (default 10000; background jobs default to 600000)."),
        background: z
          .boolean()
          .optional()
          .describe("Start the evaluation and return a job id immediately instead of waiting for the result."),
        label: z.string().optional().describe("Name for a background job, shown by get_job."),
      },
    },
    async ({ code, timeout_ms, background, label }) => {
      try {
        if (!code.trim()) throw new UserInputError("`code` is empty — provide a JS expression.");
        const conn = await getRegistry().ensure();
        if (background) {
          const job = startJob(conn, code, { timeoutMs: timeout_ms, label });
          return text(`job ${job.id} started — poll get_job({ id: "${job.id}" })`);
        }
        const value = await conn.evaluate(code, { timeoutMs: timeout_ms });
        return text(truncate(render(value) ?? "undefined", 4000));
      } catch (err) {
        return toToolError(err);
      }
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get background job",
      description:
        "Collect the result of a background job started by eval_js (background: true). Without an id, lists every job the server is holding.",
      inputSchema: {
        id: z.string().optional().describe("Job id, e.g. \"j1\". Omit to list all jobs."),
      },
    },
    async ({ id }) => {
      try {
        if (!id) {
          const jobs = listJobs();
          if (jobs.length === 0) return text("no background jobs — start one with eval_js({ background: true })");
          return text(jobs.map((j) => `${j.id} [${j.status}] ${elapsed(j)} — ${head(j)}`).join("\n"));
        }
        const job = getJob(id);
        if (!job) {
          throw new UserInputError(
            `no job "${id}" — call get_job without an id to see the jobs this server is holding (finished jobs are dropped once 50 have piled up).`,
          );
        }
        const header = `${job.id} [${job.status}] ${elapsed(job)}${job.label ? ` — ${job.label}` : ""}`;
        // The status line is deliberately first: a polling agent needs to know
        // whether to poll again before it reads anything else.
        if (job.status === "running") return text(`${header}\nstill running — poll again`);
        if (job.status === "failed") return text(`${header}\nerror: ${job.error ?? "unknown error"}`);
        return text(`${header}\n${truncate(render(job.value) ?? "undefined", 4000)}`);
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
