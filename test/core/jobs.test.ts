import { describe, it, expect, beforeEach } from "vitest";
import { startJob, getJob, listJobs, resetJobs, DEFAULT_JOB_TIMEOUT_MS } from "../../src/core/jobs.js";
import type { Connection } from "../../src/core/registry.js";

type FakeConn = {
  conn: Connection;
  calls: { code: string; timeoutMs?: number }[];
  /** Settle the nth evaluate() this connection was asked for (0-based). */
  settle: (v: unknown, nth?: number) => void;
  fail: (e: unknown, nth?: number) => void;
  drop: () => void;
};

/**
 * jobs.ts only ever touches `evaluate` and `onClose`, so a structural double
 * keeps these tests free of sockets and timers — the real Connection is
 * exercised in registry.test.ts.
 */
function fakeConn(): FakeConn {
  const calls: { code: string; timeoutMs?: number }[] = [];
  const closeHandlers: (() => void)[] = [];
  const deferred: { res: (v: unknown) => void; rej: (e: unknown) => void }[] = [];
  const conn = {
    evaluate(code: string, opts?: { timeoutMs?: number }) {
      calls.push({ code, timeoutMs: opts?.timeoutMs });
      return new Promise<unknown>((res, rej) => deferred.push({ res, rej }));
    },
    onClose(h: () => void) {
      closeHandlers.push(h);
    },
  };
  return {
    conn: conn as unknown as Connection,
    calls,
    settle: (v, nth = 0) => deferred[nth].res(v),
    fail: (e, nth = 0) => deferred[nth].rej(e),
    drop: () => closeHandlers.forEach((h) => h()),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => resetJobs());

describe("startJob", () => {
  it("returns a running job without waiting for the evaluation", async () => {
    const f = fakeConn();
    const job = startJob(f.conn, "longThing()", { label: "measure" });
    expect(job).toMatchObject({ id: "j1", label: "measure", status: "running" });
    expect(job.startedAt).toBeGreaterThan(0);
    expect(f.calls).toHaveLength(1);
    // Still running after a tick: startJob did not await the evaluation.
    await flush();
    expect(getJob("j1")?.status).toBe("running");
  });

  it("numbers jobs j1, j2, … and lists them in start order", () => {
    const f = fakeConn();
    startJob(f.conn, "a()");
    startJob(f.conn, "b()");
    expect(listJobs().map((j) => j.id)).toEqual(["j1", "j2"]);
  });

  it("records the resolved value as done", async () => {
    const f = fakeConn();
    startJob(f.conn, "a()");
    f.settle({ ok: 1 });
    await flush();
    const job = getJob("j1")!;
    expect(job.status).toBe("done");
    expect(job.value).toEqual({ ok: 1 });
    expect(job.finishedAt).toBeGreaterThanOrEqual(job.startedAt);
  });

  it("records a rejection as failed instead of an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const f = fakeConn();
      startJob(f.conn, "a()");
      f.fail(new Error("CDP timed out after 600000ms"));
      await flush();
      await flush();
      const job = getJob("j1")!;
      expect(job.status).toBe("failed");
      expect(job.error).toContain("timed out");
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("uses the 10 minute default timeout, or the caller's", () => {
    const f = fakeConn();
    startJob(f.conn, "a()");
    startJob(f.conn, "b()", { timeoutMs: 5000 });
    expect(DEFAULT_JOB_TIMEOUT_MS).toBe(600000);
    expect(f.calls[0].timeoutMs).toBe(DEFAULT_JOB_TIMEOUT_MS);
    expect(f.calls[1].timeoutMs).toBe(5000);
  });

  it("truncates the stored code but evaluates it whole", () => {
    const f = fakeConn();
    const code = "x".repeat(500);
    const job = startJob(f.conn, code);
    expect(job.code.length).toBeLessThan(250);
    expect(f.calls[0].code).toBe(code);
  });

  it("fails still-running jobs when the app reloads", async () => {
    const f = fakeConn();
    startJob(f.conn, "a()");
    startJob(f.conn, "b()");
    f.settle("done-first");
    await flush();
    f.drop();
    expect(getJob("j1")).toMatchObject({ status: "done", value: "done-first" });
    expect(getJob("j2")?.status).toBe("failed");
    expect(getJob("j2")?.error).toMatch(/reload/i);
  });

  it("keeps at most 50 jobs, dropping the oldest finished ones first", async () => {
    const f = fakeConn();
    startJob(f.conn, "still-running()"); // j1 never settles
    for (let i = 0; i < 60; i++) {
      const g = fakeConn();
      startJob(g.conn, `done-${i}()`);
      g.settle(i);
    }
    await flush();
    const ids = listJobs().map((j) => j.id);
    expect(ids.length).toBeLessThanOrEqual(50);
    // The running job survives even though it is the oldest.
    expect(ids).toContain("j1");
    expect(getJob("j61")).toBeDefined();
    expect(getJob("j2")).toBeUndefined();
  });
});

describe("getJob", () => {
  it("returns undefined for an unknown id", () => {
    expect(getJob("nope")).toBeUndefined();
  });
});
