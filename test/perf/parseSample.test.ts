import { describe, it, expect } from "vitest";
import { parseSample, parseAppPid } from "../../src/perf/parseSample.js";

// Trimmed from a real `sample <pid> 1` run against a React Native app in the
// iOS simulator (com.example.demo.dev) — the thread-header shapes, the
// `+ ! : |` tree prefixes and the `symbol  (in binary) + off  [addr]` frame
// spelling are all verbatim; only the depth and the frame count are cut down.
const SAMPLE_FIXTURE = `Analysis of sampling DemoApp (pid 50571) every 1 millisecond
Process:         DemoApp [50571]
Path:            /Users/USER/*/DemoApp.app/DemoApp
Code Type:       ARM64
Platform:        iOS Simulator

Physical footprint:         699.0M
----

Call graph:
    600 Thread_100   DispatchQueue_1: com.apple.main-thread  (serial)
    + 600 start  (in dyld) + 6992  [0x185fcfe00]
    +   400 -[UIApplication _run]  (in UIKitCore) + 100  [0x1000]
    +   ! 400 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x1001]
    +   200 -[RCTSurfaceView layoutSubviews]  (in DemoApp) + 12  [0x1002]
    +     150 objc_msgSend  (in libobjc.A.dylib) + 4,12,...  [0x1003,0x1004,...]
    +     50 CA::Layer::layout_if_needed(CA::Transaction*)  (in QuartzCore) + 20  [0x1005]
    600 Thread_200: com.facebook.react.runtime.JavaScript
    + 600 _pthread_start  (in libsystem_pthread.dylib) + 136  [0x2000]
    +   450 facebook::hermes::HermesRuntime::evaluateJavaScript()  (in DemoApp) + 8  [0x2001]
    +   ! 450 objc_msgSend  (in libobjc.A.dylib) + 4  [0x2002]
    +   150 __psynch_cvwait  (in libsystem_kernel.dylib) + 8  [0x2003]
    600 Thread_300: com.apple.uikit.eventfetch-thread
    + 600 thread_start  (in libsystem_pthread.dylib) + 8  [0x3000]
    +   600 mach_msg2_trap  (in libsystem_kernel.dylib) + 8  [0x3001]
    1 Thread_300   DispatchQueue_1878: com.facebook.react.ShadowQueue  (serial)
    + 1 _dispatch_worker_thread  (in libdispatch.dylib) + 4  [0x4000]

Total number in stack (recursive counted multiple, when >=5):
        9       thread_start  (in libsystem_pthread.dylib) + 8  [0x186388c1c]

Sort by top of stack, same collapsed (when >= 5):
        mach_msg2_trap  (in libsystem_kernel.dylib)        1000
        objc_msgSend  (in libobjc.A.dylib)        600

Binary Images:
       0x102008000 -        0x1020fffff +DemoApp (1.0.5)
`;

describe("parseSample", () => {
  it("counts every thread section, including a queue that landed on a used tid", () => {
    const s = parseSample(SAMPLE_FIXTURE);
    expect(s.unparsed).toBeUndefined();
    expect(s.totalSamples).toBe(1801);
    expect(s.threads.map((t) => t.id)).toContain("300");
    // Thread_300 appears twice with different queues; both rows survive.
    expect(s.threads.filter((t) => t.id === "300")).toHaveLength(2);
  });

  it("labels the main, JS and shadow rows by their thread/queue names", () => {
    const s = parseSample(SAMPLE_FIXTURE);
    const byRole = Object.fromEntries(s.threads.map((t) => [t.role, t]));
    expect(byRole.main.id).toBe("100");
    expect(byRole.js.id).toBe("200");
    expect(byRole.shadow.name).toContain("ShadowQueue");
    expect(byRole.js.name).toBe("com.facebook.react.runtime.JavaScript");
  });

  it("measures busy-ness by the leaf frame, not by the sample count", () => {
    const s = parseSample(SAMPLE_FIXTURE);
    // Every thread gets the same 600 wall-clock samples whether it ran or slept,
    // so a share of raw samples would call three idle threads equally hot.
    const main = s.threads.find((t) => t.role === "main")!;
    const js = s.threads.find((t) => t.role === "js")!;
    const fetch = s.threads.find((t) => t.name?.includes("eventfetch"))!;
    expect(main.busyFraction).toBeCloseTo(200 / 600, 4);
    expect(js.busyFraction).toBeCloseTo(450 / 600, 4);
    expect(fetch.busyFraction).toBe(0);
    expect(s.busySamples).toBe(651);
    expect(js.share).toBeCloseTo(450 / 651, 4);
  });

  it("reports the hottest non-blocking leaf frames per thread", () => {
    const s = parseSample(SAMPLE_FIXTURE);
    const main = s.threads.find((t) => t.role === "main")!;
    expect(main.topFrames?.[0].frame).toBe("objc_msgSend  (in libobjc.A.dylib)");
    expect(main.topFrames?.[0].share).toBeCloseTo(150 / 200, 4);
    // The offsets/addresses are dropped, including the multi-address form.
    expect(main.topFrames?.map((f) => f.frame).join(" ")).not.toContain("[0x");
    // mach_msg2_trap is where a thread waits, not where it works.
    expect(main.topFrames?.some((f) => f.frame.includes("mach_msg2_trap"))).toBe(false);
  });

  it("hands back the head of an output it does not recognise", () => {
    const s = parseSample("sample: could not attach to process 5\n");
    expect(s.threads).toHaveLength(0);
    expect(s.unparsed).toContain("could not attach");
  });
});

// Verbatim rows from `xcrun simctl spawn <udid> launchctl list` on a booted
// simulator: tab-separated PID/Status/Label, and a label that carries a hash
// suffix the bundle id has to be matched without.
const LAUNCHCTL_FIXTURE = [
  "PID\tStatus\tLabel",
  "-\t0\tcom.apple.progressd",
  "49891\t0\tUIKitApplication:com.apple.SafariViewService[ebdc][rb-legacy]",
  "50571\t0\tUIKitApplication:com.example.demo.dev[760b][rb-legacy]",
].join("\n");

describe("parseAppPid", () => {
  it("finds the pid of a UIKitApplication by bundle id", () => {
    expect(parseAppPid(LAUNCHCTL_FIXTURE, "com.example.demo.dev")).toBe(50571);
  });

  it("does not match a bundle id that is only a prefix of another", () => {
    expect(parseAppPid(LAUNCHCTL_FIXTURE, "com.example.demo")).toBeUndefined();
  });

  it("returns undefined when the app is not running", () => {
    expect(parseAppPid(LAUNCHCTL_FIXTURE, "com.nope.missing")).toBeUndefined();
  });
});
