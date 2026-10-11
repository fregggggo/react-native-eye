import type { Connection } from "./registry.js";
import { truncate } from "./format.js";

// A background evaluation the server started and nobody is awaiting.
//
// Foreground eval_js has to answer within one tool call, so anything that keeps
// the JS thread busy longer than the caller's patience (a long measurement, a
// snippet that samples for 30s) can only be run by handing the agent a handle
// and letting it collect the result later. This store is deliberately free of
// MCP types: the render profiler and the CDP Profiler wrapper start their jobs
// the same way.

export type JobStatus = "running" | "done" | "failed";

export type Job = {
  id: string;
  label?: string;
  /** Truncated — this is for listing, the full text went to the runtime. */
  code: string;
  status: JobStatus;
  startedAt: number;
  finishedAt?: number;
  value?: unknown;
  error?: string;
};

/**
 * Ten minutes. The point of a background job is to outlive the JS thread being
 * busy, so the CDP default (15s) and the eval default (10s) are both wrong
 * here: Hermes queues the Runtime.evaluate message and runs it when the thread
 * frees, so a job that is "stuck" is usually just waiting its turn.
 */
export const DEFAULT_JOB_TIMEOUT_MS = 600000;

const MAX_JOBS = 50;
const CODE_PREVIEW_CHARS = 200;

let seq = 0;
// Insertion-ordered, which is start order — listJobs and the prune both rely on it.
const jobs = new Map<string, Job>();

export function startJob(
  conn: Connection,
  code: string,
  opts: { timeoutMs?: number; label?: string } = {},
): Job {
  const job: Job = {
    id: `j${++seq}`,
    label: opts.label,
    code: truncate(code, CODE_PREVIEW_CHARS),
    status: "running",
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  prune();

  // First settlement wins: the socket-close hook and the evaluate rejection
  // both fire on a reload, and "app reloaded" is the useful one.
  const settle = (patch: Partial<Job>): void => {
    if (job.status !== "running") return;
    Object.assign(job, patch, { finishedAt: Date.now() });
    // Jobs are almost always still running when the next one starts, so the
    // prune at start time usually finds nothing evictable — this is where the
    // cap is actually enforced.
    prune();
  };

  conn.onClose(() =>
    settle({ status: "failed", error: "app reloaded (or the connection dropped) while the job was running" }),
  );

  // Not awaited on purpose — this is the whole feature. Both paths are handled,
  // so a CDP timeout or a dropped socket can never surface as an unhandled
  // rejection that takes the server down.
  void conn.evaluate(code, { timeoutMs: opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS }).then(
    (value) => settle({ status: "done", value }),
    (err) => settle({ status: "failed", error: err instanceof Error ? err.message : String(err) }),
  );

  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()];
}

/** Test seam — the store is process-wide state, like the registry singleton. */
export function resetJobs(): void {
  jobs.clear();
  seq = 0;
}

// Only finished jobs are evictable: dropping a running one would orphan a
// result the agent is still waiting for, and the settle above would then write
// into a Job nobody can reach.
function prune(): void {
  while (jobs.size > MAX_JOBS) {
    const stale = [...jobs.values()].find((j) => j.status !== "running");
    if (!stale) return;
    jobs.delete(stale.id);
  }
}
