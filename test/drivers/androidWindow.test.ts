import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  appWindowState,
  overlayWindowShown,
  visibleFrameOrigin,
  WINDOW_DUMP_CMD,
} from "../../src/drivers/androidWindow.js";
import { AndroidDriver } from "../../src/drivers/android.js";

// `dumpsys window displays; dumpsys window windows` from the field-test
// emulator (API 36, 1440x3120, 560 dpi) with demo-app in front: an
// edge-to-edge window (frame = whole screen), status bar and display cutout
// both 144 px high at the top, navigation bar 84 px at the bottom.
const E2E = readFileSync(
  fileURLToPath(new URL("../fixtures/dumpsys/window-edge-to-edge-api36.txt", import.meta.url)),
  "utf8",
);

const APP_FRAMES =
  "Frames: parent=[0,0][1440,3120] display=[0,0][1440,3120] frame=[0,0][1440,3120] last=[0,0][1440,3120]";

/** Rewrites the app window's Frames line (the only one of its kind for that window). */
function withAppFrames(dump: string, display: string, frame: string): string {
  const i = dump.indexOf("Window #9 Window{503740a");
  const j = dump.indexOf(APP_FRAMES, i);
  expect(j).toBeGreaterThan(i);
  return (
    dump.slice(0, j) +
    `Frames: parent=[0,0][1440,3120] display=${display} frame=${frame} last=${frame}` +
    dump.slice(j + APP_FRAMES.length)
  );
}

function setSource(dump: string, type: string, visible: boolean): string {
  return dump.replace(
    new RegExp(`(InsetsSource id=\\S+ type=${type} frame=\\S+) visible=(true|false)`, "g"),
    `$1 visible=${visible}`,
  );
}

function dropSource(dump: string, type: string): string {
  return dump
    .split("\n")
    .filter((l) => !new RegExp(`InsetsSource id=\\S+ type=${type} `).test(l))
    .join("\n");
}

