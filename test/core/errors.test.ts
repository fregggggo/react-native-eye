import { describe, it, expect, vi } from "vitest";
import {
  UserInputError,
  ConnectionError,
  DriverError,
  RuntimeError,
  toToolError,
  driverErrorHint,
} from "../../src/core/errors.js";

describe("error classes", () => {
  it("carry their name", () => {
    expect(new UserInputError("x").name).toBe("UserInputError");
    expect(new ConnectionError("x").name).toBe("ConnectionError");
    expect(new DriverError("x").name).toBe("DriverError");
  });

  it("toToolError returns actionable text and marks isError", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = toToolError(new UserInputError("bad selector"));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("bad selector");
    expect(res.content[0].text).not.toContain("at "); // no stack frames leaked
    stderr.mockRestore();
  });

  it("toToolError logs the full stack to stderr", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    toToolError(new Error("boom"));
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });
});

describe("app failures are not connection failures", () => {
  it("does not tell the user to restart Metro when their code threw", () => {
    const out = toToolError(new RuntimeError("Error: BOOM_TEST"));
    expect(out.content[0].text).toContain("App error: Error: BOOM_TEST");
    expect(out.content[0].text).not.toMatch(/not connected|start.*metro/i);
  });

  it("still advises connecting when the link really is down", () => {
    const out = toToolError(new ConnectionError("socket closed"));
    expect(out.content[0].text).toMatch(/Not connected/);
    expect(out.content[0].text).toMatch(/connect/);
  });
});

describe("driverErrorHint — touch delivery timeout", () => {
  it("flags a timed-out iOS tap: may not have landed, don't blind-retry, use the cheap paths", () => {
    const hint = driverErrorHint("axe tap timed out after 90000ms (killed).");
    expect(hint?.replace).toBeFalsy();
    expect(hint?.hint).toMatch(/double tap/i);
    expect(hint?.hint).toMatch(/screenshot|get_layout/);
    expect(hint?.hint).toMatch(/via: "js"/);
    expect(hint?.hint).toMatch(/scroll_to/);
    expect(hint?.hint).toMatch(/open_url/);
  });

  it("flags a timed-out iOS swipe the same way", () => {
    const hint = driverErrorHint("axe swipe timed out after 90000ms (killed).");
    expect(hint?.hint).toMatch(/double tap/i);
  });

  it("flags a timed-out iOS long-press (axe touch) the same way", () => {
    const hint = driverErrorHint("axe touch timed out after 90000ms (killed).");
    expect(hint?.hint).toMatch(/double tap/i);
  });

  it("flags a timed-out Android tap delivered through the persistent shell", () => {
    const hint = driverErrorHint("adb shell `input 'tap' '5' '6'` timed out after 90000ms");
    expect(hint?.hint).toMatch(/double tap/i);
  });

  it("flags a timed-out Android swipe", () => {
    const hint = driverErrorHint("adb shell `input 'swipe' '1' '2' '3' '4' '300'` timed out after 90000ms");
    expect(hint?.hint).toMatch(/double tap/i);
  });

  it("does not flag a timed-out layout read as a touch — describe-ui is not a touch command", () => {
    expect(driverErrorHint("axe describe-ui timed out after 45000ms (killed).")).toBeUndefined();
  });

  it("does not flag a timed-out key command — hardware buttons are not the touch budget", () => {
    expect(driverErrorHint("axe button timed out after 10000ms (killed).")).toBeUndefined();
  });
});

describe("driverErrorHint — missing binary", () => {
  it("names axe and how to install it", () => {
    const hint = driverErrorHint("axe not found — is it installed and on PATH?");
    expect(hint?.replace).toBeFalsy();
    expect(hint?.hint).toContain("brew install cameroncooke/axe/axe");
  });

  it("names adb and how to install it", () => {
    const hint = driverErrorHint("adb not found — is it installed and on PATH?");
    expect(hint?.hint).toMatch(/platform-tools/i);
  });

  it("names xcrun and how to install it", () => {
    const hint = driverErrorHint("xcrun not found — is it installed and on PATH?");
    expect(hint?.hint).toContain("xcode-select --install");
  });

  it("names idb and how to install it", () => {
    const hint = driverErrorHint("idb not found — is it installed and on PATH?");
    expect(hint?.hint).toMatch(/idb-companion/i);
  });

  it("does not guess an install line for a binary it doesn't know", () => {
    expect(driverErrorHint("frobnicate not found — is it installed and on PATH?")).toBeUndefined();
  });
});

