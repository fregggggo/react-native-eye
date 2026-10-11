import { describe, it, expect } from "vitest";
import { parseGfxinfo } from "../../src/perf/parseGfxinfo.js";

// The column header and the data row are verbatim from a real
// `adb shell dumpsys gfxinfo <pkg> framestats` (Android 15). Note the
// FrameTimelineVsyncId column, which older devices do not emit — columns are
// looked up by name for exactly that reason.
const HEADER =
  "Flags,FrameTimelineVsyncId,IntendedVsync,Vsync,InputEventId,HandleInputStart,AnimationStart," +
  "PerformTraversalsStart,DrawStart,FrameDeadline,FrameStartTime,FrameInterval,WorkloadTarget,SyncQueued," +
  "SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,QueueBufferDuration," +
  "GpuCompleted,SwapBuffersCompleted,DisplayPresentTime,CommandSubmissionCompleted,";

// FrameCompleted − IntendedVsync = 15_050_800ns ≈ 15.05ms on the real row.
const REAL_ROW =
  "0,1157967,2903038644622,2903038644622,0,2903040273730,2903040275307,2903040278422,2903041328268," +
  "2903055311289,2903040264999,16642485,16666667,2903041544230,2903041992461,2903042392115,2903051852845," +
  "2903053695422,40577,806730,2903052931576,2903053695422,175133670835,2903051852845,";

function row(intended: number, completed: number, flags = 0): string {
  const cells = REAL_ROW.split(",");
  cells[0] = String(flags);
  cells[2] = String(intended);
  cells[17] = String(completed);
  return cells.join(",");
}

const GFX_FIXTURE = `Applications Graphics Acceleration Info:
Uptime: 2904414 Realtime: 2904414

** Graphics info for pid 1430 [com.example.app] **

Stats since: 2902020240615ns
Total frames rendered: 3
Janky frames: 1 (33.33%)
Janky frames (legacy): 1 (33.33%)
50th percentile: 14ms
90th percentile: 30ms
95th percentile: 30ms
99th percentile: 31ms
Number Missed Vsync: 0
HISTOGRAM: 5ms=0 6ms=0

---PROFILEDATA---
${HEADER}
${row(1_000_000_000, 1_016_000_000)}
${row(2_000_000_000, 2_050_000_000)}
${row(3_000_000_000, 3_500_000_000, 1)}
${row(4_000_000_000, 4_008_000_000)}
---PROFILEDATA---


	ScreenDecorOverlay/android.view.UFwViewRootImpl@5751df2 (visibility=4)
Window: ScreenDecorOverlay
Stats since: 2902015116423ns
Total frames rendered: 0
Janky frames: 0 (0.00%)
50th percentile: 4950ms

---PROFILEDATA---
${HEADER}
---PROFILEDATA---

Pipeline=Skia (OpenGL)
`;

describe("parseGfxinfo", () => {
  it("takes the window that actually rendered, not the first block in the dump", () => {
    // A dump carries one block per window; the ScreenDecorOverlay's is empty
    // and picking the first one found returned "0 frames" on a busy app.
    const s = parseGfxinfo(GFX_FIXTURE);
    expect(s.unparsed).toBeUndefined();
    expect(s.frameDurationsMs).toHaveLength(3);
  });

  it("measures each frame as FrameCompleted − IntendedVsync", () => {
    const s = parseGfxinfo(GFX_FIXTURE);
    expect(s.frameDurationsMs).toEqual([16, 50, 8]);
  });

  it("drops frames the framework itself flagged", () => {
    // A non-zero Flags cell marks a frame that must not be counted (a layout
    // change, a first draw) — including it reports 500ms of phantom jank.
    const s = parseGfxinfo(GFX_FIXTURE);
    expect(s.frameDurationsMs).not.toContain(500);
  });

  it("reads the summary counters next to the block it used", () => {
    const s = parseGfxinfo(GFX_FIXTURE);
    expect(s.totalRendered).toBe(3);
    expect(s.jankyFrames).toBe(1);
    expect(s.jankyPct).toBeCloseTo(33.33, 2);
    expect(s.percentilesMs).toEqual({ p50: 14, p90: 30, p95: 30, p99: 31 });
  });

  it("parses the real column layout even without FrameTimelineVsyncId", () => {
    // Pre-Android-12 devices emit a narrower header; fixed column indexes broke.
    const cols = HEADER.split(",").filter((c) => c && c !== "FrameTimelineVsyncId");
    const idx = (n: string) => cols.indexOf(n);
    const cells = new Array(cols.length).fill("0");
    cells[idx("IntendedVsync")] = "1000000000";
    cells[idx("FrameCompleted")] = "1020000000";
    const s = parseGfxinfo(`---PROFILEDATA---\n${cols.join(",")},\n${cells.join(",")},\n---PROFILEDATA---\n`);
    expect(s.frameDurationsMs).toEqual([20]);
  });

  it("hands back the head of an output with no profile data", () => {
    const s = parseGfxinfo("No process found for: com.example.app\n");
    expect(s.frameDurationsMs).toHaveLength(0);
    expect(s.unparsed).toContain("No process found");
  });
});
