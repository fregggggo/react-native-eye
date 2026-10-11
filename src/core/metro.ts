export type CDPTarget = {
  id: string;
  title: string;
  description?: string;
  webSocketDebuggerUrl: string;
  vm?: string;
  deviceName?: string;
  appId?: string;
  reactNative?: { logicalDeviceId?: string; capabilities?: Record<string, boolean> };
};

export type MetroTarget = { port: number; target: CDPTarget };

export const DEFAULT_PORTS = [8081, 8082, 8083, 19000, 19001, 19002];

export async function fetchTargets(port: number, host = "127.0.0.1"): Promise<CDPTarget[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    const res = await fetch(`http://${host}:${port}/json/list`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const data = (await res.json()) as CDPTarget[];
    return Array.isArray(data) ? data.filter((t) => t?.webSocketDebuggerUrl) : [];
  } catch {
    return [];
  }
}

// Metro answers /status even with no app attached — the signal that distinguishes
// "bundler not running" from "bundler running, app not connected".
export async function isMetroAlive(port: number, host = "127.0.0.1"): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    const res = await fetch(`http://${host}:${port}/status`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    return (await res.text()).includes("packager-status:running");
  } catch {
    return false;
  }
}

export async function probeMetroPorts(ports: number[] = DEFAULT_PORTS, host = "127.0.0.1"): Promise<number[]> {
  const alive = await Promise.all(ports.map(async (p) => ((await isMetroAlive(p, host)) ? p : undefined)));
  return alive.filter((p): p is number => p !== undefined);
}

// RN 0.76+ exposes several pages per device (the JS VM, a separate "UI" page,
// plus stale pages left over from previous reloads). Rank the JS VM first.
export function rankTarget(t: CDPTarget): number {
  let score = 0;
  if (t.vm === "Hermes") score += 4;
  if (t.reactNative?.capabilities?.nativePageReloads) score += 3;
  if (t.reactNative?.capabilities?.prefersFuseboxFrontend) score += 2;
  if (t.reactNative != null) score += 1;
  if (/^UI\b/i.test(t.description ?? "")) score -= 4;
  return score;
}

export function sortTargets(targets: CDPTarget[]): CDPTarget[] {
  return [...targets].sort((a, b) => rankTarget(b) - rankTarget(a));
}

export function pickHermesTarget(targets: CDPTarget[]): CDPTarget | undefined {
  return sortTargets(targets)[0];
}

// Every debuggable target on every scanned port — one entry per target, not per
// port, so a device with several pages (or two devices on one Metro) is visible.
export async function discoverMetro(opts?: { ports?: number[]; host?: string }): Promise<MetroTarget[]> {
  const ports = opts?.ports ?? DEFAULT_PORTS;
  const host = opts?.host ?? "127.0.0.1";
  const results = await Promise.all(
    ports.map(async (port) => sortTargets(await fetchTargets(port, host)).map((target) => ({ port, target }))),
  );
  return results.flat();
}

/**
 * One frame in Metro's /symbolicate protocol. `lineNumber` and `column` are
 * 1-based — the positions RN's own symbolicator posts, taken from `Error.stack`
 * — while CDP call frames are 0-based, so a CDP-sourced caller converts before
 * calling here (see profile/cpuprofile.ts, which stores 1-based positions for
 * exactly this reason).
 */
export type SymbolicateFrame = {
  file: string;
  lineNumber: number;
  column: number;
  methodName?: string;
};

/**
 * Maps bundle positions back to source positions through Metro's source maps.
 * Metro answers `{ stack: [...] }` with one entry per request frame, in order.
 *
 * Best-effort by contract: a bundler that is gone, serving a different app, or
 * answering with an HTML error page returns undefined rather than throwing.
 * Symbolication makes a profile nicer to read; failing the whole profile
 * because of it would throw away the measurement that was expensive to take.
 */
export async function symbolicate(
  port: number,
  frames: SymbolicateFrame[],
  host = "127.0.0.1",
  opts?: { timeoutMs?: number },
): Promise<SymbolicateFrame[] | undefined> {
  if (frames.length === 0) return [];
  try {
    const ctrl = new AbortController();
    // Longer than the discovery probes above: Metro may have to build and read
    // a source map for a large bundle, which is not an 800ms operation.
    const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 10000);
    const res = await fetch(`http://${host}:${port}/symbolicate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ stack: frames }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return undefined;
    const data = (await res.json()) as { stack?: SymbolicateFrame[] };
    const stack = data?.stack;
    // A length mismatch means the answers can no longer be lined up with the
    // questions; a half-mapped table is worse than an unmapped one.
    if (!Array.isArray(stack) || stack.length !== frames.length) return undefined;
    return stack;
  } catch {
    return undefined;
  }
}
