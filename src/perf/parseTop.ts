import type { CpuSample, CpuThread } from "../drivers/types.js";

/**
 * ` 1430 u0_a207  20   0  18G 215M 163M R 40.0   5.6   0:08.49 mqt_js  com.example.app`
 *
 * Matched positionally rather than by splitting on whitespace: the THREAD
 * column holds the kernel's 15-character comm, which is allowed to contain
 * spaces ("Jit thread pool", "Profile Saver"), so a naive split shifts every
 * column after it.
 */
const ROW_RE =
  /^\s*(\d+)\s+\S+\s+-?\d+\s+-?\d+\s+\S+\s+\S+\s+\S+\s+\S\s+([\d.]+)\s+[\d.]+\s+\S+\s+(.+?)\s+(\S+)\s*$/;

function roleOf(tid: number, pid: number, name: string): CpuThread["role"] {
  // The main thread's comm is the package name truncated from the LEFT
  // ("com.example.app" → "ndroid.example"), so it cannot be matched by name at
  // all; tid === pid is the definition.
  if (tid === pid) return "main";
  if (name.includes("mqt_js")) return "js";
  if (name.startsWith("RenderThread") || name.startsWith("hwuiTask")) return "render";
  return "other";
}

/**
 * Parses `top -H -p <pid> -d <s> -n 2 -b`. Only the final iteration is read:
 * the first one's %CPU is measured over a window `top` picked for itself, not
 * the one the caller asked for.
 */
export function parseTopThreads(out: string, pid: number): Omit<CpuSample, "pid" | "durationS"> {
  const lines = out.split("\n");
  const lastHeader = lines.reduce((at, l, i) => (/^\s*TID\s+USER\b/.test(l) ? i : at), -1);
  const threads: CpuThread[] = [];

  for (let i = lastHeader + 1; i < lines.length; i++) {
    const m = ROW_RE.exec(lines[i]);
    if (!m) continue;
    const tid = Number(m[1]);
    const name = m[3].trim();
    threads.push({
      id: m[1],
      name,
      role: roleOf(tid, pid, name),
      share: 0,
      cpuPercent: Number(m[2]),
    });
  }

  if (threads.length === 0) {
    return { threads: [], unparsed: out.trim().split("\n").slice(0, 5).join("\n") };
  }

  // %CPU is per core (100% is one full core), so it cannot be read as a share on
  // its own; dividing by the app's own total answers the question the tool asks
  // — which of this app's threads is the busy one.
  const total = threads.reduce((n, t) => n + (t.cpuPercent ?? 0), 0);
  for (const t of threads) t.share = total > 0 ? (t.cpuPercent ?? 0) / total : 0;
  return { threads };
}