describe("driverErrorHint — no device", () => {
  it("points at open_simulator/list_devices when nothing is booted", () => {
    const hint = driverErrorHint(
      "No booted device found. Checked — ios: 1 device(s), 0 booted; android: 0 device(s), 0 booted.",
    );
    expect(hint?.hint).toMatch(/open_simulator/);
    expect(hint?.hint).toMatch(/list_devices/);
  });

  it("points at booting the device when the named one exists but isn't booted", () => {
    const hint = driverErrorHint("ios iPad (CCC) is not booted.");
    expect(hint?.hint).toMatch(/open_simulator|boot/i);
  });

  it("points at list_devices when the requested device name matches nothing", () => {
    const hint = driverErrorHint('No device matching "Pixel". Available: ios iPhone 17 Pro (ABC).');
    expect(hint?.hint).toMatch(/list_devices/);
  });

  it("points at install_app when the app isn't installed", () => {
    const hint = driverErrorHint(
      "xcrun failed: Error Domain=FBSOpenApplicationServiceErrorDomain Code=1 \"the application is not installed\"",
    );
    expect(hint?.hint).toMatch(/install_app/);
  });

  it("points at install_app when Android's monkey finds no launchable activity", () => {
    const hint = driverErrorHint(
      "adb -s SER shell `monkey -p 'com.x.app' -c android.intent.category.LAUNCHER 1` failed: No activities found to run, monkey aborted.",
    );
    expect(hint?.hint).toMatch(/install_app/);
  });

  it("points at install_app when Android's am start reports a missing activity class (D21)", () => {
    const hint = driverErrorHint("am start com.x.app/.MainActivity failed: Error: Activity class does not exist.");
    expect(hint?.hint).toMatch(/install_app/);
  });
});

describe("driverErrorHint — CLI usage dump", () => {
  it("collapses an axe usage dump to the bad argument, dropping the raw dump", () => {
    const raw =
      "axe failed: Error: The value 'undefined' is invalid for '--start-x <start-x>'\nUsage: axe swipe --start-x <start-x> --start-y <start-y> --end-x <end-x> --end-y <end-y>";
    const hint = driverErrorHint(raw);
    expect(hint?.replace).toBe(true);
    expect(hint?.hint).toContain("--start-x");
    expect(hint?.hint).not.toContain("Usage:");
    expect(hint?.hint).toMatch(/bug in (this tool|react-native-eye)/i);
    expect(hint?.hint).not.toMatch(/your input is wrong|fix your/i);
  });

  it("still collapses the dump when the specific bad argument can't be identified", () => {
    const raw = "axe failed: something unexpected\nUsage: axe tap -x <x> -y <y> --udid <udid>";
    const hint = driverErrorHint(raw);
    expect(hint?.replace).toBe(true);
    expect(hint?.hint).not.toContain("Usage:");
  });
});

describe("driverErrorHint — unrecognised", () => {
  it("returns undefined so today's text is unaffected", () => {
    expect(driverErrorHint("simctl exploded mysteriously")).toBeUndefined();
  });
});

describe("toToolError applies driver hints", () => {
  it("appends the hint after the original message for a touch timeout", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = toToolError(new DriverError("axe tap timed out after 90000ms (killed)."));
    expect(out.content[0].text).toContain("axe tap timed out after 90000ms (killed).");
    expect(out.content[0].text).toMatch(/double tap/i);
    stderr.mockRestore();
  });

  it("replaces a usage dump with the collapsed statement instead of forwarding it", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = toToolError(
      new DriverError(
        "axe failed: Error: The value 'undefined' is invalid for '--start-x <start-x>'\nUsage: axe swipe --start-x <start-x>",
      ),
    );
    expect(out.content[0].text).not.toContain("Usage:");
    expect(out.content[0].text).toContain("--start-x");
    stderr.mockRestore();
  });

  it("leaves an unrecognised driver error exactly as before", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = toToolError(new DriverError("simctl exploded mysteriously"));
    expect(out.content[0].text).toBe("Driver error: simctl exploded mysteriously");
    stderr.mockRestore();
  });
});
