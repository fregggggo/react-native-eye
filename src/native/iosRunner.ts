import net from "node:net";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { run as defaultRun, spawnLongRunning, TIMEOUTS, type LongRunningHandle } from "../core/exec.js";
import { DriverError } from "../core/errors.js";
import { parseAppPid } from "../perf/parseSample.js";
import { iosArtifact, type IosArtifact } from "./artifacts.js";
import { callJson } from "./httpClient.js";
import { CALL_TIMEOUTS } from "./nativeBackend.js";

export type RunnerHandle = {
  port: number;
  pid?: number;
  via: "reused" | "simctl" | "xcodebuild";
  /**
   * `killAfterMs` bounds how long an xcodebuild child may take to exit on
   * SIGINT before it is SIGKILLed (session shutdown passes one shorter than
   * its grace period). Ignored by the other kinds.
   */
  stop(killAfterMs?: number): Promise<void>;
};

export type StartOptions = {
  /**
   * Aborted at session shutdown: no step that has not begun yet runs (in
   * particular no xcodebuild is spawned), and the status poll gives up.
   */
  signal?: AbortSignal;
  /**
   * Called with the xcodebuild handle the moment it is spawned, before its
   * status poll (up to 60 s), so the owner can stop it while the start is
   * still in flight. The same object is what the start resolves with.
   */
  onSpawn?: (h: RunnerHandle) => void;
};

