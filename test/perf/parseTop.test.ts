import { describe, it, expect } from "vitest";
import { parseTopThreads } from "../../src/perf/parseTop.js";

// Column layout captured verbatim from `adb shell top -H -p <pid> -d 2 -n 2 -b`
// on a real device (toybox top, Android 15). Two iterations: only the second
// one's %CPU is measured over the requested window. Thread names are truncated
// to 15 characters by the kernel and may contain spaces ("Jit thread pool"),
// which is why the row is matched positionally rather than split on whitespace.
const TOP_FIXTURE = `Threads: 131 total,   0 running, 131 sleeping,   0 stopped,   0 zombie
  Mem:  3886752K total,  3710956K used,   175796K free,     2760K buffers
 Swap:  2696188K total,  1382144K used,  1314044K free,  1914992K cached
800%cpu  11%user   0%nice   4%sys 781%idle   0%iow   4%irq   0%sirq   0%host
  TID USER         PR  NI VIRT  RES  SHR S[%CPU] %MEM     TIME+ THREAD          PROCESS
 1430 u0_a207      20   0  18G 213M 163M S 99.9   5.6   0:08.09 ndroid.example  com.example.app
 1436 u0_a207      24   4  18G 213M 163M S  0.0   5.6   0:01.88 HeapTaskDaemon  com.example.app
 1435 u0_a207      29   9  18G 213M 163M S  0.0   5.6   0:00.15 Jit thread pool com.example.app

Threads: 131 total,   2 running, 129 sleeping,   0 stopped,   0 zombie
  Mem:  3886752K total,  3710956K used,   175796K free,     2760K buffers
 Swap:  2696188K total,  1382144K used,  1314044K free,  1914992K cached
800%cpu  31%user   0%nice   4%sys 761%idle   0%iow   4%irq   0%sirq   0%host
  TID USER         PR  NI VIRT  RES  SHR S[%CPU] %MEM     TIME+ THREAD          PROCESS
 1430 u0_a207      20   0  18G 215M 163M R 40.0   5.6   0:08.49 ndroid.example  com.example.app
 1502 u0_a207      20   0  18G 215M 163M R 30.0   5.6   0:02.10 mqt_js          com.example.app
 1503 u0_a207      20   0  18G 215M 163M S 10.0   5.6   0:01.00 RenderThread    com.example.app
 1435 u0_a207      29   9  18G 215M 163M S  0.0   5.6   0:00.15 Jit thread pool com.example.app
`;

describe("parseTopThreads", () => {
  it("reads the last iteration only", () => {
    const s = parseTopThreads(TOP_FIXTURE, 1430);
    // The first iteration's main thread claims 99.9% — it is measured over a
    // window `top` chose, not the one the caller asked for.
    expect(s.threads.find((t) => t.id === "1430")?.cpuPercent).toBe(40);
    expect(s.threads).toHaveLength(4);
  });

  it("identifies main by tid, and the RN threads by name", () => {
    const { threads } = parseTopThreads(TOP_FIXTURE, 1430);
    const byId = Object.fromEntries(threads.map((t) => [t.id, t]));
    // The main thread's comm is the package truncated from the LEFT
    // ("ndroid.example"), so only tid === pid identifies it reliably.
    expect(byId["1430"].role).toBe("main");
    expect(byId["1502"].role).toBe("js");
    expect(byId["1503"].role).toBe("render");
    expect(byId["1435"].role).toBe("other");
  });

  it("keeps a thread name that contains spaces", () => {
    const { threads } = parseTopThreads(TOP_FIXTURE, 1430);
    expect(threads.find((t) => t.id === "1435")?.name).toBe("Jit thread pool");
  });

  it("shares the app's CPU between the threads that used it", () => {
    const { threads } = parseTopThreads(TOP_FIXTURE, 1430);
    expect(threads.find((t) => t.id === "1430")?.share).toBeCloseTo(0.5, 4);
    expect(threads.find((t) => t.id === "1502")?.share).toBeCloseTo(0.375, 4);
    expect(threads.find((t) => t.id === "1435")?.share).toBe(0);
  });

  it("gives every thread a zero share when the app used no CPU at all", () => {
    const idle = TOP_FIXTURE.replace(/ [\d.]+   5\.6/g, "  0.0   5.6");
    const { threads } = parseTopThreads(idle, 1430);
    expect(threads.every((t) => t.share === 0)).toBe(true);
  });

  it("hands back the head of an output it does not recognise", () => {
    const s = parseTopThreads("top: No such process\n", 1430);
    expect(s.threads).toHaveLength(0);
    expect(s.unparsed).toContain("No such process");
  });
});