describe("visibleFrameOrigin (what RN's measureInWindow subtracts)", () => {
  it("is one shell command — both dumps in one round trip", () => {
    expect(WINDOW_DUMP_CMD).toBe("dumpsys window displays; dumpsys window windows");
  });

  it("edge-to-edge, bars visible: the status bar height (field test D23: 144 px)", () => {
    expect(visibleFrameOrigin(E2E)).toEqual({ x: 0, y: 144 });
  });

  it("classic window laid out below the bar: the window's own top, no inset on top of it", () => {
    const classic = withAppFrames(E2E, "[0,144][1440,3036]", "[0,144][1440,3036]");
    expect(visibleFrameOrigin(classic)).toEqual({ x: 0, y: 144 });
  });

  it("immersive (status bar hidden) on a device with a top cutout: the cutout still insets", () => {
    expect(visibleFrameOrigin(setSource(E2E, "statusBars", false))).toEqual({ x: 0, y: 144 });
  });

  it("immersive without a cutout: origin 0", () => {
    const noCutout = dropSource(setSource(E2E, "statusBars", false), "displayCutout");
    expect(visibleFrameOrigin(noCutout)).toEqual({ x: 0, y: 0 });
  });

  it("the IME (bottom) never moves the origin", () => {
    const ime = E2E.replace(
      /InsetsSource id=3 type=ime frame=\[0,0\]\[0,0\] visible=false/,
      "InsetsSource id=3 type=ime frame=[0,1900][1440,3120] visible=true",
    );
    expect(visibleFrameOrigin(ime)).toEqual({ x: 0, y: 144 });
  });

  it("gesture and tappable-element insets are not visible insets", () => {
    // mandatorySystemGestures is 186 px at the top — counting it would give 186.
    expect(visibleFrameOrigin(E2E)!.y).not.toBe(186);
  });

  it("FLAG_LAYOUT_NO_LIMITS clears the compat insets: the window's own top", () => {
    const noLimits = E2E.replace(
      "fl=LAYOUT_IN_SCREEN LAYOUT_INSET_DECOR SPLIT_TOUCH HARDWARE_ACCELERATED DRAWS_SYSTEM_BAR_BACKGROUNDS\n      pfl=NO_MOVE_ANIMATION EDGE_TO_EDGE_ENFORCED",
      "fl=LAYOUT_IN_SCREEN LAYOUT_NO_LIMITS SPLIT_TOUCH HARDWARE_ACCELERATED DRAWS_SYSTEM_BAR_BACKGROUNDS\n      pfl=NO_MOVE_ANIMATION EDGE_TO_EDGE_ENFORCED",
    );
    expect(noLimits).not.toBe(E2E);
    expect(visibleFrameOrigin(noLimits)).toEqual({ x: 0, y: 0 });
  });

  it("a window in the bottom half of a split screen: its own top, the bar does not reach it", () => {
    const bottom = withAppFrames(E2E, "[0,1600][1440,3120]", "[0,1600][1440,3120]");
    expect(visibleFrameOrigin(bottom)).toEqual({ x: 0, y: 1600 });
  });

  it("landscape with the cutout on the left: a left inset", () => {
    const land = dropSource(E2E, "statusBars").replace(
      /InsetsSource id=27 type=displayCutout frame=\S+ visible=true flags= sideHint=TOP/,
      "InsetsSource id=27 type=displayCutout frame=[0,0][144,1440] visible=true flags= sideHint=LEFT",
    );
    const rotated = withAppFrames(land, "[0,0][3120,1440]", "[0,0][3120,1440]");
    expect(visibleFrameOrigin(rotated)).toEqual({ x: 144, y: 0 });
  });

  it("uses the focused app's window, not a popup or dialog that holds focus", () => {
    const popup = E2E.replace(
      "mCurrentFocus=Window{503740a u0 com.example.demo.dev/com.example.demo.MainActivity}",
      "mCurrentFocus=Window{2347b06 u0 PopupWindow:f36ae8b}",
    );
    expect(visibleFrameOrigin(popup)).toEqual({ x: 0, y: 144 });
  });

  it("parses the pre-API-34 source format (ITYPE_*)", () => {
    const old = E2E.replace(
      /InsetsSource id=d9f20000 type=statusBars frame=\[0,0\]\[1440,144\] visible=true flags= sideHint=TOP boundingRects=null/,
      "InsetsSource type=ITYPE_STATUS_BAR frame=[0,0][1440,144] visible=true",
    );
    const noCutout = dropSource(old, "displayCutout");
    expect(visibleFrameOrigin(noCutout)).toEqual({ x: 0, y: 144 });
  });

  it("returns undefined instead of guessing when the dump has no app window or no insets", () => {
    expect(visibleFrameOrigin("")).toBeUndefined();
    expect(visibleFrameOrigin("garbage\nmore garbage")).toBeUndefined();
    const noApp = E2E.replace(/mFocusedApp=.*\n/, "mFocusedApp=null\n").replace(/mCurrentFocus=.*\n/, "mCurrentFocus=null\n");
    expect(visibleFrameOrigin(noApp)).toBeUndefined();
  });
});

// D38. Same emulator, 2026-10-01 20:06, a real LogBox redbox on screen: the
// inspector is an android.app.Dialog, i.e. a second window of the activity
// (`ty=APPLICATION`, same ActivityRecord, frame = whole screen) above the
// `ty=BASE_APPLICATION` one. In the phantom state (JS says the inspector is
// selected, nothing but a toast on screen) that window does not exist — E2E
// above is such a dump: one base window plus the 1440x93 dev-loading popup.
const DIALOG = readFileSync(
  fileURLToPath(new URL("../fixtures/dumpsys/window-logbox-dialog-api36.txt", import.meta.url)),
  "utf8",
);

