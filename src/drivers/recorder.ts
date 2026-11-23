import type { LongRunningHandle } from "../core/exec.js";

const POLL_MS = 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for a screen recorder to show it is recording: `ready` on its stderr,
 * or still alive after `maxMs`. A recorder that exits first throws its own
 * exit code and stderr. A bad output path or a device that went away makes
 * `simctl recordVideo` exit after about a second (measured 0.95 s), well past
 * the 400 ms of LongRunningHandle.assertAlive — such a recording used to be
 * reported as started, and stop_recording then failed on it forever.
 */
export async function recorderStarted(h: LongRunningHandle, maxMs: number, ready?: RegExp): Promise<void> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    // assertAlive on an exited handle throws at once, with the exit code.
    if (h.exited()) return h.assertAlive(1);
    if (ready?.test(h.stderr())) return;
    if (Date.now() >= deadline) return;
    await sleep(POLL_MS);
  }
}

/** Resolves once the recorder has exited, or after `maxMs`; true if it exited. */
export async function recorderExited(h: LongRunningHandle, maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (!h.exited()) {
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
  return true;
}