export type IosRunnerDeps = {
  run: typeof import("../core/exec.js").run;
  spawn: typeof import("../core/exec.js").spawnLongRunning;
  artifact: () => IosArtifact | undefined;
  freePort: () => Promise<number>;
  /** GET /status → the runner's version, undefined if nothing answers. */
  probe: (port: number) => Promise<string | undefined>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

const POLL_INTERVAL_MS = 250;
// Deviation from the brief (coordinator instruction, 2026-09-25): measured
// launch → /status up to 24s on this machine under load, so the budget is
// 30s, not the brief's 20s. XCODEBUILD_WAIT_MS and the retry-after-failure
// window are unaffected.
const SIMCTL_WAIT_MS = 30_000;
const XCODEBUILD_WAIT_MS = 60_000;
const STDERR_TAIL_LINES = 5;

/** A free TCP port from the OS: listen on 0, read it, close. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

export async function probeStatus(port: number): Promise<string | undefined> {
  try {
    const r = await callJson<{ status?: unknown; version?: unknown } | undefined>(
      port, "GET", "/status", undefined, CALL_TIMEOUTS.status,
    );
    return r?.status === "ok" && typeof r.version === "string" ? r.version : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_DEPS: IosRunnerDeps = {
  run: defaultRun,
  spawn: spawnLongRunning,
  artifact: () => iosArtifact(),
  freePort,
  probe: probeStatus,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

async function runnerPid(udid: string, bundleId: string, d: IosRunnerDeps): Promise<number | undefined> {
  try {
    const { stdout } = await d.run("xcrun", ["simctl", "spawn", udid, "launchctl", "list"], { timeoutMs: TIMEOUTS.list });
    return parseAppPid(stdout, bundleId);
  } catch {
    return undefined;
  }
}

// `RNERunner 812 me 9u IPv4 0x… 0t0 TCP 127.0.0.1:22087 (LISTEN)`
const LSOF_LISTEN_RE = /TCP\s+\S*:(\d+)\s+\(LISTEN\)/g;

/**
 * Explicit stop only (tests, reinstall): kill the pid launchctl lists right
 * now. Looked up at stop time rather than remembered, because the runner may
 * have been relaunched since. Already gone → nothing to do.
 */
function killRunner(udid: string, bundleId: string, d: IosRunnerDeps): () => Promise<void> {
  return async () => {
    const pid = await runnerPid(udid, bundleId, d);
    if (pid === undefined) return;
    await d.run("kill", [String(pid)], { timeoutMs: TIMEOUTS.key }).catch(() => {});
  };
}

/**
 * Lifecycle step 1: a runner left alive by an earlier session. Found by pid
 * (launchctl inside the simulator), its port by lsof on the host (a simulator
 * app is a host process), and accepted only if /status answers our version.
 */
export async function findLiveIosRunner(
  udid: string,
  bundleId: string,
  version: string,
  deps: IosRunnerDeps,
): Promise<RunnerHandle | undefined> {
  const pid = await runnerPid(udid, bundleId, deps);
  if (pid === undefined) return undefined;
  let lsof: string;
  try {
    // lsof exits 1 when the process has no listening socket; run() rejects.
    lsof = (await deps.run("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], { timeoutMs: TIMEOUTS.key })).stdout;
  } catch {
    return undefined;
  }
  for (const m of lsof.matchAll(LSOF_LISTEN_RE)) {
    const port = Number(m[1]);
    if ((await deps.probe(port)) === version) {
      return { port, pid, via: "reused", stop: killRunner(udid, bundleId, deps) };
    }
  }
  return undefined;
}

/** Lifecycle step 2: install when RNEDriverVersion is missing or different. */
async function installIfNeeded(udid: string, art: IosArtifact, d: IosRunnerDeps): Promise<void> {
  let installed: string | undefined;
  try {
    const { stdout: container } = await d.run("xcrun", ["simctl", "get_app_container", udid, art.runnerBundleId], {
      timeoutMs: TIMEOUTS.list,
    });
    const { stdout } = await d.run("plutil", ["-extract", "RNEDriverVersion", "raw", join(container.trim(), "Info.plist")], {
      timeoutMs: TIMEOUTS.key,
    });
    installed = stdout.trim();
  } catch {
    installed = undefined; // not installed, or installed by a build without the key
  }
  if (installed === art.version) return;
  try {
    await d.run("xcrun", ["simctl", "install", udid, art.runnerApp], { timeoutMs: TIMEOUTS.install });
  } catch (e) {
    throw new DriverError(
      `Installing the iOS runner on ${udid} failed: ${e instanceof Error ? e.message : String(e)}`,
      "Check that the simulator is booted and has free space.",
    );
  }
}

type PollResult = "ok" | "timeout" | "exited" | "aborted";

async function pollStatus(
  port: number,
  version: string,
  waitMs: number,
  d: IosRunnerDeps,
  exited?: () => boolean,
  signal?: AbortSignal,
): Promise<PollResult> {
  const deadline = d.now() + waitMs;
  for (;;) {
    if (signal?.aborted) return "aborted";
    if ((await d.probe(port)) === version) return "ok";
    if (exited?.()) return "exited";
    const left = deadline - d.now();
    if (left <= 0) return "timeout";
    await d.sleep(Math.min(POLL_INTERVAL_MS, left));
  }
}

function stderrTail(h: LongRunningHandle): string {
  return h
    .stderr()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-STDERR_TAIL_LINES)
    .join(" | ");
}

/**
 * Brings up the iOS runner on a booted simulator (spec "Lifecycle — iOS"):
 * reuse a live one → install if needed → `simctl launch` (20s) → `xcodebuild
 * test-without-building` fallback (60s) → DriverError naming both attempts.
 * The simctl-launched runner outlives this process on purpose; the xcodebuild
 * one is a child of it and dies with the handle's stop().
 */
export async function startIosRunner(
  udid: string,
  deps?: Partial<IosRunnerDeps>,
  opts: StartOptions = {},
): Promise<RunnerHandle> {
  const d: IosRunnerDeps = { ...DEFAULT_DEPS, ...deps };
  const { signal } = opts;
  const aborted = () =>
    new DriverError(`iOS runner start on ${udid} aborted: the session is shutting down.`);
  const art = d.artifact();
  if (!art) {
    throw new DriverError(
      "iOS runner not built — build/drivers/manifest.json or the runner app it names is missing.",
      "Run scripts/build-drivers.sh (needs Xcode), then reconnect; until then input goes through axe.",
    );
  }
  const bundle = art.runnerBundleId;

  const live = await findLiveIosRunner(udid, bundle, art.version, d);
  if (live) return live;

  if (signal?.aborted) throw aborted();
  await installIfNeeded(udid, art, d);
  if (signal?.aborted) throw aborted();

  // Step 3: simctl launch. It returns once the app is launched and prints
  // "<bundle>: <pid>"; the runner then needs a few seconds to bind its port.
  const port = await d.freePort();
  let simctlOutcome: string;
  let pid: number | undefined;
  try {
    const { stdout } = await d.run("xcrun", ["simctl", "launch", "--terminate-running-process", udid, bundle], {
      timeoutMs: TIMEOUTS.launch,
      env: { SIMCTL_CHILD_PORT: String(port) },
    });
    const m = /:\s*(\d+)\s*$/.exec(stdout.trim());
    pid = m ? Number(m[1]) : undefined;
    if ((await pollStatus(port, art.version, SIMCTL_WAIT_MS, d, undefined, signal)) === "ok") {
      return { port, pid, via: "simctl", stop: killRunner(udid, bundle, d) };
    }
    simctlOutcome = `no answer on port ${port} within ${SIMCTL_WAIT_MS / 1000}s`;
  } catch (e) {
    simctlOutcome = `failed (${e instanceof Error ? e.message : String(e)})`;
  }

  // Step 4: xcodebuild fallback — loads the host's own XCTest frameworks, so
  // it covers an Xcode newer than the one the runner was built with. A fresh
  // port, and the half-started simctl instance terminated first, so the two
  // never race for the same port or the same bundle.
  if (signal?.aborted) throw aborted();
  await d.run("xcrun", ["simctl", "terminate", udid, bundle], { timeoutMs: TIMEOUTS.key }).catch(() => {});
  const port2 = await d.freePort();
  // Checked synchronously right before the spawn: once shutdown has aborted,
  // no xcodebuild child can appear that nobody would stop.
  if (signal?.aborted) throw aborted();
  const h = d.spawn(
    "xcodebuild",
    ["test-without-building", "-xctestrun", art.xctestrun, "-destination", `id=${udid}`],
    { env: { TEST_RUNNER_PORT: String(port2) } },
  );
  const handle: RunnerHandle = {
    port: port2,
    via: "xcodebuild",
    stop: async (killAfterMs?: number) => {
      await h.stop("SIGINT", killAfterMs).catch(() => {});
    },
  };
  opts.onSpawn?.(handle);
  const r = await pollStatus(port2, art.version, XCODEBUILD_WAIT_MS, d, () => h.exited(), signal);
  if (r === "ok") return handle;
  const tail = stderrTail(h);
  await h.stop().catch(() => {});
  if (r === "aborted") throw aborted();
  const xcOutcome = r === "exited" ? "exited before answering" : `no answer on port ${port2} within ${XCODEBUILD_WAIT_MS / 1000}s`;
  throw new DriverError(
    `iOS runner did not start on ${udid}: simctl launch: ${simctlOutcome}; ` +
      `xcodebuild test-without-building: ${xcOutcome}.${tail ? ` Last xcodebuild output: ${tail}` : ""}`,
    `Input falls back to axe and the runner is retried in 5 minutes; to see the runner's own output run ` +
      `\`xcrun simctl spawn ${udid} log show --last 2m --predicate 'process CONTAINS "RNERunner"'\`, ` +
      `or set RNE_NATIVE_DRIVER=off to stay on axe.`,
  );
}
