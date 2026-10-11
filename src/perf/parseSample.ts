import type { CpuSample, CpuThread } from "../drivers/types.js";

/**
 * macOS `sample` samples *every* thread on every tick, running or asleep, so
 * each thread comes back with an identical sample count and a share of the
 * total says nothing at all (three idle threads and one spinning one all read
 * 25%). What separates work from waiting is the leaf frame: a thread parked in
 * one of these syscalls burned no CPU for that sample. Anything else counts as
 * busy — a false "busy" from an unlisted wait primitive only over-reports, and
 * the frame is printed next to the number so the caller can see what it was.
 */
const BLOCKED_LEAF_FRAMES = new Set([
  "mach_msg_trap",
  "mach_msg2_trap",
  "mach_msg_overwrite_trap",
  "semaphore_wait_trap",
  "semaphore_timedwait_trap",
  "__psynch_cvwait",
  "__psynch_mutexwait",
  "__psynch_rw_rdlock",
  "__psynch_rw_wrlock",
  "__workq_kernreturn",
  "__ulock_wait",
  "__ulock_wait2",
  "kevent",
  "kevent_id",
  "kevent_qos",
  "__semwait_signal",
  "__semwait_signal_nocancel",
  "__select",
  "__select_nocancel",
  "select",
  "poll",
  "__wait4",
  "__sigsuspend_nocancel",
  "__accept_nocancel",
  "swtch_pri",
  "thread_switch",
  "start_wqthread",
]);

// `    600 Thread_100   DispatchQueue_1: com.apple.main-thread  (serial)`
// `    600 Thread_200: com.facebook.react.runtime.JavaScript`
// `    600 Thread_300`
const THREAD_RE = /^ {4}(\d+) Thread_(\w+)(.*)$/;
// Any call-graph line: a tree prefix built from `+ ! : |` and spaces, the
// sample count, then the frame.
const FRAME_RE = /^([ +!:|]+)(\d+) (\S.*)$/;

type Section = { thread: CpuThread; samples: number; busy: number; leaves: Map<string, number> };

/**
 * Strips the offset and address off a frame line, leaving `symbol  (in binary)`
 * — the same spelling `sample`'s own "Sort by top of stack" section uses, and
 * the only part that is stable between two runs of the same app.
 */
function cleanFrame(s: string): string {
  return s
    .replace(/\s*\+\s*[\d,.]+\s*\[[^\]]*\]\s*$/, "")
    .replace(/\s*\[[^\]]*\]\s*$/, "")
    .trim();
}

/** The bare symbol, i.e. everything before the `  (in …)` the binary name sits in. */
function symbolOf(frame: string): string {
  return frame.split("  (in ")[0].trim();
}

function roleOf(name: string | undefined): CpuThread["role"] {
  if (!name) return "other";
  if (name.includes("com.apple.main-thread")) return "main";
  // RN 0.74+ renamed the JS thread; older builds still use the short form.
  if (name.includes("com.facebook.react.runtime.JavaScript") || name.includes("com.facebook.react.JavaScript")) {
    return "js";
  }
  if (name.includes("ShadowQueue") || name.includes("ShadowTree")) return "shadow";
  return "other";
}

function threadHeader(line: string): { id: string; name?: string; samples: number } | undefined {
  const m = THREAD_RE.exec(line);
  if (!m) return undefined;
  let rest = m[3].trim();
  if (rest.startsWith(":")) rest = rest.slice(1).trim();
  const name = rest.replace(/\s*\((?:serial|concurrent)\)\s*$/, "").trim();
  return { id: m[2], name: name || undefined, samples: Number(m[1]) };
}

/**
 * Parses the call graph of `sample <pid> <seconds>`. Tolerant on purpose: an
 * output it cannot recognise (a `sample` that failed to attach, a future format)
 * comes back as `unparsed` with no threads, so the tool prints the raw head
 * instead of a confident table of nothing.
 */
export function parseSample(out: string): Omit<CpuSample, "pid" | "durationS"> {
  const lines = out.split("\n");
  const start = lines.findIndex((l) => l.startsWith("Call graph:"));
  const sections: Section[] = [];

  if (start >= 0) {
    let current: Section | undefined;
    // The open path down the call tree. A node is closed once a line at the
    // same or a shallower indent proves it has no more children; what is left
    // of its samples after its children took theirs is what stopped *in* it —
    // the only samples that say what the thread was actually executing.
    let stack: { indent: number; frame: string; samples: number; childSamples: number }[] = [];

    const closeTo = (indent: number): void => {
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
        const top = stack.pop()!;
        if (stack.length > 0) stack[stack.length - 1].childSamples += top.samples;
        const self = top.samples - top.childSamples;
        if (!current || self <= 0) continue;
        current.leaves.set(top.frame, (current.leaves.get(top.frame) ?? 0) + self);
        if (!BLOCKED_LEAF_FRAMES.has(symbolOf(top.frame))) current.busy += self;
      }
    };

    for (let i = start + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^(Total number in stack|Sort by top of stack|Binary Images:)/.test(line)) break;
      const head = threadHeader(line);
      if (head) {
        closeTo(0);
        current = {
          thread: { id: head.id, name: head.name, role: roleOf(head.name), share: 0 },
          samples: head.samples,
          busy: 0,
          leaves: new Map(),
        };
        sections.push(current);
        stack = [];
        continue;
      }
      const m = FRAME_RE.exec(line);
      if (!m || !current) continue;
      const indent = m[1].length;
      closeTo(indent);
      stack.push({ indent, frame: cleanFrame(m[3]), samples: Number(m[2]), childSamples: 0 });
    }
    closeTo(0);
  }

  if (sections.length === 0) {
    return { threads: [], unparsed: out.trim().split("\n").slice(0, 5).join("\n") };
  }

  const totalSamples = sections.reduce((n, s) => n + s.samples, 0);
  const busySamples = sections.reduce((n, s) => n + s.busy, 0);
  for (const s of sections) {
    s.thread.busyFraction = s.samples > 0 ? s.busy / s.samples : 0;
    s.thread.share = busySamples > 0 ? s.busy / busySamples : 0;
    const hot = [...s.leaves]
      .filter(([frame]) => !BLOCKED_LEAF_FRAMES.has(symbolOf(frame)))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
    if (hot.length > 0) {
      s.thread.topFrames = hot.map(([frame, n]) => ({ frame, share: s.busy > 0 ? n / s.busy : 0 }));
    }
  }

  return { totalSamples, busySamples, threads: sections.map((s) => s.thread) };
}

/**
 * Finds a running app's pid in `xcrun simctl spawn <udid> launchctl list`. The
 * label carries a per-launch hash — `UIKitApplication:com.x.app[760b][rb-legacy]`
 * — so the bundle id is compared against the label with that suffix cut off,
 * never with a prefix test, which would match com.x.app.extension too.
 */
export function parseAppPid(out: string, bundleId: string): number | undefined {
  const PREFIX = "UIKitApplication:";
  for (const line of out.split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    const label = cols[2].trim();
    if (!label.startsWith(PREFIX)) continue;
    if (label.slice(PREFIX.length).replace(/\[.*$/, "") !== bundleId) continue;
    const pid = Number(cols[0].trim());
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return undefined;
}
