import { describe, it, expect } from "vitest";
import { settleLayout, settleExpression } from "../../src/composite/settle.js";
import type { DeviceDriver } from "../../src/drivers/types.js";
import { AXE, axeLayout } from "../helpers/osPath.js";

function driverSeq(layouts: any[][]): DeviceDriver {
  let i = 0;
  return {
    platform: "ios",
    listDevices: async () => [],
    screenshotPng: async () => Buffer.from(""),
    rawLayout: async () => axeLayout(layouts[Math.min(i++, layouts.length - 1)]),
    tapXY: async () => AXE,
    swipe: async () => AXE,
    typeText: async () => AXE,
    pressKey: async () => AXE,
    launchApp: async () => {},
  };
}

describe("settleLayout", () => {
  it("returns once two consecutive snapshots match", async () => {
    const stable = [{ text: "A", x: 0, y: 0, w: 1, h: 1 }];
    const driver = driverSeq([[{ text: "X", x: 0, y: 0, w: 1, h: 1 }], stable, stable]);
    const sleep = async () => {};
    const els = await settleLayout(driver, "u", { intervalMs: 1, maxMs: 100, sleep });
    expect(els[0].text).toBe("A");
  });

  it("honors a fixed settle time", async () => {
    let slept = 0;
    const driver = driverSeq([[{ text: "A", x: 0, y: 0, w: 1, h: 1 }]]);
    await settleLayout(driver, "u", { fixedMs: 200, sleep: async (ms) => { slept += ms; } });
    expect(slept).toBe(200);
  });

  it("returns [] instead of throwing when layout capture fails (settle is best-effort)", async () => {
    const driver = driverSeq([]);
    driver.rawLayout = async () => {
      throw new Error("axe timed out after 15000ms");
    };
    const sleep = async () => {};
    await expect(settleLayout(driver, "u", { sleep })).resolves.toEqual([]);
    await expect(settleLayout(driver, "u", { fixedMs: 100, sleep })).resolves.toEqual([]);
  });

  it("returns the last good snapshot when a later capture fails mid-poll", async () => {
    const stable = [{ text: "A", x: 0, y: 0, w: 1, h: 1 }];
    let calls = 0;
    const driver = driverSeq([]);
    driver.rawLayout = async () => {
      calls++;
      if (calls === 1) return axeLayout(stable);
      throw new Error("axe timed out after 15000ms");
    };
    const sleep = async () => {};
    const els = await settleLayout(driver, "u", { intervalMs: 1, maxMs: 100, sleep });
    expect(els[0].text).toBe("A");
  });

  it("settleExpression waits two frames and caps at the given ms", () => {
    const expr = settleExpression(750);
    expect(expr).toContain("requestAnimationFrame");
    expect(expr).toContain("__RNE_SETTLE__");
    expect(expr).toContain("750");
  });

  it("uses the JS settle path when a conn is provided (no polling loop)", async () => {
    let evals = 0;
    const conn = { evaluate: async () => { evals++; return "settled"; } };
    const stable = [{ text: "A", x: 0, y: 0, w: 1, h: 1 }];
    let captures = 0;
    const driver = driverSeq([stable]);
    const orig = driver.rawLayout.bind(driver);
    driver.rawLayout = async (u) => {
      captures++;
      return orig(u);
    };
    const els = await settleLayout(driver, "u", { sleep: async () => {}, conn });
    // evaluate is called twice: once for the settle expression, once by the
    // fast-layout attempt inside captureLayout (whose "settled" reply fails
    // JSON.parse → OS fallback → rawLayout).
    expect(evals).toBe(2);
    expect(captures).toBe(1);
    expect(els[0].text).toBe("A");
  });

  it("falls back to diff settling when the JS settle throws", async () => {
    const conn = { evaluate: async () => { throw new Error("dead runtime"); } };
    const stable = [{ text: "A", x: 0, y: 0, w: 1, h: 1 }];
    const driver = driverSeq([stable, stable]);
    const els = await settleLayout(driver, "u", { intervalMs: 1, maxMs: 50, sleep: async () => {}, conn });
    expect(els[0].text).toBe("A");
  });
});