describe("overlayWindowShown (is a dialog-sized window of the app on screen)", () => {
  it("sees the LogBox dialog: a full-screen APPLICATION window of the focused activity", () => {
    expect(overlayWindowShown(DIALOG)).toBe(true);
  });

  it("says no when the activity has only its base window and a small popup", () => {
    expect(E2E).toContain("ty=APPLICATION_PANEL"); // the dev-loading banner really is in this dump
    expect(overlayWindowShown(E2E)).toBe(false);
  });

  it("ignores a dialog-sized window that has no surface (dismissed, not yet removed)", () => {
    const i = DIALOG.indexOf("Window #8 Window{9cd90dc");
    const j = DIALOG.indexOf("mHasSurface=true", i);
    expect(i).toBeGreaterThan(0);
    const gone = DIALOG.slice(0, j) + "mHasSurface=false" + DIALOG.slice(j + "mHasSurface=true".length);
    expect(overlayWindowShown(gone)).toBe(false);
  });

  it("ignores another app's windows", () => {
    const other = DIALOG.replace(
      /(Window #8 Window\{9cd90dc[\s\S]*?mActivityRecord=ActivityRecord\{)128584399 /,
      "$1deadbeef ",
    );
    expect(overlayWindowShown(other)).toBe(false);
  });

  it("is undefined, not a guess, when the dump names no focused activity or no base window", () => {
    expect(overlayWindowShown("")).toBeUndefined();
    expect(overlayWindowShown("garbage")).toBeUndefined();
    expect(overlayWindowShown(DIALOG.replace(/mFocusedApp=.*\n/, "mFocusedApp=null\n"))).toBeUndefined();
    expect(overlayWindowShown(DIALOG.replace(/ty=BASE_APPLICATION/g, "ty=APPLICATION"))).toBeUndefined();
  });

  it("appWindowState carries the origin and the flag from one dump", () => {
    expect(appWindowState(DIALOG)).toEqual({ x: 0, y: 144, overlayWindow: true });
    expect(appWindowState(E2E)).toEqual({ x: 0, y: 144, overlayWindow: false });
    expect(appWindowState("garbage")).toBeUndefined();
  });
});

describe("AndroidDriver app space", () => {
  function driverWith(dump: string | Error, density = "Physical density: 560\n") {
    const cmds: string[] = [];
    const shell = {
      exec: async (cmd: string) => {
        cmds.push(cmd);
        if (dump instanceof Error) throw dump;
        return dump;
      },
    };
    const runner = async (_cmd: string, args: string[]) => ({
      stdout: args.join(" ").includes("wm density") ? density : "",
      stderr: "",
      stdoutBuffer: Buffer.from(""),
    });
    return { driver: new AndroidDriver(runner as any, undefined, () => shell), cmds };
  }

  it("appOrigin reads the visible display frame through the persistent shell (works without the server)", async () => {
    const { driver, cmds } = driverWith(E2E);
    expect(await driver.appOrigin("SER-origin")).toEqual({ x: 0, y: 144, overlayWindow: false });
    expect(cmds).toEqual([WINDOW_DUMP_CMD]);
  });

  it("appOrigin reports the LogBox dialog window from the same single dump (D38)", async () => {
    const { driver, cmds } = driverWith(DIALOG);
    expect(await driver.appOrigin("SER-origin-dialog")).toEqual({ x: 0, y: 144, overlayWindow: true });
    expect(cmds).toEqual([WINDOW_DUMP_CMD]);
  });

  it("appOrigin is undefined, not a throw, when dumpsys fails", async () => {
    const { driver } = driverWith(new Error("adb shell died"));
    expect(await driver.appOrigin("SER-origin-2")).toBeUndefined();
  });

  it("pointScale follows an overridden density — that is the one the app lays out with", async () => {
    const { driver } = driverWith(E2E, "Physical density: 560\nOverride density: 420\n");
    expect(await driver.pointScale("SER-override")).toBeCloseTo(2.625);
  });
});
